// HiveMemory HM-2 WP4: the deterministic session-digest compiler, rolling
// re-synthesis, the drift audit, and retention-reference compatibility.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditDigestDrift,
  compileDigest,
  runMemoryDigest,
} from "../../src/daemon/episodic-digest";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import { runRetentionSweep } from "../../src/daemon/memory-retention";
import type { MemoryRetentionConfig } from "../../src/schemas";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T10:05:00.000Z";
const T2 = "2026-07-22T10:10:00.000Z";
const T3 = "2026-07-22T10:15:00.000Z";
const T4 = "2026-07-22T10:20:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function seededStore(): {
  store: EpisodicStore;
  ids: Record<string, number>;
} {
  const store = new EpisodicStore(":memory:");
  const ids: Record<string, number> = {};
  ids["status"] = store.appendEvent({
    ts: T0,
    agent: "agent-maya",
    type: "agent.status-reported",
    summary: `Implementing the digest compiler in src/daemon/episodic-digest.ts`,
  }).id;
  ids["error"] = store.appendEvent({
    ts: T1,
    agent: "agent-maya",
    type: "agent.status-reported",
    summary: `Typecheck failed: TypeError: boom while compiling; exit code 2`,
  }).id;
  ids["landed"] = store.appendEvent({
    ts: T2,
    agent: "agent-maya",
    type: "agent.branch-landed",
    summary: `Landed 3 commits on main, tip ${SHA}`,
    provenance: { seq: 7, source: "test" },
  }).id;
  ids["otherAgent"] = store.appendEvent({
    ts: T3,
    agent: "agent-lena",
    type: "agent.status-reported",
    summary: "Unrelated agent doing unrelated work",
  }).id;
  return { store, ids };
}

