// The daemon-owned memory contracts: overview, library, recall preview, and
// the maintenance projection. These pin the properties the prototypes under
// prototypes/memory/ established, so the ones that matter cannot regress
// silently once the prototypes are gone.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { buildMemoryListPage } from "../../src/memory-service/library";
import {
  buildMemoryMaintenance,
  buildMemoryOverview,
  type MemoryProjectionDeps,
} from "../../src/memory-service/projections";
import { buildMemoryRecallBundle } from "../../src/memory-service/recall";
import { buildMemoryRecallPreview } from "../../src/memory-service/recall-preview";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
import {
  MEMORY_PROJECTION_SCHEMA_VERSION,
  type MemoryConfigProjection,
} from "../../src/schemas/memory-projections";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const roots: string[] = [];

// The global wiki resolves under HIVE_HOME at call time, so without this a
// test run would rebuild the user's real global memory index.
const GLOBAL_SANDBOX = await mkdtemp(join(tmpdir(), "hive-memproj-home-"));
roots.push(GLOBAL_SANDBOX);
Bun.env.HIVE_HOME = GLOBAL_SANDBOX;

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const CONFIG: MemoryConfigProjection = {
  revision: "fixture",
  eventsHotDays: 30,
  staleAfterDays: 90,
  sweepIntervalHours: 24,
  wakeBudgetTokens: 300,
  embeddingProvider: "local",
  embeddingModel: "bge-small-en-v1.5",
};

interface Project {
  root: string;
  index: MemoryIndex | null;
  episodic: EpisodicStore | null;
  deps: MemoryProjectionDeps;
}

async function project(
  options: { wireIndex?: boolean; wireEpisodic?: boolean } = {},
): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "hive-memproj-"));
  roots.push(root);
  const index =
    options.wireIndex === false
      ? null
      : new MemoryIndex(new Database(":memory:"));
  const episodic =
    options.wireEpisodic === false
      ? null
      : new EpisodicStore(join(root, "episodic.db"));
  return {
    root,
    index,
    episodic,
    deps: {
      repoRoot: root,
      index,
      episodic,
      embeddings: null,
      embeddingState: () => "disabled",
      config: CONFIG,
    },
  };
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    scope: "repo",
    topic: "terminal",
    title: "Cursor gap recovery",
    body: "Require a covering verified checkpoint; never fabricate continuity.",
    source: "agent",
    evidence: "measured against the running daemon",
    status: "unverified",
    supersedes: [],
    date: "2026-07-26",
    ...overrides,
  } as MemoryWriteInput;
}

async function write(
  target: Project,
  overrides: Partial<MemoryWriteInput> = {},
): Promise<{ id: string }> {
  const written = await writeMemoryFact(target.root, input(overrides));
  target.index?.upsertFact(written);
  return { id: written.id };
}

describe("memory overview", () => {
  test("tells absent from empty from healthy, with a positive control", async () => {
    const bare = await project({ wireIndex: false, wireEpisodic: false });
    const absent = await buildMemoryOverview(bare.deps, []);
    expect(absent.wiki.state).toBe("absent");
    expect(absent.episodic.state).toBe("absent");
    expect(absent.indexes.fts.state).toBe("absent");
    expect(absent.gaps.map((gap) => gap.code)).toContain("wiki-absent");

    const built = await project();
    await mkdir(join(built.root, ".hive", "memory", "wiki"), {
      recursive: true,
    });
    const empty = await buildMemoryOverview(built.deps, []);
    expect(empty.wiki.state).toBe("empty");
    expect(empty.episodic.state).toBe("empty");
    expect(empty.indexes.fts.state).toBe("empty");
    expect(empty.gaps.map((gap) => gap.code)).not.toContain("wiki-absent");

    // Positive control: the same reader reports ok on a populated project, so
    // the two readings above are real answers rather than a blind reader.
    await write(built, { title: "Cursor gap recovery" });
    await write(built, { title: "Never infer continuity", kind: "pitfall" });
    built.episodic?.appendEvent({
      agent: "maya",
      type: "landed",
      summary: "landed",
      provenance: {},
    });
    const healthy = await buildMemoryOverview(built.deps, []);
    expect(healthy.wiki.state).toBe("ok");
    expect(healthy.wiki.articles).toBe(2);
    expect(healthy.wiki.pitfalls).toBe(1);
    expect(healthy.episodic.state).toBe("ok");
  });

  test("a project's repo scope stays its own while global is shared", async () => {
    const one = await project({ wireIndex: false, wireEpisodic: false });
    const two = await project();
    await write(two, { title: "Two's repo article" });
    await write(two, { title: "A shared global article", scope: "global" });

    const overview = await buildMemoryOverview(one.deps, []);
    const repo = overview.wiki.scopes.find((scope) => scope.scope === "repo");
    const global = overview.wiki.scopes.find(
      (scope) => scope.scope === "global",
    );
    // Global scope is the cross-project wiki and is visible to both. What must
    // never happen is another project's repo article counted here.
    expect(repo?.state).toBe("absent");
    expect(repo?.articles).toBe(0);
    expect(global?.articles).toBe(1);
    expect(overview.episodic.state).toBe("absent");
  });
});

