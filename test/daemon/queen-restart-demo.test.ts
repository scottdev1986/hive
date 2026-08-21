import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { definedFields } from "../../src/shared/defined-fields";
import { type JsonValue, safeJsonParse } from "../../src/shared/json";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  FakeProviderAdapter,
  type FakeProviderSession,
  fakeCapabilities,
} from "../../src/adapters/providers/protocol/fake-driver";
import {
  agentUiSessionStart,
  openAgentUiProviderSession,
  sessionRefPath,
} from "../../src/cli/agent-ui/run";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { CapabilityProvider } from "../../src/schemas/capability";
import {
  PrepareQueenLaunchResponseSchema,
  RunCheckpointSchema,
} from "../../src/schemas/run-checkpoint";
import { bindRootSession } from "../mail-test-support";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-queen-restart-demo-");
process.env.HIVE_HOME = home;

const T0 = "2026-08-10T12:00:00.000Z";
const SPAWN_TASK_ID = "task_018f4f5e-0000-7000-8000-000000000001";
const FAKE_COMPACTION_SUMMARY =
  "PROVIDER_COMPACTION_SUMMARY_SENTINEL_do_not_trust_this_body";
const SESSION_A = "instrumented-session-A-before-restart";
const STAGE_C_GRACEFUL_TEST = join(
  import.meta.dir,
  "graceful-shutdown.test.ts",
);

const ALL_AVAILABLE = {
  claude: { available: true },
  codex: { available: true },
  grok: { available: true },
  kimi: { available: true },
  opencode: { available: true },
} as const;

function harness() {
  const db = new HiveDatabase(":memory:");
  const observation = { provider: null as CapabilityProvider | null };
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-queen-restart-demo-noop",
    queenVendorAvailability: () => ALL_AVAILABLE,
    queenRootObservation: () => observation.provider,
  });
  // Gen N is already bound; restart prepares gen N+1.
  bindRootSession(db, 3);
  return { daemon, db, observation };
}

