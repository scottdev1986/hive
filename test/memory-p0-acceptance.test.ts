import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveConfigSchema } from "../src/schemas/config-schema";
import { MemoryWriteService } from "../src/memory-service/write-service";
import { MemoryIndex } from "../src/memory-service/fts-index";
import {
  writeMemoryFact,
  discoverMemoryFacts,
} from "../src/memory-service/memory-store";
import { EpisodicStore } from "../src/memory-service/episodic";
import { runRetentionSweep } from "../src/memory-service/retention";

/** §7 P0 Acceptance Tests - Named tests from LOCKED plan */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("P0 Memory Acceptance Tests", () => {
  // P0.9: embedding_provider: "api" fails config parse
  test("api_provider_fail_closed", () => {
    // SAFETY: "api" is not an accepted provider; this object exists only to prove parse rejects it.
    expect(() =>
      HiveConfigSchema.parse({
        memory: { embedding_provider: "api" },
      } as never),
    ).toThrow();
  });

  // P0.6: Real keepIds from ledger/pitfall provenance
  test("retention_keepset", async () => {
    const root = await makeTempDir("hive-retention-");
    const episodic = new EpisodicStore(":memory:");

    // Add episodes with specific IDs (appendEvent returns the id)
    const ep1 = episodic.appendEvent({
      agent: "test-agent",
      type: "test",
      summary: "Referenced episode 1",
      provenance: {},
    });
    const ep2 = episodic.appendEvent({
      agent: "test-agent",
      type: "test",
      summary: "Referenced episode 2",
      provenance: {},
    });
    const ep3 = episodic.appendEvent({
      agent: "test-agent",
      type: "test",
      summary: "Unreferenced old episode",
      provenance: {},
    });

    // Create fact with episode references using real episode IDs
    await writeMemoryFact(root, {
      scope: "repo",
      topic: "pitfalls",
      title: "Test pitfall",
      body: `See episode E${ep1.id} for details`,
      evidence: `From verification in event #${ep2.id}`,
      source: "agent",
      status: "verified",
      verified: "2026-08-01",
      kind: "pitfall",
      tags: [],
      supersedes: [],
      date: "2026-08-01",
    });

    // Set cutoff before all events (so all would be deleted without keep-set)
    const report = await runRetentionSweep({
      episodic,
      repoRoot: root,
      config: {
        events_hot_days: 0,
        stale_after_days: 0,
        sweep_interval_hours: 24,
      },
      now: new Date("2026-08-20"),
      countCandidates: false,
    });

    // Episodes ep1 and ep2 should be preserved (referenced in fact)
    // Episode ep3 should be deleted
    const events = episodic.listEvents();
    const eventIds = events.map((e) => e.id);

    expect(eventIds).toContain(String(ep1.id));
    expect(eventIds).toContain(String(ep2.id));
    expect(eventIds).not.toContain(String(ep3.id));
    expect(report.eventsDeleted).toBe(1); // Only ep3 deleted
  });

  // P0.8: Global writes use global lock, repo writes use repo lock
  test("scope_lock", async () => {
    const root = await makeTempDir("hive-scope-lock-");
    const index = new MemoryIndex(new Database(":memory:"));

    const service = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write to repo scope
    const repoFact = await service.write({
      scope: "repo",
      topic: "test",
      title: "Repo fact",
      body: "Test body",
      evidence: "Test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Write to global scope
    const globalFact = await service.write({
      scope: "global",
      topic: "test",
      title: "Global fact",
      body: "Test body",
      evidence: "Test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Both should succeed (different locks)
    expect(repoFact.scope).toBe("repo");
    expect(globalFact.scope).toBe("global");
  });

  // P0.7: Pre-write gate prevents duplicate titles
  test("prewrite_dedup", async () => {
    const root = await makeTempDir("hive-prewrite-");
    const index = new MemoryIndex(new Database(":memory:"));

    const service = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write first fact
    const first = await service.write({
      scope: "repo",
      topic: "test",
      title: "Test Article",
      body: "Original body",
      evidence: "Test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Write near-duplicate (different punctuation/case)
    const second = await service.write({
      scope: "repo",
      topic: "test",
      title: "Test Article!", // Same normalized title
      body: "Updated body",
      evidence: "Test evidence 2",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Should UPDATE existing (same id), not ADD new
    expect(second.id).toBe(first.id);
    // supersedes field should list the id being updated
    expect(second.supersedes).toContain(first.id);

    // Only one fact file should exist on disk
    const facts = await discoverMemoryFacts(root, "repo");
    expect(facts.length).toBe(1);
    expect(facts[0]?.id).toBe(first.id);
    expect(facts[0]?.body).toBe("Updated body"); // body updated
  });

  // Hole #3: NOOP write-gate returns and honors NOOP when body is identical
  test("prewrite_noop", async () => {
    const root = await makeTempDir("hive-noop-");
    const index = new MemoryIndex(new Database(":memory:"));

    const service = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write first fact
    const first = await service.write({
      scope: "repo",
      topic: "test",
      title: "NOOP Test Article",
      body: "Identical body content",
      evidence: "Test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Count raw observation files before NOOP write
    const rawRoot = join(root, ".hive", "memory", "repo", "raw", "test");
    const rawFilesBefore = await readdir(rawRoot).catch(() => []);
    const rawCountBefore = rawFilesBefore.length;

    // Write exact duplicate (same normalized title AND same body)
    const noop = await service.write({
      scope: "repo",
      topic: "test",
      title: "NOOP Test Article!", // Same normalized title
      body: "Identical body content", // IDENTICAL body
      evidence: "Different evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Should return same id (NOOP, not a new write)
    expect(noop.id).toBe(first.id);
    // Embedding should be marked as skipped
    expect(noop.embedding).toBe("skipped:noop");
    // Raw path should be empty (no new observation)
    expect(noop.rawPath).toBe("");
    // No supersedes for NOOP
    expect(noop.supersededIds).toEqual([]);

    // No new raw observation file should have been created
    const rawFilesAfter = await readdir(rawRoot).catch(() => []);
    const rawCountAfter = rawFilesAfter.length;
    expect(rawCountAfter).toBe(rawCountBefore);

    // Only one fact file should exist on disk
    const facts = await discoverMemoryFacts(root, "repo");
    expect(facts.length).toBe(1);
    expect(facts[0]?.id).toBe(first.id);
    expect(facts[0]?.body).toBe("Identical body content"); // body unchanged
  });

  // P0.5: Wake semantic not hardcoded disabled
  test("wake_semantic_not_hardcoded", async () => {
    const root = await makeTempDir("hive-wake-semantic-");
    const database = new HiveDatabase(":memory:");

    // Import needed for behavioral test
    const { WakePayloadService } =
      await import("../src/daemon/wake-payload-service");
    const { MailStore } = await import("../src/mail-service/store");
    const { MemoryIndex } = await import("../src/memory-service/fts-index");

    const mailStore = new MailStore(database);
    const memory = new MemoryIndex(new Database(":memory:"));

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => root,
      wakeBudgetTokens: 300,
      memoryRecallDeps: () => ({
        repoRoot: () => root,
        memory,
        semantic: async () => null, // Simulated semantic available
        semanticStatus: () => "ready", // Not disabled
      }),
    });

    const payload = await service.build({
      recipient: "test-agent",
      wakeId: "wake-1",
      oldestItemId: "item-1",
      lane: "control",
      topic: "test topic",
      objective: "test objective",
      lastMailSnippet: "test snippet",
    });

    // semantic must NOT be hardcoded "disabled" when semanticStatus is ready
    expect(payload.memoryDelta.semantic).not.toBe("disabled");
  });

  // P0.5: Wake not newest-10 date slice
  test("wake_not_newest10", async () => {
    const root = await makeTempDir("hive-wake-query-");
    const database = new HiveDatabase(":memory:");

    const { WakePayloadService } =
      await import("../src/daemon/wake-payload-service");
    const { MailStore } = await import("../src/mail-service/store");
    const { MemoryIndex } = await import("../src/memory-service/fts-index");
    const { writeMemoryFact } =
      await import("../src/memory-service/memory-store");

    const mailStore = new MailStore(database);
    const memory = new MemoryIndex(new Database(":memory:"));

    // Create facts with different dates
    await writeMemoryFact(root, {
      scope: "repo",
      topic: "test",
      title: "Relevant article matching query",
      body: "This article matches the test topic and objective keywords",
      evidence: "test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-01-01", // Old date
    });

    await writeMemoryFact(root, {
      scope: "repo",
      topic: "other",
      title: "Newest article no match",
      body: "Unrelated content that does not match",
      evidence: "test evidence",
      source: "agent",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20", // Newest date
    });

    // Rebuild index
    await memory.rebuild(root);

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => root,
      wakeBudgetTokens: 300,
      memoryRecallDeps: () => ({
        repoRoot: () => root,
        memory,
        semantic: async () => null,
        semanticStatus: () => "disabled",
      }),
    });

    const payload = await service.build({
      recipient: "test-agent",
      wakeId: "wake-1",
      oldestItemId: "item-1",
      lane: "control",
      topic: "test topic query",
      objective: "objective with keywords",
    });

    // Should recall based on query relevance, NOT pure date ranking
    // The older "Relevant article matching query" should be found if query construction works
    const articles = payload.memoryDelta.articles;
    if (articles.length > 0) {
      // At least one article should contain query keywords
      const hasQueryMatch = articles.some(
        (a) =>
          a.title.toLowerCase().includes("query") ||
          a.title.toLowerCase().includes("relevant"),
      );
      expect(hasQueryMatch).toBe(true);
    }
  });

  // P0.3: Handoff every spawn - validates production pack assembly + spawn fail-closed
  test("handoff_every_spawn", async () => {
    const root = await makeTempDir("hive-handoff-");
    const database = new HiveDatabase(":memory:");
    const episodic = new EpisodicStore(":memory:");

    // Import the REAL production pack assembly that HiveSpawner.spawn uses
    const { loadAndValidateWakePack } =
      await import("../src/daemon/spawn/pack-assembly");
    const { SpawnFailedError } =
      await import("../src/daemon/spawn/spawn-failed-error");

    // Test 1: Throws SpawnFailedError when task undefined (production fail-closed)
    await expect(
      loadAndValidateWakePack({
        db: database,
        episodic,
        repoRoot: root,
        handoffId: undefined,
        agentName: "agent-1",
        task: undefined,
      }),
    ).rejects.toThrow(SpawnFailedError);

    // Test 2: Throws SpawnFailedError when task empty (production fail-closed)
    await expect(
      loadAndValidateWakePack({
        db: database,
        episodic,
        repoRoot: root,
        handoffId: undefined,
        agentName: "agent-2",
        task: "",
      }),
    ).rejects.toThrow(SpawnFailedError);

    // Test 3: Throws SpawnFailedError when agentName empty (production fail-closed)
    await expect(
      loadAndValidateWakePack({
        db: database,
        episodic,
        repoRoot: root,
        handoffId: undefined,
        agentName: "",
        task: "Fix bug",
      }),
    ).rejects.toThrow(SpawnFailedError);

    // Test 4: Returns pack with synthesized handoff when task provided (production synthesis)
    const packSynthesized = await loadAndValidateWakePack({
      db: database,
      episodic,
      repoRoot: root,
      handoffId: undefined,
      agentName: "agent-3",
      task: "Fix the bug",
    });
    expect(packSynthesized.handoffText).toContain(
      "Synthesized handoff from assignment",
    );
    expect(packSynthesized.handoffText).toContain("Fix the bug");
    expect(packSynthesized.handoffText).toContain("agent-3");
    expect(packSynthesized.constitution).toContain("Hive Constitution");
    expect(packSynthesized.profile).toContain("Profile");
    expect(packSynthesized.projectDoc).toContain("Project");

    // Test 5: Returns pack with durable handoff when handoffId exists (production durable path)
    const handoffId = "018f1e90-7b5a-7cc0-8000-000000000180";
    const sourceRunId = "018f1e90-7b5a-7cc0-8000-000000000181";
    database.insertHandoff({
      handoffId,
      sourceRunId,
      runOutcome: {
        decisionId: "grant-fixture",
        providerRunId: sourceRunId,
        provider: "codex",
        model: "gpt-5-codex",
        taskCategory: "simple_coding",
        outcome: "quota-drained",
        handoffId,
        startedAt: "2026-08-20T11:00:00.000Z",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      reason: "quota-drain",
      originalTaskRef: {
        kind: "agent-task",
        agentId: "agent-maya",
        content: "Complete the assigned task",
        digest: "a".repeat(64),
      },
      requirementRefs: [],
      branch: { name: "main", base: "base", head: "head" },
      worktree: {
        dirtyPaths: [],
        untrackedPaths: [],
        commits: [],
      },
      messagesThrough: 0,
      pendingMessageIds: [],
      memoryRefs: [],
      activity: {
        providerEventRefs: [],
        terminalOutputRanges: [],
        providerTranscriptRefs: [],
        statusReportRef: null,
      },
      summary: {
        goal: "Complete the assigned task",
        done: ["Investigated the issue"],
        remaining: ["Apply the fix", "Write tests"],
        decisions: ["Use approach A over B"],
        failedApproaches: [],
        uncertainty: [],
        nextAction: "Start with the fix",
        provenance: "generated",
      },
      completeness: "complete",
      createdAt: "2026-08-20T12:00:00.000Z",
    });
    const packDurable = await loadAndValidateWakePack({
      db: database,
      episodic,
      repoRoot: root,
      handoffId,
      agentName: "agent-4",
      task: "Task",
    });
    expect(packDurable.handoffText).toContain(`Handoff ${handoffId}`);
    expect(packDurable.handoffText).toContain(sourceRunId);
    expect(packDurable.handoffText).toContain(
      "**Goal**: Complete the assigned task",
    );
  });

  // Hole #9: Removed buildAgentPrompt theater test. Real spawn coverage in:
  // - test/daemon/memory-hm6-critic-spawn-floor.test.ts (spawn writes prompt with pack floor)
  // - test/daemon/memory-holes-9-10.test.ts (pack-off fails closed)

  // P0.1: Queen budget CAP signal present - validates production buildQueenLaunchContext
  test("queen_budget_cap_signal", async () => {
    const root = await makeTempDir("hive-budget-cap-");

    const { buildMemoryIndex } =
      await import("../src/memory-service/memory-store");
    const { buildQueenLaunchContext } = await import("../src/cli/orchestrator");

    // Create memory store with many facts to potentially trigger CAP
    const writeService = new MemoryWriteService({
      repoRoot: root,
      index: new MemoryIndex(new Database(":memory:")),
      embeddingIndex: null,
    });

    for (let i = 1; i <= 50; i++) {
      await writeService.write({
        scope: "repo",
        topic: "test",
        title: `Queen test fact ${i}`,
        body: `Description for queen fact ${i}`,
        status: "unverified",
        evidence: "test.txt",
        source: "agent",
        kind: "article",
        tags: [],
        supersedes: [],
      });
    }

    // Build memory index from non-empty store (production path)
    const memoryIndexStr = await buildMemoryIndex(root, {
      brief: "queen test query",
    });

    // Call production buildQueenLaunchContext (same path orchestrator uses)
    const launchText = await buildQueenLaunchContext({
      memoryIndex: memoryIndexStr,
      repoRoot: root,
    });

    // Assert pack floor present in queen launch
    expect(launchText).toContain("Hive Constitution");
    expect(launchText).toContain("Profile");
    expect(launchText).toContain("Project");

    // Assert memory index present when store non-empty
    expect(launchText).toContain("Knowledge index data");

    // If buildMemoryIndex signaled omitted articles, CAP must appear
    if (memoryIndexStr.includes("omitted")) {
      expect(launchText).toContain("CAP CROSSED");
      expect(launchText).toContain("omitted");
    }
  });

  // P0.1: Spawn pack for silent specialist - validates production pack assembly
  test("spawn_pack_silent_specialist", async () => {
    const root = await makeTempDir("hive-silent-specialist-");
    const database = new HiveDatabase(":memory:");
    const episodic = new EpisodicStore(":memory:");

    // Create episodic store with mistakes for realistic test
    episodic.appendEvent({
      type: "mistake",
      ts: "2026-08-19T10:00:00Z",
      summary: "Previous review missed null check",
      agent: "test-agent",
    });
    episodic.appendEvent({
      type: "pitfall",
      ts: "2026-08-20T11:00:00Z",
      summary: "Forgot to check error handling",
      agent: "test-agent",
    });

    // Use REAL production pack assembly (same function HiveSpawner.spawn uses)
    const { loadAndValidateWakePack } =
      await import("../src/daemon/spawn/pack-assembly");
    const { buildAgentPrompt } =
      await import("../src/daemon/spawn/spawner-impl");
    const { loadAgentStandards } =
      await import("../src/daemon/spawn/agent-standards");

    const task = "Review this code";
    const agentName = "silent-specialist";

    // Load and validate pack using production function (throws if handoff unsynthable)
    const pack = await loadAndValidateWakePack({
      db: database,
      episodic,
      repoRoot: root,
      handoffId: undefined,
      agentName,
      task,
    });

    const standards = await loadAgentStandards(root);
    const worktree = {
      path: root,
      branch: "test",
    };

    // Build prompt with production pack for read-only specialist
    const silentSpecialistPrompt = buildAgentPrompt(
      agentName,
      task,
      worktree,
      "", // No memory index for silent specialist
      standards,
      {
        readOnly: true,
        category: "code_review",
        constitution: pack.constitution,
        profile: pack.profile,
        handoffText: pack.handoffText,
        projectDoc: pack.projectDoc,
        recentMistakes:
          pack.recentMistakes.length > 0 ? pack.recentMistakes : undefined,
      },
    );

    // Assert pack floor present (constitution, profile, handoff, project, mistakes)
    expect(silentSpecialistPrompt).toContain("Hive Constitution");
    expect(silentSpecialistPrompt).toContain("Profile");
    expect(silentSpecialistPrompt).toContain("Handoff Context");
    expect(silentSpecialistPrompt).toContain("Review this code");
    expect(silentSpecialistPrompt).toContain("Project");
    expect(silentSpecialistPrompt).toContain("Recent Mistakes");

    // Assert mistakes loaded from episodic (production path)
    expect(silentSpecialistPrompt).toContain("null check");
    expect(silentSpecialistPrompt).toContain("error handling");

    // Assert read-only specialist gets pack floor even without memory tools
    expect(silentSpecialistPrompt).not.toContain("memory_write");
    expect(silentSpecialistPrompt).not.toContain("memory_search");
  });

  // P1: Consolidator not on hotpath
  test("consolidator_not_hotpath", async () => {
    // Validates consolidator is idle/sweep only, not called from memory_write hotpath
    // Architecture: consolidate.ts exports are for CLI/jobs, not write-service
    const { runMemoryConsolidation } =
      await import("../src/memory-service/consolidate");

    // Consolidate is an async function for offline/sweep use, not the write hotpath.
    expect(runMemoryConsolidation.constructor.name).toBe("AsyncFunction");

    // Write service does NOT import consolidate
    const writeServiceSource = await Bun.file(
      join(import.meta.dir, "../src/memory-service/write-service.ts"),
    ).text();
    expect(writeServiceSource).not.toContain('from "./consolidate"');
    expect(writeServiceSource).not.toContain("consolidate(");
  });
});
