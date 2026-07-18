import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
} from "../../../src/daemon/session-host/hive-terminal-host";
import { SessiondHost } from "../../../src/daemon/session-host/sessiond-host";
import { HiveSpawner } from "../../../src/daemon/spawner-impl";
import { stopSessiondAgentSession } from "../../../src/daemon/teardown";
import {
  known,
  unknown,
  type AgentRecord,
  type CapabilityRecord,
  type RoutingPolicy,
} from "../../../src/schemas";

class FakeTmux {
  readonly sessions: Array<[string, string, string]> = [];
  readonly active = new Set<string>();

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.sessions.push([name, cwd, command]);
    this.active.add(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.active.has(name);
  }

  async capturePane(): Promise<string> {
    return "";
  }

  async paneState(): Promise<{
    columns: number;
    rows: number;
    cursorColumn: number;
    cursorRow: number;
    cursorVisible: boolean;
  }> {
    return {
      columns: 80,
      rows: 24,
      cursorColumn: 0,
      cursorRow: 0,
      cursorVisible: false,
    };
  }

  async listPanePids(): Promise<number[]> {
    return [];
  }

  async killSession(name: string): Promise<void> {
    this.active.delete(name);
  }
}

const observedAt = "2026-07-18T12:00:00.000Z";

function codexCapability(): CapabilityRecord {
  return {
    provider: "codex",
    accountFingerprint: "sessiond-live-harness",
    cliVersion: "test",
    canonicalId: "gpt-sessiond-live",
    variant: null,
    launchToken: "gpt-sessiond-live",
    displayName: null,
    aliases: [],
    entitled: known(true, "codex.model/list", observedAt),
    hidden: unknown("surface-silent", "codex.model/list", observedAt),
    supportsEffort: unknown("surface-silent", "codex.model/list", observedAt),
    supportedEffortLevels: known(["medium"], "codex.model/list", observedAt),
    defaultEffort: known("medium", "codex.model/list", observedAt),
    observedAt,
  };
}

function codexRoutingPolicy(): RoutingPolicy {
  return {
    schemaVersion: 2,
    revision: 1,
    updatedAt: observedAt,
    provisional: false,
    providers: { codex: "enabled" },
    models: [{
      provider: "codex",
      model: "gpt-sessiond-live",
      state: "enabled",
      effort: { mode: "exact", value: "medium" },
    }],
    chains: {
      default: [{
        provider: "codex",
        model: "gpt-sessiond-live",
        effort: { mode: "exact", value: "medium" },
      }],
    },
    selection: { global: "choice", categories: {} },
  };
}

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