describe("the common projection envelope", () => {
  test("all four views carry it, and sourceRevision tracks change only", async () => {
    const target = await project();
    await write(target, { title: "Enveloped" });
    const deps = { repoRoot: target.root, episodic: target.episodic };

    const views = [
      await buildMemoryOverview(target.deps, []),
      await buildMemoryListPage(deps, { limit: 200 }),
      await buildMemoryRecallPreview(
        {
          repoRoot: target.root,
          index: target.index,
          semanticRecall: () => undefined,
          semanticRecallState: () => undefined,
          wakeBudgetTokens: 300,
        },
        { query: "enveloped" },
      ),
      buildMemoryMaintenance(target.deps, { state: "ok", recent: [] }, 0),
    ];
    for (const view of views) {
      expect(view.schemaVersion).toBe(MEMORY_PROJECTION_SCHEMA_VERSION);
      expect(view.freshness).toBe("live");
      expect(view.sourceRevision).toHaveLength(16);
      expect(Date.parse(view.observedAt)).not.toBeNaN();
    }

    // Unchanged stores must produce the same revision, or a client cannot use
    // it to skip work. An observedAt folded into the digest would break this.
    const first = await buildMemoryListPage(deps, { limit: 200 });
    const again = await buildMemoryListPage(deps, { limit: 200 });
    expect(again.sourceRevision).toBe(first.sourceRevision);

    // A real change must move it.
    await write(target, { title: "Enveloped two" });
    const changed = await buildMemoryListPage(deps, { limit: 200 });
    expect(changed.sourceRevision).not.toBe(first.sourceRevision);
  });
});

describe("memory library", () => {
  test("a cursor walk repeats nothing and loses nothing under concurrent writes", async () => {
    const target = await project();
    for (let index = 0; index < 8; index += 1) {
      await write(target, {
        title: `Article ${String(index).padStart(2, "0")}`,
      });
    }
    const deps = { repoRoot: target.root, episodic: target.episodic };
    const before = await buildMemoryListPage(deps, { limit: 200 });
    const beforeKeys = before.items.map((item) => item.key);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await buildMemoryListPage(deps, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.key));
      cursor = page.nextCursor;
      pages += 1;
      // Write on every page: one title sorting behind the cursor, one ahead.
      // The behind-the-cursor write is what breaks an offset-paged list.
      if (pages <= 3) {
        await write(target, { title: `AAA inserted ${pages}` });
        await write(target, { title: `ZZZ inserted ${pages}` });
      }
    } while (cursor !== null && pages < 40);

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    for (const key of beforeKeys) expect(seen).toContain(key);
    expect(seen).toEqual([...seen].sort());
  });

  test("a built-but-empty project reads empty, never absent", async () => {
    // Inferring "there is a store" from "a row came back" reports a freshly
    // initialized project as `absent` rather than `empty` — and a user
    // acting on that reading believes a fresh install is a wiped one.
    const home = await mkdtemp(join(tmpdir(), "hive-memproj-emptyhome-"));
    roots.push(home);
    const previous = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = home;
    try {
      const built = await project({ wireEpisodic: false });
      await mkdir(join(built.root, ".hive", "memory", "wiki"), {
        recursive: true,
      });
      const page = await buildMemoryListPage({
        repoRoot: built.root,
        episodic: null,
      });
      expect(page.state).toBe("empty");
      expect(page.total).toBe(0);
      expect(page.items).toHaveLength(0);

      // Positive control with the same reader: nothing built at all is absent.
      const bare = await project({ wireEpisodic: false });
      expect(
        (await buildMemoryListPage({ repoRoot: bare.root, episodic: null }))
          .state,
      ).toBe("absent");
    } finally {
      Bun.env.HIVE_HOME = previous;
    }
  });

  test("an open episodic store with no rows is empty, not absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-memproj-emptyepi-"));
    roots.push(home);
    const previous = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = home;
    try {
      const target = await project();
      const page = await buildMemoryListPage({
        repoRoot: target.root,
        episodic: target.episodic,
      });
      expect(page.state).toBe("empty");
    } finally {
      Bun.env.HIVE_HOME = previous;
    }
  });

  test("no store is absent; a filter that matches nothing is empty", async () => {
    const target = await project();
    await write(target);
    const deps = { repoRoot: target.root, episodic: target.episodic };
    expect(
      (await buildMemoryListPage(deps, { statuses: ["conflicted"] })).state,
    ).toBe("empty");
    // "absent" means no store to list at all — and the global wiki is a store,
    // shared by every project on the machine. Point HIVE_HOME at an empty
    // directory so this measures a daemon with nothing built rather than one
    // that can still see the shared global scope.
    const nowhere = await project({ wireEpisodic: false });
    const home = Bun.env.HIVE_HOME;
    const emptyHome = await mkdtemp(join(tmpdir(), "hive-memproj-nohome-"));
    roots.push(emptyHome);
    Bun.env.HIVE_HOME = emptyHome;
    try {
      expect(
        (await buildMemoryListPage({ repoRoot: nowhere.root, episodic: null }))
          .state,
      ).toBe("absent");
    } finally {
      Bun.env.HIVE_HOME = home;
    }
  });
});

