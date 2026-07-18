import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HiveDatabase } from "../../../src/daemon/db";
import {
  expectedDaemonHandshake,
  parseDaemonHandshake,
} from "../../../src/daemon/handshake";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  macProcessIdentity,
  releaseDaemonLock,
  writeLifecycleFiles,
} from "../../../src/daemon/lifecycle";
import { HiveTerminalHostAdapter } from "../../../src/daemon/session-host/hive-terminal-host";
import { mintTmuxSessionLocator } from "../../../src/daemon/session-host/locators";
import { SessiondHost } from "../../../src/daemon/session-host/sessiond-host";
import type { CreateResult } from "../../../src/daemon/session-host/contract";

async function waitForBrokerSocket(
  socketPath: string,
  exited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(socketPath)).isSocket()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exited()) {
      throw new Error("sessiond exited before creating broker.sock");
    }
    await Bun.sleep(20);
  }
  throw new Error("sessiond did not create broker.sock within 10 seconds");
}

async function killExactProcess(pid: number, startToken: string): Promise<void> {
  let identity;
  try {
    identity = macProcessIdentity(pid);
  } catch {
    return;
  }
  if (identity.startToken !== startToken) return;
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (macProcessIdentity(pid).startToken !== startToken) return;
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`owned sessiond process ${pid} survived SIGKILL`);
}