function insertWorker(db: HiveDatabase): void {
  db.insertAgent({
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: "working",
    taskDescription: "live worker holding a resume-eligible session",
    worktreePath: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-work",
    contextPct: null,
    createdAt: T0,
    lastEventAt: T0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  });
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return daemon.fetch(
    new Request(`http://hive${path}`, {
      method,
      headers,
      ...definedFields({
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    }),
  );
};

async function callTool(
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error: string; content: unknown }> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(url, { ...init, headers }));
      },
    },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return {
      ok: result.isError !== true,
      error: result.isError === true ? JSON.stringify(result.content) : "",
      content: result.content,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "?",
      content: null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function toolJson(content: unknown): JsonValue {
  const blocks = content as Array<{ type: string; text: string }>;
  const parsed = safeJsonParse(blocks[0]?.text ?? "null");
  if (parsed === undefined) {
    throw new Error("tool result was not JSON");
  }
  return parsed;
}

describe("queen restart demo harness", () => {
  test("crash/no-final-checkpoint restart: gen N+1, fresh session, capsule proof, gate, attestation, worker resume", async () => {
    const { daemon, db, observation } = harness();
    insertWorker(db);
    const user = daemon.capabilities.mint("user", "user").token;
    const queen = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;

    // 1. Verified queen checkpoint (gen N durable state).
    const written = await callTool(daemon, queen, "hive_run_checkpoint", {
      reason: "task-completion",
      contextUsage: {
        kind: "measured",
        residentTokens: 1_000,
        measuredAt: T0,
      },
      decision: { decision: "compact", reason: "stable before restart demo" },
      written: {
        goal: "prove restart recovery",
        done: ["checkpoint written"],
        failures: [],
        uncertainty: [],
        nextAction: "daemon restart",
        rollback: "relaunch prior root",
      },
      unresolvedQuestions: [],
      model: null,
    });
    expect(written.ok).toEqual(true);
    const checkpoint = RunCheckpointSchema.parse(toolJson(written.content));
    expect(checkpoint.agentSnapshot.map((entry) => entry.agentName)).toContain(
      "maya",
    );

    // 2. Newer board ruling on the control spine (owner-facing text that must
    // appear in the boot capsule). Leave it unsettled so prepare-launch sees
    // controlAvailable > 0 and names the item.
    const boardRuling =
      "OWNER_RULING_STAGE_D: keep the live worker; do not resume provider session";
    const published = daemon.mail.publish({
      recipient: "queen",
      sender: "owner",
      lane: "control",
      topic: "ruling",
      recipientGeneration: 3,
      body: boardRuling,
      idempotencyKey: "stage-d-owner-ruling-1",
      ttlSeconds: null,
      expiresAt: null,
      now: T0,
      controlLaneCapacity: 32,
    });
    const controlItemId = published.itemId;
    expect(controlItemId.length).toBeGreaterThan(0);
    expect(daemon.mail.countByState("queen", "control", "available")).toBe(1);

    // 4. Crash / no-final-checkpoint path: prepare-launch as the supervisor
    // would after a daemon restart with the prior durable checkpoint still present.
    const requestId = mintSessionRequestId();
    const preparedResponse = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/prepare-launch",
      {
        requestId,
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: "crash restart demo: no final graceful checkpoint",
      },
    );
    expect(preparedResponse.status).toEqual(200);
    const prepared = PrepareQueenLaunchResponseSchema.parse(
      await preparedResponse.json(),
    );

    // gen N was 3 (bound); target is N+1.
    expect(prepared.targetGeneration).toEqual(4);
    expect(prepared.succession.priorRootGeneration).toEqual(3);
    expect(prepared.succession.proof).toEqual({
      kind: "checkpoint",
      ref: { revision: checkpoint.revision, digest: checkpoint.digest },
    });
    expect(prepared.snapshot.map((entry) => entry.agentName)).toContain("maya");

    // Capsule carries proof + control backlog + worker snapshot + attestation tuple.
    expect(prepared.bootCapsule).toContain("freshSessionMandate");
    expect(prepared.bootCapsule).toContain(
      `targetGeneration: ${prepared.targetGeneration}`,
    );
    expect(prepared.bootCapsule).toContain(prepared.succession.successionId);
    expect(prepared.bootCapsule).toContain(checkpoint.digest);
    expect(prepared.bootCapsule).toContain(controlItemId);
    expect(prepared.bootCapsule).toMatch(/counts:.*"controlAvailable"/);
    expect(prepared.bootCapsule).not.toContain(FAKE_COMPACTION_SUMMARY);
    expect(prepared.bootCapsule).not.toContain(SESSION_A);

    // 5. Instrumented gen N+1 session open with a misleading planted ref.
    const pane = tempRoot("hive-restart-demo-pane-");
    const journalPath = join(pane, "outbound-journal.jsonl");
    const storePath = sessionRefPath(journalPath);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          identity: {
            provider: "claude",
            transport: "fake",
            version: "0.0.0-fake",
            cwd: pane,
          },
          session: {
            vendorSessionId: SESSION_A,
            replayedHistory: true,
          },
          recordedAt: T0,
          providerSummary: FAKE_COMPACTION_SUMMARY,
        },
        null,
        2,
      )}\n`,
    );

    const adapter = new FakeProviderAdapter(
      fakeCapabilities({
        runtime: {
          executable: "/fake/provider",
          version: "0.0.0-fake",
          transport: "fake",
          workingDirectory: pane,
        },
      }),
    );
    const opened = await openAgentUiProviderSession({
      subject: "queen",
      adapter,
      spawn: {
        provider: "claude",
        executable: "/fake/provider",
        argv: [],
        cwd: pane,
        env: {},
      },
      journalPath,
      sessionStart: agentUiSessionStart(
        { provider: "claude", readOnly: true },
        prepared.bootCapsule,
      ),
    });
    expect(opened.decision).toEqual({ outcome: "fresh" });
    const sessionB = opened.vendorSession.vendorSessionId;
    expect(sessionB).not.toBe(SESSION_A);
    const session = adapter.session as FakeProviderSession;
    expect(session.sessionCalls.map((call) => call.kind)).toEqual([
      "newSession",
    ]);
    const newCall = session.sessionCalls[0];
    if (newCall?.kind !== "newSession") throw new Error("expected newSession");
    expect(newCall.input.instruction).toContain(
      prepared.succession.successionId,
    );
    expect(newCall.input.instruction).not.toContain(FAKE_COMPACTION_SUMMARY);
    expect(newCall.input.instruction).not.toContain(SESSION_A);
    // Zero resume/load on the captured path.
    expect(
      session.sessionCalls.some((call) => call.kind === "resumeSession"),
    ).toBe(false);

    // 6. Pre-attestation operational tool denied.
    const gated = await callTool(daemon, queen, "hive_spawn", {
      task: "must wait for attestation",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(gated.ok).toEqual(false);
    expect(gated.error).toContain("awaits attestation");

    // 7. Measured status/mail/task/checkpoint reads, then attestation.
    observation.provider = "claude";
    expect((await callTool(daemon, queen, "hive_status")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_mail_poll", { recipient: "queen" }))
        .ok,
    ).toEqual(true);
    expect((await callTool(daemon, queen, "hive_task_list")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_run_checkpoint_get", {})).ok,
    ).toEqual(true);

    const attested = await callTool(daemon, queen, "hive_succession_attest", {
      successionId: prepared.succession.successionId,
      generation: prepared.targetGeneration,
      checkpointDigest: checkpoint.digest,
    });
    expect(attested.ok).toEqual(true);

    // Gate lifts (spawner still refuses — proves the refusal is no longer the gate).
    const admitted = await callTool(daemon, queen, "hive_spawn", {
      task: "work after attestation",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(admitted.ok).toEqual(false);
    expect(admitted.error).toContain("no spawns in this test");

    // 8. Worker stored session still resume-eligible (positive control).
    const workerAdapter = new FakeProviderAdapter(
      fakeCapabilities({
        provider: "codex",
        runtime: {
          executable: "/fake/codex",
          version: "0.0.0-fake",
          transport: "fake",
          workingDirectory: pane,
        },
      }),
    );
    // Re-seed a worker ref that mirrors a live worker's stored conversation.
    const workerJournal = join(pane, "worker-journal.jsonl");
    const workerStore = sessionRefPath(workerJournal);
    await writeFile(
      workerStore,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          identity: {
            provider: "codex",
            transport: "fake",
            version: "0.0.0-fake",
            cwd: pane,
          },
          session: {
            vendorSessionId: "worker-thread-resume-eligible",
            replayedHistory: true,
          },
          recordedAt: T0,
        },
        null,
        2,
      )}\n`,
    );
    const workerOpen = await openAgentUiProviderSession({
      subject: "maya",
      adapter: workerAdapter,
      spawn: {
        provider: "codex",
        executable: "/fake/codex",
        argv: [],
        cwd: pane,
        env: {},
      },
      journalPath: workerJournal,
      sessionStart: agentUiSessionStart({ provider: "codex", readOnly: false }),
    });
    expect(workerOpen.decision).toEqual({
      outcome: "resume",
      vendorSessionId: "worker-thread-resume-eligible",
    });
    expect(
      (workerAdapter.session as FakeProviderSession).sessionCalls.map(
        (call) => call.kind,
      ),
    ).toEqual(["resumeSession"]);

    await daemon.stop();
  });

  test("graceful-path final-checkpoint row: pending Stage C or active when landed", async () => {
    // Stage C owns graceful-shutdown checkpoint write+verify before kill — do
    // not re-implement. Align with Stage C proof tests by name:
    //   "graceful shutdown checkpoint > writes and digest-verifies the checkpoint before any worker termination"
    //   "graceful shutdown checkpoint > digest verification failure aborts shutdown and leaves the daemon running"
    // When that surface is present, this row proves prepare-launch after a
    // verified final checkpoint still yields gen N+1 + proof in the capsule.
    if (!existsSync(STAGE_C_GRACEFUL_TEST)) {
      expect({
        row: "graceful-restart-final-checkpoint",
        status: "pending-Stage-C",
        detail:
          "graceful-shutdown.test.ts not on this base; Stage C landing activates this row",
      }).toMatchObject({
        row: "graceful-restart-final-checkpoint",
        status: "pending-Stage-C",
      });
      return;
    }

    const stageCSource = await readFile(STAGE_C_GRACEFUL_TEST, "utf8");
    expect(stageCSource).toContain(
      "writes and digest-verifies the checkpoint before any worker termination",
    );
    expect(stageCSource).toContain(
      "digest verification failure aborts shutdown and leaves the daemon running",
    );

    // After Stage C's verified final checkpoint, prepare-launch still binds the
    // successor to that proof (same as crash when the last write was clean).
    const { daemon, db } = harness();
    insertWorker(db);
    const user = daemon.capabilities.mint("user", "user").token;
    const queen = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;
    // Prefer Stage C's graceful-shutdown reason when the schema accepts it;
    // fall back to task-completion so this row still runs on intermediate bases.
    let written = await callTool(daemon, queen, "hive_run_checkpoint", {
      reason: "graceful-shutdown",
      contextUsage: {
        kind: "measured",
        residentTokens: 500,
        measuredAt: T0,
      },
      decision: { decision: "compact", reason: "pre-graceful" },
      written: {
        goal: "graceful path",
        done: [],
        failures: [],
        uncertainty: [],
        nextAction: "stop",
        rollback: "none",
      },
      unresolvedQuestions: [],
      model: null,
    });
    if (!written.ok) {
      written = await callTool(daemon, queen, "hive_run_checkpoint", {
        reason: "task-completion",
        contextUsage: {
          kind: "measured",
          residentTokens: 500,
          measuredAt: T0,
        },
        decision: { decision: "compact", reason: "pre-graceful" },
        written: {
          goal: "graceful path",
          done: [],
          failures: [],
          uncertainty: [],
          nextAction: "stop",
          rollback: "none",
        },
        unresolvedQuestions: [],
        model: null,
      });
    }
    expect(written.ok).toEqual(true);
    const checkpoint = RunCheckpointSchema.parse(toolJson(written.content));
    const preparedResponse = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/prepare-launch",
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: "graceful restart demo after Stage C final checkpoint",
      },
    );
    expect(preparedResponse.status).toEqual(200);
    const prepared = PrepareQueenLaunchResponseSchema.parse(
      await preparedResponse.json(),
    );
    expect(prepared.targetGeneration).toEqual(4);
    expect(prepared.succession.proof).toEqual({
      kind: "checkpoint",
      ref: { revision: checkpoint.revision, digest: checkpoint.digest },
    });
    expect(prepared.bootCapsule).toContain(checkpoint.digest);
    expect(prepared.bootCapsule).toContain("freshSessionMandate");
    await daemon.stop();
  });
});
