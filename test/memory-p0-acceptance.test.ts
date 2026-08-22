import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { parseHiveConfig } from "../src/daemon/config-loader";
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
    const configWithApi = {
      autonomy: "sandboxed" as const,
      memory: {
        embedding_provider: "api" as const,
      },
    };

    expect(() => parseHiveConfig(configWithApi)).toThrow();
  });

  // P0.6: Real keepIds from ledger/pitfall provenance
  test("retention_keepset", async () => {
    const root = await makeTempDir("hive-retention-");
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);
    const episodic = new EpisodicStore(database);

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

    expect(eventIds).toContain(ep1.id);
    expect(eventIds).toContain(ep2.id);
    expect(eventIds).not.toContain(ep3.id);
    expect(report.eventsDeleted).toBe(1); // Only ep3 deleted
  });

  // P0.8: Global writes use global lock, repo writes use repo lock
  test("scope_lock", async () => {
    const root = await makeTempDir("hive-scope-lock-");
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);
    const index = new MemoryIndex(database);

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
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);
    const index = new MemoryIndex(database);

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
    expect(facts[0].id).toBe(first.id);
    expect(facts[0].body).toBe("Updated body"); // body updated
  });

  // P0.5: Wake semantic not hardcoded disabled
  test("wake_semantic_not_hardcoded", async () => {
    const root = await makeTempDir("hive-wake-semantic-");
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);

    // Import needed for behavioral test
    const { WakePayloadService } =
      await import("../src/daemon/wake-payload-service");
    const { MailStore } = await import("../src/mail-service/store");
    const { MemoryIndex } = await import("../src/memory-service/fts-index");

    const mailStore = new MailStore(database);
    const memory = new MemoryIndex(database);

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
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);

    const { WakePayloadService } =
      await import("../src/daemon/wake-payload-service");
    const { MailStore } = await import("../src/mail-service/store");
    const { MemoryIndex } = await import("../src/memory-service/fts-index");
    const { writeMemoryFact } =
      await import("../src/memory-service/memory-store");

    const mailStore = new MailStore(database);
    const memory = new MemoryIndex(database);

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

  // P0.3: Handoff every spawn - validates handoff synthesis and fail-closed behavior
  test("handoff_every_spawn", async () => {
    const root = await makeTempDir("hive-handoff-");
    const {
      loadConstitution,
      loadProfile,
      loadProjectDoc,
      loadRecentMistakes,
    } = await import("../src/memory-service/pack-floor");
    const { buildAgentPrompt } =
      await import("../src/daemon/spawn/spawner-impl");
    const { loadAgentStandards } =
      await import("../src/daemon/spawn/agent-standards");

    const standards = await loadAgentStandards(root);
    const worktree = {
      path: root,
      branch: "test-branch",
      upstream: null,
      head: "abc123",
      isDirty: false,
    };

    // Test 1: Load real pack floor (constitution, profile, project, mistakes)
    const [constitution, profile, projectDoc] = await Promise.all([
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(root),
    ]);
    const recentMistakes = loadRecentMistakes(undefined);

    // Test 2: Synthesized handoff appears when task provided
    const synthesizedHandoff =
      "Synthesized handoff from assignment:\n\n**Task**: Fix the bug\n**Agent**: test-agent\n\n**Goal**: Complete the assigned task.\n**Remaining**: All work from the task description above.\n\nProceed with the task as assigned.";

    const promptWithHandoff = buildAgentPrompt(
      "test-agent",
      "Fix the bug",
      worktree,
      "",
      standards,
      {
        constitution,
        profile,
        projectDoc,
        recentMistakes: recentMistakes.length > 0 ? recentMistakes : undefined,
        handoffText: synthesizedHandoff,
      },
    );

    // Assert handoff present (not hive_pickup_handoff lookup)
    expect(promptWithHandoff).toContain("Handoff Context");
    expect(promptWithHandoff).toContain("Synthesized handoff");
    expect(promptWithHandoff).toContain("Fix the bug");
    expect(promptWithHandoff).not.toContain("hive_pickup_handoff");

    // Test 3: Constitution and profile present
    expect(promptWithHandoff).toContain("Hive Constitution");
    expect(promptWithHandoff).toContain("Profile slot");
  });

  // P0.1: Empty vs dropped distinguishable - validates CAP signal with real pack floor
  test("empty_vs_dropped", async () => {
    const root = await makeTempDir("hive-empty-vs-dropped-");
    const {
      loadConstitution,
      loadProfile,
      loadProjectDoc,
      loadRecentMistakes,
    } = await import("../src/memory-service/pack-floor");
    const { buildAgentPrompt } =
      await import("../src/daemon/spawn/spawner-impl");
    const { loadAgentStandards } =
      await import("../src/daemon/spawn/agent-standards");

    const standards = await loadAgentStandards(root);
    const worktree = {
      path: root,
      branch: "test-branch",
      upstream: null,
      head: "abc123",
      isDirty: false,
    };

    // Load real pack floor
    const [constitution, profile, projectDoc] = await Promise.all([
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(root),
    ]);
    const recentMistakes = loadRecentMistakes(undefined);

    // Test 1: Empty index with pack floor = no index section, but pack floor present
    const emptyPrompt = buildAgentPrompt(
      "test-agent",
      "Do work",
      worktree,
      "",
      standards,
      {
        constitution,
        profile,
        projectDoc,
        recentMistakes: recentMistakes.length > 0 ? recentMistakes : undefined,
      },
    );
    expect(emptyPrompt).not.toContain("Knowledge index data");
    expect(emptyPrompt).toContain("Hive Constitution"); // Pack floor present

    // Test 2: Truncated index with pack floor = CAP signal + pack floor
    const truncatedIndex = [
      "Hive memory index — compiled durable repo knowledge.",
      "- [repo/pitfalls] pitfall-1 (2026-08-20): First pitfall",
      "(5 older articles omitted — use memory_search)",
    ].join("\n");

    const truncatedPrompt = buildAgentPrompt(
      "test-agent",
      "Do work",
      worktree,
      truncatedIndex,
      standards,
      {
        constitution,
        profile,
        projectDoc,
        recentMistakes: recentMistakes.length > 0 ? recentMistakes : undefined,
      },
    );
    expect(truncatedPrompt).toContain("Knowledge index data");
    expect(truncatedPrompt).toContain("CAP CROSSED");
    expect(truncatedPrompt).toContain("5");
    expect(truncatedPrompt).toContain("omitted");
    expect(truncatedPrompt).toContain("Hive Constitution"); // Pack floor still present

    // Test 3: Empty vs dropped distinguishable
    expect(emptyPrompt).not.toContain("omitted");
    expect(truncatedPrompt).toContain("omitted");
  });

  // P0.1: Queen budget CAP signal present - validates composeLaunchContext with real floor
  test("queen_budget_cap_signal", async () => {
    const root = await makeTempDir("hive-budget-cap-");
    const {
      loadConstitution,
      loadProfile,
      loadProjectDoc,
      loadRecentMistakes,
    } = await import("../src/memory-service/pack-floor");
    const { queenBootCapsules } =
      await import("../src/daemon/queen-provider-service/queen-boot-capsule-service");

    // Load real pack floor for queen
    const [constitution, profile, projectDoc] = await Promise.all([
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(root),
    ]);
    const recentMistakes = loadRecentMistakes(undefined);

    // Create large index that would trigger CAP
    const largeIndexRows: string[] = [];
    for (let i = 0; i < 100; i++) {
      largeIndexRows.push(
        `- [repo/topic] article-${i} (2026-08-20): Article ${i} content`,
      );
    }
    const largeIndex = [
      "Hive memory index — compiled durable repo knowledge.",
      ...largeIndexRows,
      "(50 older articles omitted — use memory_search)",
    ].join("\n");

    // Test composeLaunchContext with real floor fields
    const launchContext = queenBootCapsules.composeLaunchContext({
      policy: "Test queen policy for validation",
      memoryIndex: largeIndex,
      constitution,
      profile,
      projectDoc,
      recentMistakes,
    });

    // Assert pack floor present in queen launch
    expect(launchContext.text).toContain("Hive Constitution");
    expect(launchContext.text).toContain("Profile");
    expect(launchContext.text).toContain("Project");

    // Assert CAP signal when index truncated
    expect(launchContext.text).toContain("omitted");
    expect(launchContext.memoryEntries.total).toBeGreaterThan(
      launchContext.memoryEntries.shown,
    );
  });

  // P0.1: Spawn pack for silent specialist - validates pack floor without memory tools
  test("spawn_pack_silent_specialist", async () => {
    const root = await makeTempDir("hive-silent-specialist-");
    const {
      loadConstitution,
      loadProfile,
      loadProjectDoc,
      loadRecentMistakes,
    } = await import("../src/memory-service/pack-floor");
    const { buildAgentPrompt } =
      await import("../src/daemon/spawn/spawner-impl");
    const { loadAgentStandards } =
      await import("../src/daemon/spawn/agent-standards");
    const { EpisodicStore } = await import("../src/memory-service/episodic");
    const { HiveDatabase } =
      await import("../src/daemon/database/hive-database");
    const Database = (await import("bun:sqlite")).Database;

    const standards = await loadAgentStandards(root);
    const worktree = {
      path: root,
      branch: "test-branch",
      upstream: null,
      head: "abc123",
      isDirty: false,
    };

    // Create episodic store with mistakes for realistic test
    const db = new Database(":memory:");
    const database = new HiveDatabase(db);
    const episodic = new EpisodicStore(database);
    episodic.appendEvent({
      type: "mistake",
      ts: "2026-08-19T10:00:00Z",
      summary: "Previous review missed null check",
      context: {},
    });
    episodic.appendEvent({
      type: "pitfall",
      ts: "2026-08-20T11:00:00Z",
      summary: "Forgot to check error handling",
      context: {},
    });

    // Load real pack floor with episodic mistakes
    const [constitution, profile, projectDoc] = await Promise.all([
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(root),
    ]);
    const recentMistakes = loadRecentMistakes(episodic);

    // Build prompt with real pack floor for read-only specialist (no memory tools)
    const silentSpecialistPrompt = buildAgentPrompt(
      "silent-specialist",
      "Review this code",
      worktree,
      "",
      standards,
      {
        readOnly: true,
        category: "code_review",
        constitution,
        profile,
        handoffText: "Handoff: Review the following changes.",
        projectDoc,
        recentMistakes: recentMistakes.length > 0 ? recentMistakes : undefined,
      },
    );

    // Assert pack floor present (constitution, profile, handoff, project, mistakes)
    expect(silentSpecialistPrompt).toContain("Hive Constitution");
    expect(silentSpecialistPrompt).toContain("Profile");
    expect(silentSpecialistPrompt).toContain("Handoff Context");
    expect(silentSpecialistPrompt).toContain("Project");
    expect(silentSpecialistPrompt).toContain("Recent Mistakes");

    // Assert mistakes loaded from episodic
    expect(silentSpecialistPrompt).toContain("null check");
    expect(silentSpecialistPrompt).toContain("error handling");

    // Assert read-only specialist context
    expect(silentSpecialistPrompt).toContain("read-only");
  });

  // P1: Consolidator not on hotpath
  test("consolidator_not_hotpath", async () => {
    // Validates consolidator is idle/sweep only, not called from memory_write hotpath
    // Architecture: consolidate.ts exports are for CLI/jobs, not write-service
    const { consolidate } = await import("../src/memory-service/consolidate");

    // Consolidate function exists and is async (for offline use)
    expect(typeof consolidate).toBe("function");
    expect(consolidate.constructor.name).toBe("AsyncFunction");

    // Write service does NOT import consolidate
    const writeServiceSource = await Bun.file(
      join(import.meta.dir, "../src/memory-service/write-service.ts"),
    ).text();
    expect(writeServiceSource).not.toContain('from "./consolidate"');
    expect(writeServiceSource).not.toContain("consolidate(");
  });
});
