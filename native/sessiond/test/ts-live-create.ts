import { expect, test } from "bun:test";
import { TERMINAL_SHELL } from "../../../src/daemon/session-host/shell-session";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultComposerPlaceholder } from "../../../src/cli/agent-ui/presentation";
import { stopHive } from "../../../src/cli/control";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  expectedDaemonHandshake,
  macProcessIdentity,
  parseDaemonHandshake,
  releaseDaemonLock,
  writeLifecycleFiles,
} from "../../../src/daemon/lifecycle/daemon-lifecycle";
import { stopSessiondAgentSession } from "../../../src/daemon/resource-management/teardown";
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
} from "../../../src/daemon/session-host/hive-terminal-host";
import { SessiondHost } from "../../../src/daemon/session-host/sessiond-host";
import { SessiondViewerAttachClient } from "../../../src/daemon/session-host/sessiond-viewer-attach";
import { WorkspaceVisibilityAuthority } from "../../../src/daemon/session-host/workspace-visibility";
import { HiveSpawner } from "../../../src/daemon/spawn/spawner-impl";
import type { AgentRecord } from "../../../src/schemas/agent";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../../../src/schemas/capability";
import type { RoutingPolicy } from "../../../src/schemas/routing-policy";
import {
  FRAME_FLAGS,
  TERMINAL_LIMITS,
} from "../../../src/schemas/session-protocol";
import type { JsonObject, JsonValue } from "../../../src/shared/json";
import { unsafeCast } from "../../../src/shared/unsafe-cast";

const observedAt = "2026-07-18T12:00:00.000Z";

const paneIdentity = (agentName: string) => ({
  agentName,
  vendorName: "Codex",
  vendorId: "codex",
  model: "gpt-sessiond-live",
});

/**
 * One composer frame from the product's own formatter. The probe is checked
 * against this so it cannot quietly stop matching what `hive agent-ui`
 * actually paints.
 */
function renderedFrontendFrame(agentName: string): string {
  return defaultComposerPlaceholder(paneIdentity(agentName));
}

/**
 * The launch command names the provider, but only the interactive frontend
 * paints its composer prompt after terminal input is in raw mode.
 */
function paneComposerPainted(
  text: string | null | undefined,
  agentName: string,
): boolean {
  return (
    text?.includes(defaultComposerPlaceholder(paneIdentity(agentName))) === true
  );
}

/** What the shell shows before the frontend draws — the probe must not fire on it. */
const launchCommandLine = (agentName: string) =>
  `/opt/hive agent-ui --subject ${agentName} --provider codex --executable /usr/local/bin/codex`;

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
    schemaVersion: 3,
    revision: 1,
    updatedAt: observedAt,
    provisional: false,
    providers: { codex: "enabled" },
    models: [
      {
        provider: "codex",
        model: "gpt-sessiond-live",
        state: "enabled",
        effort: { mode: "exact", value: "medium" },
      },
    ],
    global: {
      mode: "user-weighted",
      candidates: [
        {
          provider: "codex",
          model: "gpt-sessiond-live",
          effort: { mode: "exact", value: "medium" },
          weight: 1,
        },
      ],
    },
    categories: {},
  };
}

