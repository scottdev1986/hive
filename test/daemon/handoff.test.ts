import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HiveDatabase } from "../../src/daemon/db";
import {
  buildHandoffBundle,
  measureHandoffWorktree,
} from "../../src/daemon/handoff";
import { HiveDaemon } from "../../src/daemon/server";
import { buildAgentPrompt } from "../../src/daemon/spawner-impl";
import { StatusStore } from "../../src/daemon/status-store";
import { actingAs } from "../../src/daemon/testing";
import type {
  AgentRecord,
  MemoryFact,
  ProviderEvent,
  ProviderRun,
} from "../../src/schemas";
import { AgentMessageSchema } from "../../src/schemas";

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
  recoveryAttempts: 0,
  capabilityEpoch: 1,
  readOnly: false,
  writeRevoked: true,
};

const run: ProviderRun = {
  runId: "018f1e90-7b5a-7cc0-8000-000000000211",
  agentId: agent.id,
  terminal,
  provider: "codex",
  model: agent.model,
  effort: "high",
  conversationId: "thread-handoff",
  pid: 4_200,
  startToken: "4200:1",
  foregroundProcessGroupId: 4_200,
  capabilityEpoch: 0,
  launchGrantId: "grant-handoff",
  startedAt: AT,
  endedAt: "2026-07-25T01:10:00.000Z",
  state: "exited",
  exitReason: "provider-process-exited",
};

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

  test("replacement bootstrap carries the exact pickup boundary", () => {
    const prompt = buildAgentPrompt(
      "replacement",
      "Preserve exact work",
      { path: "/repo/.hive/worktrees/replacement", branch: "hive/replacement" },
      "",
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
    const requirement = AgentMessageSchema.parse({
      id: "requirement-message",
      from: "queen",
      to: agent.name,
      body: "Retain the worktree",
      createdAt: "2026-07-25T01:01:00.000Z",
      deliveredAt: null,
      sequence: 3,
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
      messages: [requirement],
      providerEvents: [providerEvent],
      statusEvents: status.listEventsForAgent(agent.id),
      output: {
        locator: terminal,
        outputThrough: "42",
        text: "last useful line\nBearer secret-token-value",
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
    expect(bundle.requirementRefs.map((ref) => ref.id)).toEqual([
      requirement.id,
    ]);
    expect(bundle.pendingMessageIds).toEqual([requirement.id]);
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
      messages: [],
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

  test("a dead source without a final status still produces a usable handoff", async () => {
    const requirement = AgentMessageSchema.parse({
      id: "dead-source-requirement",
      from: "queen",
      to: agent.name,
      body: "Continue from the retained worktree",
      createdAt: "2026-07-25T01:01:00.000Z",
      deliveredAt: null,
      sequence: 4,
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
      messages: [requirement],
      providerEvents: [],
      statusEvents: [],
      output: {
        locator: terminal,
        outputThrough: "51",
        text: "last retained provider output",
        completeness: "complete",
      },
      memory: [],
      createdAt: "2026-07-25T01:12:00.000Z",
    });

    expect(bundle.activity.statusReportRef).toBeNull();
    expect(bundle.originalTaskRef.content).toBe(agent.taskDescription);
    expect(bundle.requirementRefs.map((ref) => ref.id)).toEqual([
      requirement.id,
    ]);
    expect(bundle.pendingMessageIds).toEqual([requirement.id]);
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

  test("the replacement seam persists before stop and defers routing, then pickup leaves work open", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent({ ...agent, status: "held", writeRevoked: false });
    db.insertProviderRun({
      ...run,
      state: "running",
      endedAt: null,
      exitReason: null,
    });
    const order: string[] = [];
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot: "/does/not/exist",
      spawner: {
        async spawn() {
          order.push("spawn");
          throw new Error("automatic replacement must stay deferred");
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
    expect(order).toEqual(["pause", "stop"]);
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
    expect(db.listMessages().at(-1)?.body).toContain(
      "codex/weekly pool until 2026-07-26T19:00:00.000Z",
    );
    expect(db.listMessages().at(-1)?.body).toContain(
      "Automatic replacement is deferred",
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
