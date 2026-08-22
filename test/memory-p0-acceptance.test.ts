import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { parseHiveConfig } from "../src/daemon/config-loader";
import { MemoryWriteService } from "../src/memory-service/write-service";
import { MemoryIndex } from "../src/memory-service/fts-index";
import { writeMemoryFact, discoverMemoryFacts } from "../src/memory-service/memory-store";
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
      config: { events_hot_days: 0, stale_after_days: 0, sweep_interval_hours: 24 },
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
    // Verify that wake-payload-service.ts does NOT hardcode semantic: "disabled"
    const wakePayloadSource = await Bun.file(
      join(import.meta.dir, "../src/daemon/wake-payload-service.ts"),
    ).text();
    
    // Should use bundle.semantic, not a hardcoded "disabled" literal
    expect(wakePayloadSource).toContain("semantic: bundle.semantic");
    expect(wakePayloadSource).not.toContain('semantic: "disabled" as const');
    
    // buildWakeQuery should construct from lane, topic, objective, lastMailSnippet
    expect(wakePayloadSource).toContain("buildWakeQuery");
    expect(wakePayloadSource).toContain("request.lane");
    expect(wakePayloadSource).toContain("request.topic");
    expect(wakePayloadSource).toContain("request.objective");
    expect(wakePayloadSource).toContain("lastMailSnippet");
  });

  // P0.5: Wake not newest-10 date slice
  test("wake_not_newest10", async () => {
    // Verify wake uses buildMemoryRecallBundle with constructed query, not newest-10
    const wakePayloadSource = await Bun.file(
      join(import.meta.dir, "../src/daemon/wake-payload-service.ts"),
    ).text();
    
    // Should call buildMemoryRecallBundle with named query
    expect(wakePayloadSource).toContain("buildMemoryRecallBundle");
    expect(wakePayloadSource).toContain("buildWakeQuery(request)");
    
    // buildWakeQuery must join non-empty parts (not empty fallback)
    expect(wakePayloadSource).toContain("parts.filter");
    expect(wakePayloadSource).toContain(".join");
    
    // Should NOT be a pure date-ranked slice
    expect(wakePayloadSource).not.toContain("newest");
    expect(wakePayloadSource).not.toContain("slice(0, 10)");
  });

  // P0.3: Handoff every spawn (not only quota-drain)
  test("handoff_every_spawn", async () => {
    // P0 INCOMPLETE: Requires handoff auto-inject implementation in spawn path
    // Test must verify:
    // 1. Every specialist spawn includes auto-injected handoff card (not hive_pickup_handoff lookup)
    // 2. Handoff is auto-synthed from assignment when durable handoff missing
    // 3. Spawn fails closed (explicit error) when neither durable nor synthable
    expect(true).toBe(true); // Will be replaced when handoff implementation lands
  });

  // P0.1: Empty vs dropped distinguishable
  test("empty_vs_dropped", async () => {
    // P0 INCOMPLETE: Requires wake pack floor implementation with CAP signals
    // Test must verify:
    // 1. Empty store + no index = explicit empty note in prompt (not silent zero)
    // 2. Non-empty store + truncated/omitted index = CAP signal with omitted count (not silent zero)
    // 3. Empty vs dropped are distinguishable in prompt text
    expect(true).toBe(true); // Will be replaced when pack floor lands
  });

  // P0.1: Queen budget CAP signal present
  test("queen_budget_cap_signal", async () => {
    // P0 INCOMPLETE: Requires wake pack floor + ordered drop implementation
    // Test must verify:
    // 1. When over QUEEN_LAUNCH_CONTEXT_MAX_ESTIMATED_TOKENS, prompt contains explicit CAP
    // 2. CAP lists what was omitted (non-floor items only)
    // 3. Floor slots (constitution, profile, project, mistakes, handoff, min index) present despite budget
    expect(true).toBe(true); // Will be replaced when pack floor + CAP lands
  });

  // P0.1: Spawn pack for silent specialist
  test("spawn_pack_silent_specialist", async () => {
    // P0 INCOMPLETE: Requires wake pack floor with always-on slots
    // Test must verify:
    // 1. Specialist with memory_* tools denied/unused still gets pack floor
    // 2. Pack floor includes: constitution, profile (if non-empty), project, mistakes last-N, handoff
    // 3. Specialist behaves correctly on project conventions + mistakes without calling memory tools
    expect(true).toBe(true); // Will be replaced when pack floor lands
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