describe("compileDigest", () => {
  test("folds an agent's events into provenance-bearing sections", () => {
    const { store, ids } = seededStore();
    try {
      const digest = compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T4,
      });
      expect(digest).not.toBeNull();
      const body = digest!.body;

      // Header: hint-not-authority label and the event range.
      expect(body).toContain("# Session digest — agent-maya / session session-1");
      expect(body).toContain("hint-not-authority");
      expect(body).toContain(`${T0} → ${T2}`);

      // Timeline: every listed line carries its event-id pointer.
      expect(body).toContain("## Timeline");
      expect(body).toContain(`- [e${ids["status"]}] ${T0}`);
      expect(body).toContain(`- [e${ids["landed"]}] ${T2}`);

      // Outcomes: the landing event, with its pointer.
      const outcomes = body.split("## Outcomes")[1]!.split("##")[0]!;
      expect(outcomes).toContain(`[e${ids["landed"]}]`);
      expect(outcomes).not.toContain(`[e${ids["error"]}]`);

      // Failures: the error event, with its pointer (WP5 harvester input).
      const failures = body.split("## Failures")[1]!.split("##")[0]!;
      expect(failures).toContain(`[e${ids["error"]}]`);
      expect(failures).toContain("TypeError");
      expect(failures).not.toContain(`[e${ids["landed"]}]`);

      // Open threads: the latest non-outcome non-failure status.
      const threads = body.split("## Open threads")[1]!.split("##")[0]!;
      expect(threads).toContain(`[e${ids["status"]}]`);

      // The other agent's events are not folded in.
      expect(body).not.toContain(`e${ids["otherAgent"]}`);
      expect(body).not.toContain("Unrelated agent");

      // Persisted provenance is the WP3 retention reference-check shape.
      const provenance = JSON.parse(digest!.provenance) as {
        eventIds: number[];
        sessionId: string;
        agent: string;
      };
      expect(provenance.eventIds).toEqual([
        ids["status"]!,
        ids["error"]!,
        ids["landed"]!,
      ]);
      expect(provenance.sessionId).toBe("session-1");
      expect(provenance.agent).toBe("agent-maya");
    } finally {
      store.close();
    }
  });

  test("extracts SHAs, paths, error strings and exit codes into typed rows", () => {
    const { store, ids } = seededStore();
    try {
      const digest = compileDigest(store, {
        agent: "agent-maya",
        sessionId: null,
        compiledAt: T4,
      })!;
      const table = digest.body.split("## Exact values")[1]!;
      expect(table).toContain(`| sha | \`${SHA}\` | e${ids["landed"]} |`);
      expect(table).toContain(
        `| path | \`src/daemon/episodic-digest.ts\` | e${ids["status"]} |`,
      );
      expect(table).toContain(`| exit-code | \`2\` | e${ids["error"]} |`);
      const errorRow = table.split("\n").find((line) =>
        line.startsWith("| error |")
      );
      expect(errorRow).toContain("TypeError: boom");
      expect(errorRow).toContain(`e${ids["error"]}`);
      expect(table).toContain(`| count | \`3 commits\` | e${ids["landed"]} |`);
    } finally {
      store.close();
    }
  });

  test("returns null when the agent has no events: an empty session earns no digest", () => {
    const store = new EpisodicStore(":memory:");
    try {
      expect(
        compileDigest(store, { agent: "agent-nobody", sessionId: null }),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  test("rolling re-synthesis reflects the delta and replaces the row", () => {
    const { store } = seededStore();
    try {
      const first = compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T3,
      })!;
      expect(first.body).not.toContain("killed");

      const killedId = store.appendEvent({
        ts: T3,
        agent: "agent-maya",
        type: "agent.killed",
        summary: "Killed by operator after landing",
      }).id;
      const second = compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T4,
      })!;

      // The delta is in: the kill event appears in the re-synthesized digest.
      expect(second.body).toContain(`[e${killedId}]`);
      const failures = second.body.split("## Failures")[1]!.split("##")[0]!;
      expect(failures).toContain(`[e${killedId}]`);

      // Replace, not merge: still exactly one row for this agent+session.
      expect(store.digestFor({ agent: "agent-maya", sessionId: "session-1" })!.id)
        .toBe(second.id);
      expect(
        store.digestProvenanceBlobs(),
      ).toHaveLength(1);

      // The drift audit passes on a freshly compiled digest.
      const audit = auditDigestDrift(store, second.id);
      expect(audit.ok).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("auditDigestDrift", () => {
  test("fails on a tampered stored body", async () => {
    const repo = await mkdtemp(join(tmpdir(), "hive-digest-tamper-"));
    try {
      const storePath = join(repo, "episodic.db");
      const store = new EpisodicStore(storePath);
      try {
        store.appendEvent({
          ts: T0,
          agent: "agent-maya",
          type: "agent.status-reported",
          summary: "did some work",
        });
        const digest = compileDigest(store, {
          agent: "agent-maya",
          sessionId: "session-1",
          compiledAt: T4,
        })!;
        // Tamper with the stored body out from under the compiler (there is
        // deliberately no digest-mutation API; go through the file).
        const tamper = new Database(storePath);
        tamper.query("UPDATE digests SET body = ? WHERE id = ?")
          .run("agent-authored fiction", digest.id);
        tamper.close();

        const audit = auditDigestDrift(store, digest.id);
        expect(audit.ok).toBe(false);
        expect(audit.detail).toContain("does not match a fresh recompile");
      } finally {
        store.close();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("fails when a referenced source event is gone", () => {
    const { store } = seededStore();
    try {
      const digest = compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T4,
      })!;
      // A retention pass that wrongly ignores the digest's references.
      store.sweepEvents("2026-07-23T00:00:00.000Z", new Set());

      const audit = auditDigestDrift(store, digest.id);
      expect(audit.ok).toBe(false);
      expect(audit.detail).toContain("no longer in the store");
    } finally {
      store.close();
    }
  });
});

describe("retention compatibility (WP3 reference check)", () => {
  test("a digest's event pointers protect its source rows from the sweep", async () => {
    const repo = await mkdtemp(join(tmpdir(), "hive-digest-retention-"));
    try {
      const store = new EpisodicStore(join(repo, "episodic.db"));
      try {
        const old = {
          ts: "2026-05-01T00:00:00.000Z",
          agent: "agent-maya",
        };
        const referenced = store.appendEvent({
          ...old,
          type: "agent.branch-landed",
          summary: "old landing the digest still cites",
        });
        // Aged and under a different agent, so no digest of maya's cites it.
        store.appendEvent({
          ts: old.ts,
          agent: "agent-lena",
          type: "agent.status-reported",
          summary: "old and unreferenced",
        });
        compileDigest(store, {
          agent: "agent-maya",
          sessionId: "session-old",
          compiledAt: "2026-05-02T00:00:00.000Z",
        });

        const config: MemoryRetentionConfig = {
          events_hot_days: 30,
          facts_retention: "forever",
          digests_retention: "forever",
          stale_after_days: 90,
          sweep_interval_hours: 24,
        };
        const report = await runRetentionSweep({
          episodic: store,
          repoRoot: repo,
          config,
          now: new Date("2026-07-22T00:00:00.000Z"),
        });

        // Both events are aged; only the digest-referenced one survives.
        expect(report.eventsDeleted).toBe(1);
        expect(store.eventsFor().map((event) => event.id)).toEqual([
          referenced.id,
        ]);
      } finally {
        store.close();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("runMemoryDigest", () => {
  const noResolution = (name: string) => name;

  test("absent without a store; empty when nothing matches", () => {
    const absent = runMemoryDigest(
      { episodic: null, resolveAgentId: noResolution },
      { digestId: 1 },
    );
    expect(absent.state).toBe("absent");
    expect(absent.detail).toContain("episodic");

    const { store } = seededStore();
    try {
      const empty = runMemoryDigest(
        { episodic: store, resolveAgentId: noResolution },
        { digestId: 99 },
      );
      expect(empty.state).toBe("empty");
      expect(empty.detail).toContain("digest with id 99");
      // Positive control: a digest exists, and the reader can see it.
      compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T4,
      });
      const ok = runMemoryDigest(
        { episodic: store, resolveAgentId: noResolution },
        { agent: "agent-maya" },
      );
      expect(ok.state).toBe("ok");
      expect(ok.digest!.sessionId).toBe("session-1");
      expect(ok.digest!.body).toContain("hint-not-authority");
      expect(ok.truncated).toBe(false);
    } finally {
      store.close();
    }
  });

  test("drill-down returns the exact source event rows behind a pointer", () => {
    const { store, ids } = seededStore();
    try {
      const digest = compileDigest(store, {
        agent: "agent-maya",
        sessionId: "session-1",
        compiledAt: T4,
      })!;
      const result = runMemoryDigest(
        { episodic: store, resolveAgentId: noResolution },
        { digestId: digest.id, eventId: ids["landed"]! },
      );
      expect(result.state).toBe("ok");
      expect(result.digest!.id).toBe(digest.id);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        id: ids["landed"],
        type: "agent.branch-landed",
      });
      expect(result.events[0]!.summary).toContain(SHA);
      // The drill-down row carries its own provenance JSON (authority).
      expect(JSON.parse(result.events[0]!.provenance)).toMatchObject({
        seq: 7,
      });
    } finally {
      store.close();
    }
  });

  test("the token ceiling is clamp-only and over-budget bodies truncate loudly", () => {
    const store = new EpisodicStore(":memory:");
    try {
      for (let index = 0; index < 40; index += 1) {
        store.appendEvent({
          ts: T0,
          agent: "agent-maya",
          type: "agent.status-reported",
          // Failure-classified, so every event lands in the (unbounded)
          // Failures section and the body far exceeds the ceiling.
          summary: `error ${index}: ${"n".repeat(200)}`,
        });
      }
      const digest = compileDigest(store, {
        agent: "agent-maya",
        sessionId: null,
        compiledAt: T4,
      })!;
      expect(digest.body.length).toBeGreaterThan(1200 * 4);

      const inflated = runMemoryDigest(
        { episodic: store, resolveAgentId: noResolution },
        { digestId: digest.id, budget: 999_999 },
      );
      expect(inflated.budget).toBe(1200);
      expect(inflated.truncated).toBe(true);
      expect(inflated.digest!.body).toContain("[truncated");
      expect(inflated.tokens).toBeLessThanOrEqual(inflated.budget);
    } finally {
      store.close();
    }
  });
});
