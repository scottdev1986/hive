import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HiveDatabase } from "../../../src/daemon/db";
import { stopHive } from "../../../src/cli/control";
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
import {
  SessiondHost,
  SessiondWireError,
} from "../../../src/daemon/session-host/sessiond-host";
import { WorkspaceVisibilityAuthority } from "../../../src/daemon/session-host/workspace-visibility";
import { HiveSpawner } from "../../../src/daemon/spawner-impl";
import { stopSessiondAgentSession } from "../../../src/daemon/teardown";
import { SessiondViewerAgentInput } from "../../../src/daemon/session-host/sessiond-agent-input";
import { SessiondViewerAttachClient } from "../../../src/daemon/session-host/sessiond-viewer-attach";
import {
  known,
  unknown,
  type AgentRecord,
  type CapabilityRecord,
  type RoutingPolicy,
} from "../../../src/schemas";

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

async function waitForExactProcessAbsence(
  pid: number,
  startToken: string,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (macProcessIdentity(pid).startToken !== startToken) return;
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`owned sessiond process ${pid} outlived visibility expiry`);
}

test.skip(
  "legacy tmux spawner backend is dead after #112; deletion belongs to #1/#2",
  () => {
    // #112 deliberately unwires this runtime lane. #1/#2 own replacement or
    // deletion under the zero-living-references acceptance.
  },
);