async function killExactProcess(
  pid: number,
  startToken: string,
): Promise<void> {
  let identity: ReturnType<typeof macProcessIdentity>;
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

test("TypeScript gates a real DirectHost, clean stop, and publisher-death survival", async () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  // Use the controlled root directly, both as the home and as sessiond's
  // runtime root. The root is the one path the sandbox permits writes to, and
  // it is short enough that the per-session host socket named under it stays
  // inside macOS's AF_UNIX limit; nesting another temporary directory would
  // push it past.
  const home = process.env.HIVE_TEST_ROOT;
  if (home === undefined) {
    throw new Error("the live sessiond test requires HIVE_TEST_ROOT");
  }
  await chmod(home, 0o700);
  const providerExecutable = join(home, "codex-test-provider");
  const providerFixture = join(import.meta.dir, "codex-app-server-fixture.ts");
  await writeFile(
    providerExecutable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(providerFixture)} "$@"\n`,
    { mode: 0o700 },
  );
  const previousHome = process.env.HIVE_HOME;
  const previousSessiondRoot = process.env.HIVE_SESSIOND_ROOT;
  process.env.HIVE_HOME = home;
  process.env.HIVE_SESSIOND_ROOT = home;
  let lockAcquired = false;
  let lifecycleWritten = false;
  let lockReleaseFailed = false;

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
        const pathname = new URL(request.url).pathname;
        // The pane reports its provider child before its first draw. Accept the
        // report so this terminal test can reach the visible readiness proof.
        if (pathname === "/provider-runtime" && request.method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (pathname !== "/handshake") {
          return new Response("not found", { status: 404 });
        }
        return new Response(handshakeJson, {
          headers: {
            connection: "close",
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
      // SAFETY: The test owns this value and its fields.
      const daemonLock = JSON.parse(
        await readFile(join(home, "daemon.lock"), "utf8"),
      ) as JsonObject;
      const daemonIdentity = macProcessIdentity(process.pid);
      expect(daemonLock).toMatchObject({
        pid: process.pid,
        instanceId: handshake.instanceId,
        startToken: daemonIdentity.startToken,
        executablePath: daemonIdentity.executablePath,
      });
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
          handshake: async () => {
            void handshake;
          },
          pendingBindings: db,
        });
        const adapter = new HiveTerminalHostAdapter(
          host,
          db,
          handshake.instanceId,
          { providerRuns: db },
        );
        const _engineBuildId = await host.discoverEngineBuildId();
        const visibility = {
          workspaceSessionId: "workspace-sessiond-live-harness",
          workspacePid: workspacePublisher.pid,
          workspaceStartToken: workspace.startToken,
          openTerminalRevision: "1",
        };
        const visibilityAuthority = () =>
          new WorkspaceVisibilityAuthority({
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
        let admittedVisibility = visibility;
        const registerAndPublishEmptyWorkspace = () => {
          expect(
            workspaceVisibility.register({
              sessionId: admittedVisibility.workspaceSessionId,
              process: {
                processId: admittedVisibility.workspacePid,
                startToken: admittedVisibility.workspaceStartToken,
              },
            }),
          ).toMatchObject({ state: "accepted" });
          expect(
            workspaceVisibility.publish({
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
            }),
          ).toMatchObject({ state: "accepted" });
        };
        registerAndPublishEmptyWorkspace();

        const stopSpawnedSession = async (agent: AgentRecord) => {
          return await stopSessiondAgentSession(agent, {
            terminalHost: adapter,
            readHostPid: async (record) =>
              (await adapter.inspect(requireSessiondAgentLocator(record)))
                .hostPid,
          });
        };
        let resolveAgentWorking!: () => void;
        const nextAgentWorking = () =>
          new Promise<void>((resolve) => {
            resolveAgentWorking = resolve;
          });
        let agentWorking = nextAgentWorking();
        const spawner = new HiveSpawner({
          db,
          repoRoot,
          port: handshakePort,
          config: {},
          readRoutingPolicy: codexRoutingPolicy,
          discoverCapabilities: async () => ({
            status: "ok",
            records: [codexCapability()],
            effectiveDefault: {
              provider: "codex",
              model: known("gpt-sessiond-live", "codex.model/list", observedAt),
              effort: known("medium", "codex.model/list", observedAt),
            },
          }),
          isModelEnabled: async () => true,
          // Ghostty owns pane PTYs in production: the spawner only writes a launch spec. This live gate rebuilds the sessiond create from that spec — the same zsh login shell and HIVE_AGENT_UI_COMMAND contract the DirectHost enforces — so create, attach, input, capture, and teardown stay proven against the real engine.
          writeTerminalLaunchSpec: async (locator, launch, context) => {
            const lease = await workspaceVisibility.prepareAgentCreation();
            if (lease === null) {
              throw new Error("live create bridge has no visibility lease");
            }
            // The ZDOTDIR hook that execed HIVE_AGENT_UI_COMMAND left with the Ghostty move, so the shell runs the frontend command directly; the DirectHost still measures the same zsh contract.
            await adapter.create(
              {
                ...context.session,
                // The exact string Ghostty would exec: two commands, so zsh forks the frontend into its own foreground process group instead of implicit-exec'ing it in place, which would read as shell-idle.
                argv: [TERMINAL_SHELL, "-l", "-i", "-c", launch.command],
                expectedExecutable: TERMINAL_SHELL,
              },
              { locator, visibility: lease.visibility },
            );
          },
          sessiond: {
            terminalHost: adapter,
            prepareAgentCreation: () =>
              workspaceVisibility.prepareAgentCreation(),
            admit: (candidate) => workspaceVisibility.admit(candidate),
          },
          stopSession: stopSpawnedSession,
          createWorktree: async (_root, name, slug) => {
            const path = join(home, `worktree-${name}`);
            await mkdir(path, { recursive: true });
            return { path, branch: `hive/${name}-${slug}` };
          },
          unavailableAgentNames: async () => new Set(),
          listCodexMcpServers: async () => [],
          readCodexActivity: async () => null,
          codexExecutable: providerExecutable,
          buildMemoryIndex: async () => "",
          sleep: async () => {
            for (const agent of db.listAgents()) {
              if (agent.status === "spawning") {
                if (agent.sessionLocator?.hostKind === "sessiond") {
                  const locator = requireSessiondAgentLocator(agent);
                  if (
                    !workspaceVisibility
                      .currentSnapshot()
                      ?.terminals.some(
                        (terminal) => terminal.agentId === agent.id,
                      )
                  ) {
                    expect(
                      workspaceVisibility.publish({
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
                        terminals: [
                          {
                            agentId: agent.id,
                            agentName: agent.name,
                            locator,
                            state: "pending",
                          },
                        ],
                      }),
                    ).toEqual({
                      state: "accepted",
                      inventoryRevision: `${
                        BigInt(admittedVisibility.openTerminalRevision) + 1n
                      }`,
                    });
                  }
                }
                db.insertAgent({ ...agent, status: "working" });
                resolveAgentWorking();
              }
            }
          },
        });

        const sessiondAgent = await spawner.spawn({
          task: "Exercise the admitted sessiond backend",
          category: "complex_coding",
          tool: "codex",
          model: "gpt-sessiond-live",
        });
        expect(sessiondAgent.sessionLocator?.hostKind).toBe("sessiond");
        await agentWorking;
        expect(db.getAgentById(sessiondAgent.id)?.status).toBe("working");
        const sessiondLocator = requireSessiondAgentLocator(sessiondAgent);
        const sessiondBinding =
          db.getTerminalHostBindingByLocator(sessiondLocator);
        if (!sessiondBinding?.createEvidence) {
          throw new Error("sessiond spawner omitted terminal binding evidence");
        }
        expect(sessiondBinding.locator).toEqual(sessiondLocator);
        expect(sessiondBinding.visibility).toEqual(visibility);
        expect(db.listTerminalHostBindings(handshake.instanceId)).toEqual([
          sessiondBinding,
        ]);
        expect(
          db.database
            .query(
              `
            SELECT locatorInstanceId, locatorSessionId, locatorGeneration
            FROM terminal_host_bindings
          `,
            )
            .all(),
        ).toEqual([
          {
            locatorInstanceId: sessiondLocator.instanceId,
            locatorSessionId: sessiondLocator.sessionId,
            locatorGeneration: sessiondLocator.generation,
          },
        ]);

        const sessiondInspection = await adapter.inspect(sessiondLocator);
        expect(sessiondInspection.presence).toBe("present");
        expect(sessiondInspection.complete).toBe(false);
        expect(sessiondInspection.visibility.state).toBe("attaching");
        expect(sessiondInspection.hostPid).not.toBeNull();
        expect(sessiondInspection.hostStartToken).not.toBeNull();
        expect(sessiondInspection.shellRoot).not.toBeNull();
        if (
          sessiondInspection.hostPid === null ||
          sessiondInspection.hostStartToken === null ||
          sessiondInspection.shellRoot === null
        ) {
          throw new Error("sessiond spawner omitted measured process identity");
        }
        spawnedHost = {
          pid: sessiondInspection.hostPid,
          startToken: sessiondInspection.hostStartToken,
        };
        spawnedProvider = sessiondInspection.shellRoot;
        expect(spawnedHost.pid).not.toBe(process.pid);
        expect(spawnedProvider.pid).not.toBe(process.pid);
        expect(spawnedProvider.pid).not.toBe(spawnedHost.pid);
        expect(macProcessIdentity(spawnedHost.pid).startToken).toBe(
          spawnedHost.startToken,
        );
        expect(macProcessIdentity(spawnedProvider.pid).startToken).toBe(
          spawnedProvider.startToken,
        );
        expect(sessiondInspection.expectedExecutable).toBe(
          sessiondBinding.createEvidence.expectedExecutable,
        );
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
        const neutralSession = neutralMatches[0]?.session;
        expect(neutralSession).toBeDefined();
        if (neutralSession === undefined) return;
        expect(neutralSession.incarnation).not.toBe(
          String(sessiondLocator.generation),
        );
        const neutralReadback = await host.inspect(neutralSession);
        expect(neutralReadback.session).toEqual(neutralSession);
        expect(neutralReadback.lifecycle).toBe("running");

        // The daemon does not renew leases: a terminal is alive because its
        // process is alive, and it observes that for itself. What the create
        // bound stays bound.
        expect(
          db.getTerminalHostBindingByLocator(sessiondLocator)?.visibility,
        ).toEqual(visibility);
        expect(
          (await adapter.inspect(sessiondLocator)).visibility,
        ).toMatchObject({
          workspaceSessionId: visibility.workspaceSessionId,
          openTerminalRevision: visibility.openTerminalRevision,
        });

        // Real-engine user input: the same viewer wire the frontend drives —
        // grant → HELLO(viewer) → HOST_ATTACH → INPUT_SUBMIT(user) must come
        // back with a real receipt and visible provider readback.
        const providerRun = db.getActiveProviderRunByTerminal(sessiondLocator);
        if (providerRun === null) {
          throw new Error("sessiond spawner omitted ProviderRun identity");
        }
        // Keystrokes only land once the pane reads its terminal in raw mode:
        // typed into a startup screen still in canonical mode, they are
        // flushed on the mode switch, not queued. The frontend enables raw
        // mode before its first draw, so a painted frame is the readback that
        // the pane is reading keys.
        //
        // The probe fires on the frontend's own composer rather than a vendor
        // TUI glyph. The composer stays visible even when diagnostics scroll
        // the transcript banner out of view.
        expect(
          paneComposerPainted(
            renderedFrontendFrame(sessiondAgent.name),
            sessiondAgent.name,
          ),
        ).toBe(true);
        expect(
          paneComposerPainted(
            launchCommandLine(sessiondAgent.name),
            sessiondAgent.name,
          ),
        ).toBe(false);
        expect(paneComposerPainted(null, sessiondAgent.name)).toBe(false);

        let composerReady = false;
        const readyDeadline = Date.now() + 30_000;
        while (Date.now() < readyDeadline && !composerReady) {
          const capture = await host
            .capture(sessiondLocator, { include: "visible-text", maxRows: 200 })
            .catch(() => null);
          composerReady = paneComposerPainted(
            capture?.text,
            sessiondAgent.name,
          );
          if (!composerReady) await Bun.sleep(100);
        }
        expect(composerReady).toBe(true);
        // Measured now, not read from the run: the run identifies the provider
        // the frontend owns, and a keystroke is fenced to the terminal it is
        // actually typed into.
        const terminalForeground = (await adapter.inspect(sessiondLocator))
          .foreground;
        if (terminalForeground.state !== "unmanaged") {
          throw new Error(
            `terminal foreground identity is unavailable (${terminalForeground.state})`,
          );
        }
        const viewerId = `hive-daemon:${handshake.instanceId}`;
        const viewerGeometry = {
          columns: 120,
          rows: 40,
          widthPx: 960,
          heightPx: 640,
          cellWidthPx: 8,
          cellHeightPx: 16,
        };
        const grant = await host.issueAttach(sessiondLocator, {
          viewerId,
          geometry: viewerGeometry,
          operations: ["view", "user-input"],
        });
        const viewer = await SessiondViewerAttachClient.attach({
          locator: sessiondLocator,
          grant,
          geometry: viewerGeometry,
          viewerId,
        });
        const liveMarker = "LIVE-PROOF #68: real-engine user input";
        try {
          // The attach client's public surface is automation-only; a user
          // submission speaks the same INPUT_SUBMIT frame directly.
          const wire = unsafeCast<{
            request(
              requestType: string,
              responseType: string,
              flags: number,
              payload: JsonValue,
            ): Promise<{ payload: Uint8Array }>;
          }>(viewer);
          const appliedFrame = await wire.request(
            "INPUT_SUBMIT",
            "APPLIED",
            FRAME_FLAGS.contentSensitive,
            {
              schemaVersion: 1,
              session: {
                key: sessiondLocator.sessionId,
                incarnation: String(sessiondLocator.generation),
              },
              provenance: "user",
              action: "edit",
              transactionId: "msg-68-live-proof",
              idempotencyKey: "msg-68-live-proof",
              expectedForeground: {
                pid: terminalForeground.pid,
                startToken: terminalForeground.startToken,
                processGroupId: terminalForeground.foregroundProcessGroupId,
              },
              operation: {
                kind: "bytes",
                encoding: "base64",
                bytes: Buffer.from(liveMarker, "utf8").toString("base64"),
              },
            },
          );
          // SAFETY: The test owns this value and its fields.
          const applied = JSON.parse(
            new TextDecoder().decode(appliedFrame.payload),
          ) as {
            resultKind: string;
            receipt: { stage: string; transactionId: string };
          };
          if (applied.resultKind !== "input") {
            throw new Error(
              `unexpected input result: ${JSON.stringify(applied)}`,
            );
          }
          expect(["accepted", "queued", "written-to-terminal"]).toContain(
            applied.receipt.stage,
          );
          expect(applied.receipt.transactionId).toBe("msg-68-live-proof");
        } finally {
          viewer.close();
        }

        // Visible provider readback: the typed bytes land on the real grid.
        let readback = "";
        const readbackDeadline = Date.now() + 10_000;
        while (
          Date.now() < readbackDeadline &&
          !readback.includes(liveMarker)
        ) {
          const capture = await host
            .capture(sessiondLocator, { include: "visible-text", maxRows: 200 })
            .catch(() => null);
          readback = capture?.text ?? "";
          if (!readback.includes(liveMarker)) await Bun.sleep(50);
        }
        expect(readback).toContain(liveMarker);

        expect(
          db
            .listAgents()
            .filter((agent) => agent.sessionLocator?.hostKind === "sessiond"),
        ).toHaveLength(1);

        // Sessiond fan-out lives on the daemon's POST /stop. This harness has
        // no daemon, so the injected transport performs the same teardown the
        // daemon's commit path would — the live proof (real host process
        // absence, termination audit) is unchanged.
        // SAFETY: The test owns this value and its fields.
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
        expect(
          db.getTerminalHostBindingByLocator(sessiondLocator)?.terminationAudit,
        ).toMatchObject({ reason: `stop agent ${sessiondAgent.id}` });
        await Promise.all([
          waitForExactProcessAbsence(spawnedHost.pid, spawnedHost.startToken),
          waitForExactProcessAbsence(
            spawnedProvider.pid,
            spawnedProvider.startToken,
          ),
        ]);
        expect((await adapter.inspect(sessiondLocator)).presence).not.toBe(
          "present",
        );
        spawnedHost = null;
        spawnedProvider = null;

        admittedVisibility = {
          ...visibility,
          openTerminalRevision: "3",
        };
        workspaceVisibility = visibilityAuthority();
        registerAndPublishEmptyWorkspace();
        agentWorking = nextAgentWorking();
        const expiryAgent = await spawner.spawn({
          task: "Exercise publisher-death lease expiry",
          category: "complex_coding",
          tool: "codex",
          model: "gpt-sessiond-live",
        });
        await agentWorking;
        const expiryLocator = requireSessiondAgentLocator(expiryAgent);
        const expiryInspection = await adapter.inspect(expiryLocator);
        if (
          expiryInspection.hostPid === null ||
          expiryInspection.hostStartToken === null ||
          expiryInspection.shellRoot === null
        ) {
          throw new Error(
            "publisher-death session omitted measured process identity",
          );
        }
        spawnedHost = {
          pid: expiryInspection.hostPid,
          startToken: expiryInspection.hostStartToken,
        };
        spawnedProvider = expiryInspection.shellRoot;
        expect(macProcessIdentity(spawnedHost.pid).startToken).toBe(
          spawnedHost.startToken,
        );
        expect(macProcessIdentity(spawnedProvider.pid).startToken).toBe(
          spawnedProvider.startToken,
        );

        process.kill(workspacePublisher.pid, "SIGKILL");
        await workspacePublisher.exited;
        // A running host holds its own lease open, so a terminal outlives the
        // workspace that published it: only an explicit termination ends one.
        // Nothing infers a terminal's death, because reading an unrenewed
        // lease as death kills working agents whose vendor TUI is rendered and
        // running. Waiting past the deadline is what proves it no longer
        // decides — the lease bounds the wire's expiresAt, not whether the
        // terminal may live.
        await Bun.sleep(TERMINAL_LIMITS.visibilityExpiryMilliseconds + 1_000);
        expect(macProcessIdentity(spawnedHost.pid).startToken).toBe(
          spawnedHost.startToken,
        );
        expect(macProcessIdentity(spawnedProvider.pid).startToken).toBe(
          spawnedProvider.startToken,
        );
        const survived = await adapter.inspect(expiryLocator);
        expect(survived.presence).toBe("present");
        expect(survived.visibility.state).not.toBe("expired");
      } finally {
        await killExactProcess(
          workspacePublisher.pid,
          workspace.startToken,
        ).catch(() => undefined);
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
      handshakeServer.stop(true);
    }
  } finally {
    try {
      if (lifecycleWritten) cleanupLifecycleFiles();
      else if (lockAcquired && !releaseDaemonLock()) {
        lockReleaseFailed = true;
      }
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      if (previousSessiondRoot === undefined)
        delete process.env.HIVE_SESSIOND_ROOT;
      else process.env.HIVE_SESSIOND_ROOT = previousSessiondRoot;
    }
  }
  if (lockReleaseFailed) {
    throw new Error("could not release live-harness daemon lock");
  }
}, 45_000);