test("TypeScript opts one agent into a real DirectHost while tmux remains default", async () => {
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
        let spawnedHost: { pid: number; startToken: string } | null = null;
        let spawnedProvider: { pid: number; startToken: string } | null = null;

        try {
          const host = new SessiondHost({
            repoRoot,
            hiveHome: home,
            handshake: async () => handshake,
            pendingBindings: db,
          });
          const adapter = new HiveTerminalHostAdapter(host, db, handshake.instanceId);
          const engineBuildId = await host.discoverEngineBuildId();
          const workspace = macProcessIdentity(process.pid);
          const visibility = {
            workspaceSessionId: "workspace-sessiond-live-harness",
            workspacePid: process.pid,
            workspaceStartToken: workspace.startToken,
            openTerminalRevision: "1",
          };

          const tmux = new FakeTmux();
          const stopSpawnedSession = async (agent: AgentRecord) => {
            if (agent.sessionLocator?.hostKind === "sessiond") {
              return await stopSessiondAgentSession(agent, {
                terminalHost: adapter,
                readHostPid: async (record) =>
                  (await adapter.inspect(requireSessiondAgentLocator(record))).hostPid,
              });
            }
            await tmux.killSession(agent.tmuxSession);
            return { killed: [], survivors: [] };
          };
          const spawner = new HiveSpawner({
            db,
            repoRoot,
            port: handshakeServer.port,
            config: { codex: { driver: "app-server" } },
            readRoutingPolicy: codexRoutingPolicy,
            discoverCapabilities: async () => ({
              status: "ok",
              records: [codexCapability()],
              effectiveDefault: {
                provider: "codex",
                model: known(
                  "gpt-sessiond-live",
                  "codex.model/list",
                  observedAt,
                ),
                effort: known("medium", "codex.model/list", observedAt),
              },
            }),
            isModelEnabled: async () => true,
            tmux,
            sessiond: {
              terminalHost: adapter,
              admit: async ({ agentName }) =>
                agentName === "maya"
                  ? { engineBuildId, visibility }
                  : null,
            },
            stopSession: stopSpawnedSession,
            createWorktree: async (_root, name, slug) => {
              const path = join(home, `worktree-${name}`);
              await mkdir(path, { recursive: true });
              return { path, branch: `hive/${name}-${slug}` };
            },
            removeWorktree: async () => {},
            unavailableAgentNames: async () => new Set(),
            listCodexMcpServers: async () => [],
            readCodexActivity: async () => null,
            sleep: async () => {
              for (const agent of db.listAgents()) {
                if (agent.status === "spawning") {
                  db.insertAgent({ ...agent, status: "working" });
                }
              }
            },
            codexAppServer: {
              isAvailable: async () => true,
              buildHostCommand: () => [
                "/bin/sh",
                "-c",
                `test "$HIVE_HOME" = ${JSON.stringify(home)} && ` +
                "while IFS= read -r line; do :; done",
              ],
              startAgent: async () => {},
              disconnect: () => undefined,
            },
          });

          const sessiondAgent = await spawner.spawn({
            task: "Exercise the admitted sessiond backend",
            category: "complex_coding",
            name: "maya",
            tool: "codex",
            model: "gpt-sessiond-live",
          });
          expect(sessiondAgent.sessionLocator?.hostKind).toBe("sessiond");
          expect(sessiondAgent.status).toBe("working");
          const sessiondLocator = requireSessiondAgentLocator(sessiondAgent);
          const sessiondBinding = db.getTerminalHostBindingByLocator(
            sessiondLocator,
          );
          expect(sessiondBinding?.locator).toEqual(sessiondLocator);
          expect(sessiondBinding?.visibility).toEqual(visibility);
          expect(sessiondBinding?.createEvidence).toBeDefined();
          expect(db.listTerminalHostBindings(handshake.instanceId)).toEqual([
            sessiondBinding,
          ]);
          expect(db.database.query(`
            SELECT locatorInstanceId, locatorSessionId, locatorGeneration
            FROM terminal_host_bindings
          `).all()).toEqual([{
            locatorInstanceId: sessiondLocator.instanceId,
            locatorSessionId: sessiondLocator.sessionId,
            locatorGeneration: sessiondLocator.generation,
          }]);

          const sessiondInspection = await adapter.inspect(sessiondLocator);
          expect(sessiondInspection.presence).toBe("present");
          expect(sessiondInspection.complete).toBe(false);
          expect(sessiondInspection.visibility.state).toBe("attaching");
          expect(sessiondInspection.hostPid).not.toBeNull();
          expect(sessiondInspection.hostStartToken).not.toBeNull();
          expect(sessiondInspection.providerRoot).not.toBeNull();
          if (
            sessiondInspection.hostPid === null ||
            sessiondInspection.hostStartToken === null ||
            sessiondInspection.providerRoot === null
          ) {
            throw new Error("sessiond spawner omitted measured process identity");
          }
          spawnedHost = {
            pid: sessiondInspection.hostPid,
            startToken: sessiondInspection.hostStartToken,
          };
          spawnedProvider = sessiondInspection.providerRoot;
          expect(spawnedHost.pid).not.toBe(process.pid);
          expect(spawnedHost.pid).not.toBe(broker.pid);
          expect(spawnedProvider.pid).not.toBe(process.pid);
          expect(spawnedProvider.pid).not.toBe(broker.pid);
          expect(spawnedProvider.pid).not.toBe(spawnedHost.pid);
          expect(macProcessIdentity(spawnedHost.pid).startToken)
            .toBe(spawnedHost.startToken);
          expect(macProcessIdentity(spawnedProvider.pid).startToken)
            .toBe(spawnedProvider.startToken);
          expect(sessiondInspection.expectedExecutable)
            .toBe(sessiondBinding?.createEvidence?.expectedExecutable);
          expect(sessiondInspection.diagnosticIds).toContain(
            "SESSIOND_VIEWER_COUNT_UNAVAILABLE",
          );
          expect(sessiondInspection.diagnosticIds).toContain(
            "SESSIOND_RESOURCES_UNAVAILABLE",
          );

          const neutralMatches = (await host.list()).filter(
            (inspection) => inspection.session.key === sessiondLocator.sessionId,
          );
          expect(neutralMatches).toHaveLength(1);
          const neutralSession = neutralMatches[0]!.session;
          expect(neutralSession.incarnation)
            .not.toBe(String(sessiondLocator.generation));
          const neutralReadback = await host.inspect(neutralSession);
          expect(neutralReadback.session).toEqual(neutralSession);
          expect(neutralReadback.lifecycle).toBe("running");

          const tmuxAgent = await spawner.spawn({
            task: "Exercise the default tmux backend",
            category: "complex_coding",
            name: "theo",
            tool: "codex",
            model: "gpt-sessiond-live",
          });
          expect(tmuxAgent.sessionLocator?.hostKind).toBe("tmux");
          expect(tmux.sessions).toHaveLength(1);
          expect(
            db.listAgents().filter(
              (agent) => agent.sessionLocator?.hostKind === "sessiond",
            ),
          ).toHaveLength(1);

          const stopped = await stopSpawnedSession(sessiondAgent);
          expect(stopped.survivors).toEqual([]);
          const terminated = await adapter.inspect(sessiondLocator);
          expect(terminated.presence).not.toBe("present");
          expect(
            db.getTerminalHostBindingByLocator(sessiondLocator)?.terminationAudit,
          ).toMatchObject({ reason: `stop agent ${sessiondAgent.id}` });
        } finally {
          if (spawnedProvider !== null) {
            await killExactProcess(
              spawnedProvider.pid,
              spawnedProvider.startToken,
            );
          }
          if (spawnedHost !== null) {
            await killExactProcess(spawnedHost.pid, spawnedHost.startToken);
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