test("TypeScript gates a real DirectHost, clean stop, and publisher-death expiry", async () => {
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
    const handshakePort = handshakeServer.port;
    if (handshakePort === undefined) {
      throw new Error("handshake server did not bind a port");
    }

    try {
      writeLifecycleFiles(handshakePort);
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
        const workspacePublisher = Bun.spawn(["/bin/sleep", "60"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        const workspace = macProcessIdentity(workspacePublisher.pid);

        try {
          const host = new SessiondHost({
            repoRoot,
            hiveHome: home,
            handshake: async () => handshake,
            pendingBindings: db,
          });
          const adapter = new HiveTerminalHostAdapter(host, db, handshake.instanceId);
          const engineBuildId = await host.discoverEngineBuildId();
          const visibility = {
            workspaceSessionId: "workspace-sessiond-live-harness",
            workspacePid: workspacePublisher.pid,
            workspaceStartToken: workspace.startToken,
            openTerminalRevision: "1",
          };
          const visibilityAuthority = () => new WorkspaceVisibilityAuthority({
              expectedInstanceId: handshake.instanceId,
              observeProcess: (pid) => {
                try {
                  return macProcessIdentity(pid);
                } catch {
                  return null;
                }
              },
              discoverEngineBuildId: () => host.discoverEngineBuildId(),
            });
          let workspaceVisibility = visibilityAuthority();
          let admittedAgentName = "maya";
          let admittedVisibility = visibility;
          const publishEmptyWorkspace = () => {
            expect(workspaceVisibility.publish({
              schemaVersion: 1,
              source: {
                sessionId: admittedVisibility.workspaceSessionId,
                process: {
                  processId: admittedVisibility.workspacePid,
                  startToken: admittedVisibility.workspaceStartToken,
                },
              },
              inventoryRevision: admittedVisibility.openTerminalRevision,
              terminals: [],
            })).toMatchObject({ state: "accepted" });
          };
          publishEmptyWorkspace();

          const stopSpawnedSession = async (agent: AgentRecord) => {
            if (agent.sessionLocator?.hostKind === "sessiond") {
              return await stopSessiondAgentSession(agent, {
                terminalHost: adapter,
                readHostPid: async (record) =>
                  (await adapter.inspect(requireSessiondAgentLocator(record))).hostPid,
              });
            }
            throw new Error("legacy tmux teardown is not part of the sessiond harness");
          };
          const spawner = new HiveSpawner({
            db,
            repoRoot,
            port: handshakePort,
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
            sessiond: {
              terminalHost: adapter,
              prepareAgentCreation: (candidate) =>
                candidate.agentName === admittedAgentName
                ? workspaceVisibility.prepareAgentCreation()
                : Promise.resolve(null),
              admit: (candidate) => workspaceVisibility.admit(candidate),
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
                  if (agent.sessionLocator?.hostKind === "sessiond") {
                    const locator = requireSessiondAgentLocator(agent);
                    if (
                      !workspaceVisibility.currentSnapshot()?.terminals.some(
                        (terminal) => terminal.agentId === agent.id,
                      )
                    ) {
                      expect(workspaceVisibility.publish({
                        schemaVersion: 1,
                        source: {
                          sessionId: admittedVisibility.workspaceSessionId,
                          process: {
                            processId: admittedVisibility.workspacePid,
                            startToken: admittedVisibility.workspaceStartToken,
                          },
                        },
                        inventoryRevision: `${
                          BigInt(admittedVisibility.openTerminalRevision) + 1n
                        }`,
                        terminals: [{
                          agentId: agent.id,
                          agentName: agent.name,
                          locator,
                          state: "pending",
                        }],
                      })).toEqual({
                        state: "accepted",
                        inventoryRevision: `${
                          BigInt(admittedVisibility.openTerminalRevision) + 1n
                        }`,
                      });
                    }
                  }
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
          if (!sessiondBinding?.createEvidence) {
            throw new Error("sessiond spawner omitted terminal binding evidence");
          }
          expect(sessiondBinding.locator).toEqual(sessiondLocator);
          expect(sessiondBinding.visibility).toEqual(visibility);
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
            .toBe(sessiondBinding.createEvidence.expectedExecutable);
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

          const wrongToken = adapter.renewVisibility(sessiondLocator, {
            ...visibility,
            workspaceStartToken: "0:0",
            openTerminalRevision: "2",
          }).catch((error) => error);
          await expect(wrongToken).resolves.toBeInstanceOf(SessiondWireError);
          await expect(wrongToken).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
          expect(db.getTerminalHostBindingByLocator(sessiondLocator)?.visibility)
            .toEqual(visibility);

          const stale = adapter.renewVisibility(sessiondLocator, {
            ...visibility,
            openTerminalRevision: "0",
          }).catch((error) => error);
          await expect(stale).resolves.toBeInstanceOf(SessiondWireError);
          await expect(stale).resolves.toMatchObject({ code: "GENERATION_MISMATCH" });
          expect(db.getTerminalHostBindingByLocator(sessiondLocator)?.visibility)
            .toEqual(visibility);

          const renewedVisibility = {
            ...visibility,
            openTerminalRevision: "2",
          };
          const renewed = await adapter.renewVisibility(
            sessiondLocator,
            renewedVisibility,
          );
          expect(renewed).toMatchObject({
            locator: sessiondLocator,
            state: "active",
            openTerminalRevision: "2",
          });
          expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
          expect(db.getTerminalHostBindingByLocator(sessiondLocator)).toMatchObject({
            visibility: renewedVisibility,
            createEvidence: {
              visibility: {
                state: "visible",
                openTerminalRevision: "2",
                expiresAt: renewed.expiresAt,
              },
            },
          });
          expect((await adapter.inspect(sessiondLocator)).visibility).toEqual({
            state: "visible",
            workspaceSessionId: visibility.workspaceSessionId,
            openTerminalRevision: "2",
            expiresAt: renewed.expiresAt,
          });

          // #68 real-engine inject: the daemon-side injector performs the
          // actual viewer wire against the real spawned host — grant →
          // HELLO(viewer) → HOST_ATTACH → CLAIM_ACQUIRE(automation) →
          // INPUT_SUBMIT — and must come back with a real receipt. This is
          // the discriminator the 2026-07-20 live proof lacked: green here
          // means the wire works against the engine, so a live-instance
          // stall is environmental and now names itself on the message row.
          const injector = new SessiondViewerAgentInput(
            host,
            `hive-daemon:${handshake.instanceId}`,
          );

          // #85 real-engine orphan discard: acquire a human claim on an
          // attached viewer, then drop the viewer without CLAIM_RELEASE. The
          // compiled host must accept INPUT_ORPHAN_DISCARD and return the
          // matching ORPHAN_DISCARDED response through the shared decoder.
          const orphanViewerId = "sessiond-live-orphan";
          const orphanGrant = await host.issueAttach(sessiondLocator, {
            viewerId: orphanViewerId,
            geometry: sessiondInspection.geometry,
            operations: ["view", "human-input"],
          });
          const orphanViewer = await SessiondViewerAttachClient.attach({
            locator: sessiondLocator,
            grant: orphanGrant,
            geometry: sessiondInspection.geometry,
            viewerId: orphanViewerId,
          });
          await (orphanViewer as unknown as {
            request(
              requestType: "CLAIM_ACQUIRE",
              responseType: "CLAIM_RESULT",
              flags: number,
              payload: unknown,
            ): Promise<unknown>;
          }).request("CLAIM_ACQUIRE", "CLAIM_RESULT", 0, {
            schemaVersion: 1,
            session: {
              key: sessiondLocator.sessionId,
              incarnation: String(sessiondLocator.generation),
            },
            writer: orphanViewerId,
            kind: "human",
            leaseMilliseconds: 60_000,
            idempotencyKey: "sessiond-live-orphan-claim",
          });
          orphanViewer.close();

          let orphanDecline = "";
          const orphanDeadline = Date.now() + 5_000;
          while (Date.now() < orphanDeadline) {
            const declined = await injector.injectIdle(
              sessiondAgent,
              "LIVE-PROOF #85: orphan blocks automation",
              { messageId: "msg-85-orphan-blocked" },
            );
            if (declined.outcome === "declined") orphanDecline = declined.reason;
            if (orphanDecline.includes("HumanOrphaned")) break;
            await Bun.sleep(20);
          }
          expect(orphanDecline).toContain("HumanOrphaned");
          // The viewer dropped without CLAIM_RELEASE, so the draft is abandoned
          // rather than held: `orphaned` is the non-destructive resolution.
          const discarded = await host.discardInputOrphan(sessiondLocator, "orphaned");
          // The result is a discriminated state, not a boolean: asserting
          // `discarded` specifically is what keeps a destructive `preempted`
          // from reading as an ordinary orphan discard.
          expect(discarded).toMatchObject({
            state: "discarded",
            priorOwnerViewerId: orphanViewerId,
          });
          expect(discarded.priorClaimId).not.toBeNull();

          const injected = await injector.injectIdle(
            sessiondAgent,
            "LIVE-PROOF #68: real-engine inject",
            { messageId: "msg-68-live-proof" },
          );
          if (injected.outcome !== "injected") {
            throw new Error(
              `real-engine inject declined: ${injected.reason}`,
            );
          }
          expect(["accepted", "queued", "written-to-terminal"])
            .toContain(injected.receipt.stage);
          expect(injected.receipt.transactionId).toBe("msg-68-live-proof");

          expect(
            db.listAgents().filter(
              (agent) => agent.sessionLocator?.hostKind === "sessiond",
            ),
          ).toHaveLength(1);

          // #70 moved the sessiond fan-out from stopHive into the daemon's
          // POST /stop. This harness has no daemon, so the injected transport
          // performs the same teardown the daemon's commit path would — the
          // live proof (real host process absence, termination audit) is
          // unchanged.
          const stopped = { survivors: null as readonly unknown[] | null };
          const daemonStates: Array<"live" | "dead"> = ["live", "dead"];
          await stopHive({
            readPid: () => process.pid,
            liveness: async () => daemonStates.shift() ?? "dead",
            cleanup: () => {},
            sleep: async () => {},
            log: () => {},
            invoker: {
              pid: process.pid,
              ppid: process.ppid,
              argv: [],
              cwd: home,
              chain: [],
              agentWorktree: false,
            },
            requestStop: async () => {
              const teardown = await stopSpawnedSession(sessiondAgent);
              stopped.survivors = teardown.survivors;
              expect(stopped.survivors).toEqual([]);
              return { state: "stopping", killed: [sessiondAgent.name] };
            },
          });
          if (stopped.survivors === null) {
            throw new Error("sessiond teardown did not run");
          }
          expect(stopped.survivors).toEqual([]);
          expect(db.getTerminalHostBindingByLocator(sessiondLocator)?.terminationAudit)
            .toMatchObject({ reason: `stop agent ${sessiondAgent.id}` });
          await Promise.all([
            waitForExactProcessAbsence(spawnedHost.pid, spawnedHost.startToken),
            waitForExactProcessAbsence(spawnedProvider.pid, spawnedProvider.startToken),
          ]);
          expect((await adapter.inspect(sessiondLocator)).presence)
            .not.toBe("present");
          spawnedHost = null;
          spawnedProvider = null;

          admittedAgentName = "lena";
          admittedVisibility = {
            ...visibility,
            openTerminalRevision: "3",
          };
          workspaceVisibility = visibilityAuthority();
          publishEmptyWorkspace();
          const expiryAgent = await spawner.spawn({
            task: "Exercise publisher-death lease expiry",
            category: "complex_coding",
            name: "lena",
            tool: "codex",
            model: "gpt-sessiond-live",
          });
          const expiryLocator = requireSessiondAgentLocator(expiryAgent);
          const expiryInspection = await adapter.inspect(expiryLocator);
          if (
            expiryInspection.hostPid === null ||
            expiryInspection.hostStartToken === null ||
            expiryInspection.providerRoot === null
          ) {
            throw new Error("publisher-death session omitted measured process identity");
          }
          spawnedHost = {
            pid: expiryInspection.hostPid,
            startToken: expiryInspection.hostStartToken,
          };
          spawnedProvider = expiryInspection.providerRoot;
          expect(macProcessIdentity(spawnedHost.pid).startToken)
            .toBe(spawnedHost.startToken);
          expect(macProcessIdentity(spawnedProvider.pid).startToken)
            .toBe(spawnedProvider.startToken);

          process.kill(workspacePublisher.pid, "SIGKILL");
          await workspacePublisher.exited;
          await Promise.all([
            waitForExactProcessAbsence(spawnedHost.pid, spawnedHost.startToken),
            waitForExactProcessAbsence(spawnedProvider.pid, spawnedProvider.startToken),
          ]);
          const expired = await adapter.inspect(expiryLocator);
          expect(expired.presence).not.toBe("present");
          expect(expired.visibility.state).toBe("expired");
        } finally {
          await killExactProcess(workspacePublisher.pid, workspace.startToken)
            .catch(() => undefined);
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
}, 45_000);