test("TypeScript creates and binds a real DirectHost session", async () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  // Keep runtime/sessiond/broker.sock below macOS's AF_UNIX path limit.
  const home = await mkdtemp("/tmp/hsd.");
  await chmod(home, 0o700);
  const previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  let lockAcquired = false;
  let lifecycleWritten = false;

  try {
    await acquireDaemonLock();
    lockAcquired = true;
    const handshake = await expectedDaemonHandshake(repoRoot);
    const handshakeJson = JSON.stringify(handshake);
    expect(parseDaemonHandshake(JSON.parse(handshakeJson))).toEqual(handshake);
    const handshakeServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/handshake") {
          return new Response("not found", { status: 404 });
        }
        return new Response(handshakeJson, {
          headers: {
            "connection": "close",
            "content-length": String(Buffer.byteLength(handshakeJson)),
            "content-type": "application/json",
          },
        });
      },
    });

    try {
      writeLifecycleFiles(handshakeServer.port);
      lifecycleWritten = true;
      const daemonLock = JSON.parse(
        await readFile(join(home, "daemon.lock"), "utf8"),
      ) as Record<string, unknown>;
      const daemonIdentity = macProcessIdentity(process.pid);
      expect(daemonLock).toMatchObject({
        pid: process.pid,
        instanceId: handshake.instanceId,
        startToken: daemonIdentity.startToken,
        executablePath: daemonIdentity.executablePath,
      });
      const binary = join(repoRoot, "native/sessiond/zig-out/bin/hive-sessiond");
      const broker = Bun.spawn([binary, "serve"], {
        cwd: repoRoot,
        env: { ...process.env, HIVE_HOME: home },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      });

      try {
        await waitForBrokerSocket(
          join(home, "runtime/sessiond/broker.sock"),
          () => broker.exitCode !== null,
        );
        const db = new HiveDatabase(join(home, "hive.db"));
        let created: CreateResult | null = null;

        try {
          const host = new SessiondHost({
            repoRoot,
            hiveHome: home,
            handshake: async () => handshake,
            pendingBindings: db,
          });
          const adapter = new HiveTerminalHostAdapter(host, db, handshake.instanceId);
          const engineBuildId = await host.discoverEngineBuildId();
          const locator = {
            ...mintTmuxSessionLocator(
              handshake.instanceId,
              { kind: "agent", agentId: "agent-sessiond-live-harness" },
              1,
            ),
            hostKind: "sessiond" as const,
            engineBuildId,
          };
          const workspace = macProcessIdentity(process.pid);
          const visibility = {
            workspaceSessionId: "workspace-sessiond-live-harness",
            workspacePid: process.pid,
            workspaceStartToken: workspace.startToken,
            openTerminalRevision: "1",
          };
          const spec = {
            schemaVersion: 1 as const,
            locator,
            provider: "codex" as const,
            toolSessionId: null,
            cwd: home,
            argv: [
              "/bin/sh",
              "-c",
              "while IFS= read -r line; do :; done",
            ] as const,
            environment: { PATH: "/usr/bin:/bin" },
            expectedExecutable: "/bin/sh",
            readOnly: false,
            capabilityEpoch: 0,
            geometry: {
              columns: 80,
              rows: 24,
              widthPx: 800,
              heightPx: 480,
              cellWidthPx: 10,
              cellHeightPx: 20,
            },
            launchGrantId: "sessiond-live-harness-authorized-launch",
            launchGrantRevision: 1,
          };

          created = await adapter.create(spec, new Uint8Array(), { locator, visibility });
          expect(created.created).toBe(true);
          expect(created.locator).toEqual(locator);
          expect(created.inspection.presence).toBe("present");
          expect(created.inspection.complete).toBe(false);
          expect(created.inspection.visibility.state).toBe("attaching");
          expect(created.inspection.hostPid).not.toBe(process.pid);
          expect(created.inspection.hostPid).not.toBe(broker.pid);
          expect(created.inspection.providerRoot?.pid).not.toBe(process.pid);
          expect(created.inspection.providerRoot?.pid).not.toBe(broker.pid);
          expect(created.inspection.providerRoot?.pid)
            .not.toBe(created.inspection.hostPid);

          const hostPid = created.inspection.hostPid;
          const hostStartToken = created.inspection.hostStartToken;
          const providerRoot = created.inspection.providerRoot;
          if (hostPid === null || hostStartToken === null || providerRoot === null) {
            throw new Error("CREATED omitted measured host or provider identity");
          }
          expect(macProcessIdentity(hostPid).startToken).toBe(hostStartToken);
          expect(macProcessIdentity(providerRoot.pid).startToken)
            .toBe(providerRoot.startToken);

          const binding = {
            locator,
            visibility,
            createEvidence: {
              expectedExecutable: spec.expectedExecutable,
              executableVerified: created.inspection.executableVerified,
              verifiedProviderRoot: created.inspection.providerRoot,
              geometry: spec.geometry,
              visibility: created.inspection.visibility,
            },
          };
          expect(db.getTerminalHostBindingByLocator(locator)).toEqual(binding);
          expect(db.listTerminalHostBindings(handshake.instanceId)).toEqual([binding]);
          expect(db.database.query(`
            SELECT locatorInstanceId, locatorSessionId, locatorGeneration
            FROM terminal_host_bindings
          `).all()).toEqual([{
            locatorInstanceId: locator.instanceId,
            locatorSessionId: locator.sessionId,
            locatorGeneration: locator.generation,
          }]);

          const neutralMatches = (await host.list()).filter(
            (inspection) => inspection.session.key === locator.sessionId,
          );
          expect(neutralMatches).toHaveLength(1);
          const neutralSession = neutralMatches[0]!.session;
          expect(neutralSession.incarnation).not.toBe(String(locator.generation));
          const neutralReadback = await host.inspect(neutralSession);
          expect(neutralReadback.session).toEqual(neutralSession);
          expect(neutralReadback.lifecycle).toBe("running");

          const readback = await adapter.inspect(locator);
          expect(readback.locator).toEqual(locator);
          expect(readback.presence).toBe("present");
          expect(readback.hostPid).toBe(hostPid);
          expect(readback.providerRoot?.pid).toBe(providerRoot.pid);
          expect(readback.expectedExecutable).toBe(spec.expectedExecutable);
          expect(readback.complete).toBe(false);
          expect(readback.diagnosticIds).toContain(
            "SESSIOND_VIEWER_COUNT_UNAVAILABLE",
          );
          expect(readback.diagnosticIds).toContain(
            "SESSIOND_RESOURCES_UNAVAILABLE",
          );
        } finally {
          if (created?.inspection.providerRoot !== null &&
              created?.inspection.providerRoot !== undefined) {
            await killExactProcess(
              created.inspection.providerRoot.pid,
              created.inspection.providerRoot.startToken,
            );
          }
          if (created?.inspection.hostPid !== null &&
              created?.inspection.hostPid !== undefined &&
              created.inspection.hostStartToken !== null) {
            await killExactProcess(
              created.inspection.hostPid,
              created.inspection.hostStartToken,
            );
          }
          db.close();
        }
      } finally {
        if (broker.exitCode === null) broker.kill(15);
        const exited = await Promise.race([
          broker.exited.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        if (!exited && broker.exitCode === null) broker.kill(9);
        await broker.exited;
      }
    } finally {
      handshakeServer.stop(true);
    }
  } finally {
    try {
      if (lifecycleWritten) cleanupLifecycleFiles();
      else if (lockAcquired && !releaseDaemonLock()) {
        throw new Error("could not release live-harness daemon lock");
      }
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}, 30_000);
