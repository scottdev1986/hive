import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { loadAgentStandards } from "../../src/daemon/spawn/agent-standards";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  buildHandoffBundle,
  measureHandoffWorktree,
} from "../../src/daemon/queen-provider-service/handoff";
import { HiveDaemon } from "../../src/daemon/server";
import { buildAgentPrompt } from "../../src/daemon/spawn/spawner-impl";
import { StatusStore } from "../../src/daemon/status/status-store";
import { actingAs } from "../support/daemon-test-support";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { MemoryFact } from "../../src/schemas/memory";
import type { ProviderEvent } from "../../src/schemas/provider-communication";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { MailItemSchema } from "../../src/schemas/mail";
import { mailbox } from "../mail-test-support";

const AT = "2026-07-25T01:00:00.000Z";
const terminal = {
  schemaVersion: 1 as const,
  instanceId: "hive-handoff",
  subject: { kind: "agent" as const, agentId: "agent-source" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000210",
  hostKind: "sessiond" as const,
  engineBuildId: "engine-handoff",
};

const agent: AgentRecord = {
  id: "agent-source",
  name: "maya",
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "dead",
  taskDescription: "Preserve exact work",
  worktreePath: "/tmp/hive-maya",
  branch: "hive/maya-work",
  sessionLocator: terminal,
  contextPct: null,
  createdAt: AT,
  lastEventAt: "2026-07-25T01:10:00.000Z",
  capabilityEpoch: 1,
  readOnly: false,
  writeRevoked: true,
};

const run = {
  runId: "018f1e90-7b5a-7cc0-8000-000000000211",
  agentId: agent.id,
  terminal,
  provider: "codex",
  model: agent.model,
  effort: "high",
  conversationId: "thread-handoff",
  adapterChild: {
    pid: 4_200,
    startToken: "4200:1",
    processGroupId: 4_200,
    observedAt: AT,
  },
  protocolReceipt: null,
  capabilityEpoch: 0,
  launchGrantId: "grant-handoff",
  startedAt: AT,
  endedAt: "2026-07-25T01:10:00.000Z",
  state: "exited",
  exitReason: "provider-process-exited",
} satisfies ProviderRun;

const memory: MemoryFact = {
  id: "handoff-fact",
  scope: "repo",
  topic: "handoff",
  title: "Handoff fact",
  body: "Durable memory body",
  tags: [],
  date: "2026-07-25",
  path: "/repo/.hive/memory/wiki/handoff-fact.md",
  source: "agent",
  evidence: "measured",
  status: "verified",
  kind: "article",
  supersedes: [],
  raw: ["/repo/.hive/memory/raw/2026-07-25/fact.md"],
  verified: "2026-07-25",
};

describe("handoff bundle", () => {
  test("measures exact branch work without touching the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-handoff-git-"));
    const worktree = join(root, "source-worktree");
    const runGit = async (cwd: string, args: string[]) => {
      const child = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
    };
    try {
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "user.email", "hive@example.invalid"]);
      await runGit(root, ["config", "user.name", "Hive Test"]);
      await writeFile(join(root, "tracked.txt"), "base\n");
      await runGit(root, ["add", "tracked.txt"]);
      await runGit(root, ["commit", "-m", "base"]);
      await runGit(root, ["branch", "hive/source"]);
      await runGit(root, ["worktree", "add", worktree, "hive/source"]);
      await writeFile(join(worktree, "committed.txt"), "committed\n");
      await runGit(worktree, ["add", "committed.txt"]);
      await runGit(worktree, ["commit", "-m", "source commit"]);
      await writeFile(join(worktree, "committed.txt"), "dirty\n");
      await writeFile(join(worktree, "untracked.txt"), "untracked\n");

      const measured = await measureHandoffWorktree(
        root,
        worktree,
        "hive/source",
      );
      expect(measured.name).toBe("hive/source");
      expect(measured.head).not.toBe(measured.base);
      expect(measured.commits.map((commit) => commit.subject)).toEqual([
        "source commit",
      ]);
      expect(measured.dirtyPaths).toEqual(["committed.txt"]);
      expect(measured.untrackedPaths).toEqual(["untracked.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replacement bootstrap carries the exact pickup boundary", async () => {
    const prompt = buildAgentPrompt(
      "replacement",
      "Preserve exact work",
      { path: "/repo/.hive/worktrees/replacement", branch: "hive/replacement" },
      "",
      await loadAgentStandards(join(import.meta.dir, "../..")),
      {
        category: "simple_coding",
        handoffId: "018f1e90-7b5a-7cc0-8000-000000000216",
      },
    );
    expect(prompt).toContain("hive_pickup_handoff");
    expect(prompt).toContain("018f1e90-7b5a-7cc0-8000-000000000216");
    expect(prompt).toContain("does not mark it complete");
  });

  test("preserves a dead source through a terminal gap and summarizer failure", async () => {
    const db = new HiveDatabase(":memory:");
    const status = new StatusStore(db, "instance-handoff");
    const assignment = status.openAssignment(agent.id, AT);
    status.appendAgentReport(
      {
        subject: agent.name,
        agentId: agent.id,
        role: "writer",
        incarnationGeneration: terminal.generation,
        capabilityEpoch: 0,
        toolSessionId: run.conversationId,
      },
      {
        requestId: "req_018f1e90-7b5a-7cc0-8000-000000000214",
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.assignmentGeneration,
        phase: "blocked",
        summary: "Tests were running",
        blocker: "Provider quota ended",
        evidenceRefs: ["memory:repo:handoff-fact", "test:targeted"],
        nextCheckpoint: "Run the full suite",
        freshForSeconds: 120,
      },
      new Date("2026-07-25T01:09:00.000Z"),
    );
    const requirement = MailItemSchema.parse({
      itemId: "requirement-message",
      recipient: agent.name,
      sender: "queen",
      lane: "control",
      topic: "handoff",
      body: "Retain the worktree",
      seq: 3,
      state: "available",
      mergedCount: 0,
      attempts: 0,
      recipientGeneration: null,
      createdAt: "2026-07-25T01:01:00.000Z",
      updatedAt: "2026-07-25T01:01:00.000Z",
      expiresAt: null,
      notBefore: null,
    });
    const providerEvent: ProviderEvent = {
      eventId: "provider-event-handoff",
      providerRunId: run.runId,
      provider: run.provider,
      capabilityEpoch: run.capabilityEpoch,
      conversationId: run.conversationId,
      kind: "turn-failed",
      occurredAt: "2026-07-25T01:10:00.000Z",
      toolName: null,
      inputDigest: null,
    };

    const bundle = await buildHandoffBundle({
      handoffId: "018f1e90-7b5a-7cc0-8000-000000000212",
      reason: "quota-drain",
      agent,
      run,
      measurement: {
        name: "hive/maya-work",
        base: "base-sha",
        head: "head-sha",
        dirtyPaths: ["src/daemon.ts"],
        untrackedPaths: ["notes.txt"],
        commits: [{ id: "head-sha", subject: "Preserve work" }],
      },
      mail: [requirement],
      providerEvents: [providerEvent],
      statusEvents: status.listEventsForAgent(agent.id),
      output: {
        locator: terminal,
        outputThrough: "42",
        screen: "last useful line\nBearer secret-token-value",
        completeness: "gap",
      },
      memory: [memory],
      createdAt: "2026-07-25T01:11:00.000Z",
      summarize: async () => {
        throw new Error("summarizer unavailable");
      },
    });

    expect(bundle.completeness).toBe("partial");
    expect(bundle.runOutcome).toEqual({
      decisionId: run.launchGrantId,
      providerRunId: run.runId,
      provider: run.provider,
      model: agent.model,
      taskCategory: agent.category,
      outcome: "quota-drained",
      handoffId: bundle.handoffId,
      startedAt: run.startedAt,
      endedAt: "2026-07-25T01:11:00.000Z",
    });
    expect(bundle.originalTaskRef.content).toBe(agent.taskDescription);
    expect(bundle.requirementRefs).toEqual([
      {
        kind: "message",
        id: requirement.itemId,
        content: requirement.body,
        digest: expect.any(String),
      },
    ]);
    expect(bundle.pendingMessageIds).toEqual([requirement.itemId]);
    expect(bundle.messagesThrough).toBe(3);
    expect(bundle.memoryRefs.map((ref) => ref.id)).toEqual([memory.id]);
    expect(bundle.activity).toMatchObject({
      providerEventRefs: [providerEvent.eventId],
      providerTranscriptRefs: [],
      terminalOutputRanges: [{ through: "42", completeness: "gap" }],
    });
    expect(bundle.summary?.provenance).toBe("fallback");
    expect(JSON.stringify(bundle.summary)).toContain("Tests were running");
    expect(JSON.stringify(bundle.summary)).toContain("last useful line");
    expect(JSON.stringify(bundle.summary)).not.toContain("secret-token-value");
    expect(bundle.summary?.nextAction).toBe("Run the full suite");
    db.close();
  });

  test("worktree measurement failure preserves an unknown bundle", async () => {
    const bundle = await buildHandoffBundle({
      handoffId: "018f1e90-7b5a-7cc0-8000-000000000213",
      reason: "crash",
      agent,
      run,
      measurement: null,
      mail: [],
      providerEvents: [],
      statusEvents: [],
      output: null,
      memory: [memory],
      createdAt: "2026-07-25T01:11:00.000Z",
    });
    expect(bundle.completeness).toBe("unknown");
    expect(bundle.branch).toEqual({
      name: "hive/maya-work",
      base: "unknown",
      head: "unknown",
    });
    expect(bundle.memoryRefs).toEqual([]);
    expect(bundle.summary?.provenance).toBe("fallback");
    expect(bundle.runOutcome.outcome).toBe("crashed");
  });

  test("refuses to misattribute an outcome to a different launch identity", async () => {
    await expect(
      buildHandoffBundle({
        handoffId: "018f1e90-7b5a-7cc0-8000-000000000218",
        reason: "quota-drain",
        agent,
        run: { ...run, model: "different-model" },
        measurement: null,
        mail: [],
        providerEvents: [],
        statusEvents: [],
        output: null,
        memory: [],
        createdAt: "2026-07-25T01:11:00.000Z",
      }),
    ).rejects.toThrow("provider run does not match");
  });

  test("a dead source without a final status still produces a usable handoff", async () => {
    const requirement = MailItemSchema.parse({
      itemId: "dead-source-requirement",
      recipient: agent.name,
      sender: "queen",
      lane: "control",
      topic: "handoff",
      body: "Continue from the retained worktree",
      seq: 4,
      state: "available",
      mergedCount: 0,
      attempts: 0,
      recipientGeneration: null,
      createdAt: "2026-07-25T01:01:00.000Z",
      updatedAt: "2026-07-25T01:01:00.000Z",
      expiresAt: null,
      notBefore: null,
    });
    const bundle = await buildHandoffBundle({
      handoffId: "018f1e90-7b5a-7cc0-8000-000000000217",
      reason: "crash",
      agent,
      run,
      measurement: {
        name: "hive/maya-work",
        base: "base-sha",
        head: "head-sha",
        dirtyPaths: ["src/preserved.ts"],
        untrackedPaths: [],
        commits: [],
      },
      mail: [requirement],
      providerEvents: [],
      statusEvents: [],
      output: {
        locator: terminal,
        outputThrough: "51",
        screen: "last retained provider output",
        completeness: "complete",
      },
      memory: [],
      createdAt: "2026-07-25T01:12:00.000Z",
    });

    expect(bundle.activity.statusReportRef).toBeNull();
    expect(bundle.originalTaskRef.content).toBe(agent.taskDescription);
    expect(bundle.requirementRefs).toEqual([
      {
        kind: "message",
        id: requirement.itemId,
        content: requirement.body,
        digest: expect.any(String),
      },
    ]);
    expect(bundle.pendingMessageIds).toEqual([requirement.itemId]);
    expect(bundle.branch).toMatchObject({
      name: agent.branch,
      head: "head-sha",
    });
    expect(bundle.worktree.dirtyPaths).toEqual(["src/preserved.ts"]);
    expect(bundle.activity.terminalOutputRanges).toHaveLength(1);
    expect(bundle.activity.terminalOutputRanges[0]).toMatchObject({
      through: "51",
      completeness: "complete",
    });
    expect(bundle.summary).toMatchObject({ provenance: "fallback" });
  });

  test("the replacement seam persists before stop, then routes a replacement and pickup leaves work open", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent({ ...agent, status: "held", writeRevoked: false });
    db.insertProviderRun({
      ...run,
      state: "running",
      endedAt: null,
      exitReason: null,
    });
    const order: string[] = [];
    const spawnRequests: unknown[] = [];
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot: "/does/not/exist",
      spawner: {
        async spawn(request) {
          order.push("spawn");
          spawnRequests.push(request);
          return { ...agent, id: "agent-replacement", name: "replacement" };
        },
      },
    });
    const internal = daemon as unknown as {
      terminalHost: {
        pauseProvider: () => Promise<boolean>;
        stopProvider: () => Promise<boolean>;
        inspect: () => Promise<never>;
      };
      replaceWithHandoff: (
        source: AgentRecord,
        drain: {
          provider: "codex";
          pool: string;
          resetsAt: string;
          reason: string;
        },
      ) => Promise<void>;
    };
    internal.terminalHost.pauseProvider = async () => {
      order.push("pause");
      return true;
    };
    internal.terminalHost.inspect = async () => {
      throw new Error("retention unavailable");
    };
    internal.terminalHost.stopProvider = async () => {
      expect(db.getHandoffForSourceRun(run.runId)).not.toBeNull();
      order.push("stop");
      return true;
    };

    await internal.replaceWithHandoff(agent, {
      provider: "codex",
      pool: "weekly",
      resetsAt: "2026-07-26T19:00:00.000Z",
      reason: "weekly pool spent",
    });
    expect(order).toEqual(["pause", "stop", "spawn"]);
    expect(db.getAgentById(agent.id)).toMatchObject({
      status: "control-paused",
      writeRevoked: true,
      capabilityEpoch: 2,
      worktreePath: agent.worktreePath,
      branch: agent.branch,
    });
    const stored = db.getHandoffForSourceRun(run.runId);
    if (stored === null) throw new Error("handoff was not persisted");
    expect(stored?.bundle.completeness).toBe("unknown");
    expect(stored?.pickup).toBeNull();
    expect(spawnRequests[0]).toMatchObject({
      task: agent.taskDescription,
      category: agent.category,
      handoffId: stored.bundle.handoffId,
      excludedPoolIds: ["weekly"],
    });
    expect(mailbox(daemon.mail, ORCHESTRATOR_NAME).at(-1)?.body).toContain(
      "replacement (codex/gpt-5-codex) was launched to pick it up",
    );

    db.insertAgent({
      ...agent,
      id: "agent-replacement",
      name: "replacement",
      status: "working",
      taskDescription: agent.taskDescription,
      capabilityEpoch: 0,
      writeRevoked: false,
      sessionLocator: {
        ...terminal,
        subject: { kind: "agent", agentId: "agent-replacement" },
        sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000215",
      },
    });

    const fetch = actingAs(daemon, "replacement", "writer");
    const client = new Client({ name: "handoff-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "hive_pickup_handoff",
        arguments: {
          agent: "replacement",
          handoffId: stored.bundle.handoffId,
        },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
    expect(db.getHandoff(stored.bundle.handoffId)?.pickup).toMatchObject({
      replacementAgentId: "agent-replacement",
    });
    expect(db.getAgentById("agent-replacement")?.status).toBe("working");
    db.close();
  });
});