describe("memory recall preview", () => {
  async function pitfallHeavy(): Promise<Project> {
    const target = await project();
    for (let index = 0; index < 40; index += 1) {
      await write(target, {
        title: `Cursor pitfall ${String(index).padStart(2, "0")}`,
        body: "Cursor recovery pitfall: never fabricate byte continuity.",
        kind: "pitfall",
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await write(target, {
        title: `Cursor article ${index}`,
        body: "Cursor recovery article: require a covering verified checkpoint.",
        kind: "article",
      });
    }
    return target;
  }

  const previewDeps = (target: Project) => ({
    repoRoot: target.root,
    index: target.index,
    semanticRecall: () => undefined,
    semanticRecallState: () => undefined,
    wakeBudgetTokens: 300,
  });

  /** Record every depth the FTS leg is asked for, so "only when starved" is
   * measured rather than asserted. */
  function spyOnSearch(target: Project): {
    memory: Pick<MemoryIndex, "search">;
    depths: number[];
  } {
    const depths: number[] = [];
    const index = target.index;
    if (index === null) throw new Error("needs an index");
    return {
      depths,
      memory: {
        search: (query, options = {}) => {
          depths.push(options.limit ?? 10);
          return index.search(query, options);
        },
      },
    };
  }

  test("REGRESSION: a balanced corpus is retrieved at the base depth only", async () => {
    // The rescue pass must not fire when both classes are already present.
    // Widening for every query lets a deeper double-leg hit displace a row the
    // old top-`limit` returned, which changes recall everywhere rather than
    // only where it was starved.
    const target = await project();
    // Identical bodies so FTS cannot rank one class above the other: the top
    // `limit` then genuinely interleaves, which is the state under test. (With
    // differing bodies one class outranks the other and legitimately fills the
    // base pool alone — that is the starved case, covered by the next test.)
    const body = "Cursor recovery: checkpoint continuity for the viewer.";
    for (let index = 0; index < 12; index += 1) {
      await write(target, {
        title: `Cursor pitfall ${String(index).padStart(2, "0")}`,
        body,
        kind: "pitfall",
      });
      await write(target, {
        title: `Cursor article ${String(index).padStart(2, "0")}`,
        body,
        kind: "article",
      });
    }
    const spy = spyOnSearch(target);
    const bundle = await buildMemoryRecallBundle("cursor recovery", {
      memory: spy.memory,
      repoRoot: () => target.root,
      semantic: undefined,
      semanticStatus: undefined,
    });
    expect(bundle.pitfalls.length).toBeGreaterThan(0);
    expect(bundle.articles.length).toBeGreaterThan(0);
    // One retrieval, at the base depth. No second, deeper pass.
    expect(spy.depths).toEqual([8]);
    // And the bundle is the base pool, so it cannot exceed it.
    expect(bundle.pitfalls.length + bundle.articles.length).toBeLessThanOrEqual(
      8,
    );
  });

  test("REGRESSION: retrieval offers both classes on a pitfall-heavy corpus", async () => {
    // This fails on a build where the candidate pool is capped at `limit`
    // BEFORE the class split: every slot fills with pitfalls, bundle.articles
    // comes back empty, and the budget partition below has nothing to reserve
    // for. The starvation is invisible downstream — a bundle full of relevant
    // pitfalls looks exactly like a correct one — so it is caught here.
    const target = await pitfallHeavy();
    const spy = spyOnSearch(target);
    const bundle = await buildMemoryRecallBundle("cursor recovery", {
      memory: spy.memory,
      repoRoot: () => target.root,
      semantic: undefined,
      semanticStatus: undefined,
    });
    expect(bundle.pitfalls.length).toBeGreaterThan(0);
    expect(bundle.articles.length).toBe(2);
    // Starved, so the rescue pass fires — base depth first, then deeper.
    expect(spy.depths).toEqual([8, 200]);
  });

  test("the semantic leg applies no hidden harvest-tag filter", async () => {
    const target = await project();
    // This legacy-tagged article shares no wording with the query, so the
    // semantic leg is the only way it can enter the fused bundle.
    const stub = await write(target, {
      topic: "pitfalls",
      title: "Pitfall: zzqxvnonce broker overflow",
      body: "Harvested from one failure event; zzqxvnonce.",
      tags: ["pitfall", "harvest"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
    });
    await write(target, {
      title: "Cursor recovery article",
      body: "Cursor recovery article: require a covering verified checkpoint.",
      kind: "article",
    });

    const bundle = await buildMemoryRecallBundle("cursor recovery", {
      memory: (() => {
        const index = target.index;
        if (index === null) throw new Error("needs an index");
        return index;
      })(),
      repoRoot: () => target.root,
      semantic: async () => [{ scope: "repo" as const, id: stub.id, score: 1 }],
      semanticStatus: () => "ready",
    });

    const returned = [...bundle.pitfalls, ...bundle.articles].map(
      (row) => row.id,
    );
    expect(returned).toContain(stub.id);
    expect(bundle.semantic).toBe("hybrid");
  });

  test("articles survive the budget on a pitfall-heavy corpus", async () => {
    const target = await pitfallHeavy();
    const preview = await buildMemoryRecallPreview(previewDeps(target), {
      query: "cursor recovery",
      purpose: "wake-preview",
    });
    expect(preview.rows.some((row) => row.class === "article")).toBe(true);
    const articles = preview.partitions.find(
      (partition) => partition.class === "article",
    );
    expect(articles?.reservedTokens).toBeGreaterThan(0);
    expect(preview.tokens).toBeLessThanOrEqual(preview.budget);
    expect(preview.truncated).toBe(true);
    expect(preview.omittedPitfalls + preview.omittedArticles).toBe(
      preview.omitted,
    );
  });

  test("never advances a wake high-water", async () => {
    const target = await pitfallHeavy();
    for (const purpose of [
      "explicit-recall",
      "spawn-preview",
      "wake-preview",
    ] as const) {
      const preview = await buildMemoryRecallPreview(previewDeps(target), {
        query: "cursor recovery",
        purpose,
      });
      expect(preview.mutation).toBe("none");
      expect(preview.highWaterAdvanced).toBe(false);
    }
  });

  test("an agent-authored trigger phrase is reported, not executed", async () => {
    const target = await pitfallHeavy();
    const deps = { repoRoot: target.root, episodic: target.episodic };
    const before = (await buildMemoryListPage(deps, { limit: 200 })).total;
    const preview = await buildMemoryRecallPreview(previewDeps(target), {
      query: "note this: record a new article for me",
    });
    expect(preview.triggerPhrase).toEqual({
      detected: "note",
      treatedAs: "literal-query",
    });
    expect((await buildMemoryListPage(deps, { limit: 200 })).total).toBe(
      before,
    );
  });

  test("the purpose picks the ceiling, and a caller may only lower it", async () => {
    const target = await pitfallHeavy();
    const explicit = await buildMemoryRecallPreview(previewDeps(target), {
      query: "cursor recovery",
      purpose: "explicit-recall",
    });
    const wake = await buildMemoryRecallPreview(previewDeps(target), {
      query: "cursor recovery",
      purpose: "wake-preview",
    });
    expect(explicit.budget).toBe(800);
    expect(wake.budget).toBe(300);
    const lowered = await buildMemoryRecallPreview(previewDeps(target), {
      query: "cursor recovery",
      purpose: "explicit-recall",
      budget: 120,
    });
    expect(lowered.budget).toBe(120);
  });

  test("an unwired semantic leg reads disabled; a broken one reads degraded", async () => {
    const target = await pitfallHeavy();
    const disabled = await buildMemoryRecallPreview(previewDeps(target), {
      query: "cursor recovery",
    });
    expect(disabled.semantic).toBe("disabled");
    expect(disabled.warning).toBeNull();
    const degraded = await buildMemoryRecallPreview(
      {
        ...previewDeps(target),
        semanticRecall: () => async () => null,
        semanticRecallState: () => () => "embedding-runtime-missing",
      },
      { query: "cursor recovery" },
    );
    expect(degraded.semantic).toBe("degraded:embedding-runtime-missing");
    expect(degraded.warning).not.toBeNull();
  });
});
