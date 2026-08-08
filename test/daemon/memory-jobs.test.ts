// Daemon-owned memory maintenance jobs, the fenced library mutations, and the
// configuration compare-and-set.
//
// Every readback assertion compares the job's own receipt against a store read
// taken independently of it. A job reporting what its loop counter believed is
// reporting an act; only a readback that agrees with a separate read of the
// store is evidence of a state.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistAutonomy } from "../../src/config/autonomy";
import { withHiveConfigLock } from "../../src/config/document-lock";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import {
  casWriteMemoryConfig,
  readMemoryConfig,
} from "../../src/memory-service/memory-config";
import {
  type MemoryEmbedder,
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
} from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import {
  type MemoryJobDeps,
  MemoryJobStore,
  startMemoryJob,
} from "../../src/memory-service/jobs";
import {
  applyMemoryMutation,
  buildMemoryListPage,
} from "../../src/memory-service/library";
import { runRetentionSweep } from "../../src/memory-service/retention";
import {
  deleteMemoryFact,
  listMemoryFacts,
  readMemoryFact,
  verifyMemoryFact,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import { MemoryWriteService } from "../../src/memory-service/write-service";
import { HiveConfigSchema } from "../../src/schemas/config-schema";
import type { MemoryScope, MemoryWriteInput } from "../../src/schemas/memory";

const roots: string[] = [];
const GLOBAL_SANDBOX = await mkdtemp(join(tmpdir(), "hive-memjobs-home-"));
roots.push(GLOBAL_SANDBOX);
Bun.env.HIVE_HOME = GLOBAL_SANDBOX;

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

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

interface Rig {
  root: string;
  index: MemoryIndex;
  episodic: EpisodicStore;
  jobs: MemoryJobStore;
  deps: MemoryJobDeps;
}

async function rig(
  options: {
    sweepOff?: boolean;
    staleAfterDays?: number;
    now?: () => Date;
  } = {},
): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "hive-memjobs-"));
  roots.push(root);
  const index = new MemoryIndex(new Database(":memory:"));
  const episodic = new EpisodicStore(join(root, "episodic.db"));
  const deps: MemoryJobDeps = {
    repoRoot: root,
    index,
    episodic,
    embeddingService: null,
    writeMemoryFact: async (write) => {
      const written = await writeMemoryFact(root, write);
      index.upsertFact(written);
      return written;
    },
    // Mirrors the daemon's own runMemoryRetentionSweep: sweep, then reproject
    // the FTS index so a demotion the sweep wrote to disk is visible to
    // search. `sweepOff` stands in for a daemon with no retention configured.
    runRetentionSweep: async () => {
      if (options.sweepOff === true) return null;
      const report = await runRetentionSweep({
        episodic,
        repoRoot: root,
        config: {
          events_hot_days: 30,
          stale_after_days: options.staleAfterDays ?? 90,
          sweep_interval_hours: 24,
        },
        now: options.now?.() ?? new Date(),
      });
      if (report.articlesDemoted.length > 0) await index.rebuild(root);
      return report;
    },
    // Mirrors the daemon's serialized rebuildMemoryIndex.
    rebuildMemoryIndex: async () => await index.rebuild(root),
    now: () => options.now?.() ?? new Date(),
  };
  return { root, index, episodic, jobs: new MemoryJobStore(episodic), deps };
}

describe("memory jobs", () => {
  test("a receipt exists before the job has done anything", async () => {
    const target = await rig();
    await target.deps.writeMemoryFact(input());
    const started = startMemoryJob(target.jobs, target.deps, "reindex", "user");
    expect(started.receipt.state).toBe("running");
    // Persisted, not merely returned: a job that dies mid-run must still leave
    // the trace that it was attempted.
    expect(target.jobs.recent().map((receipt) => receipt.id)).toContain(
      started.receipt.id,
    );
    // An unknown total is null, never zero.
    expect(started.receipt.progress.total).toBeNull();
    await started.done;
  });

  test("the final readback agrees with an independent read of the stores", async () => {
    const target = await rig();
    await target.deps.writeMemoryFact(input({ title: "One" }));
    await target.deps.writeMemoryFact(input({ title: "Two" }));
    const receipt = await startMemoryJob(
      target.jobs,
      target.deps,
      "reindex",
      "user",
    ).done;
    expect(receipt.state).toBe("succeeded");
    expect(receipt.finishedAt).not.toBeNull();
    expect(receipt.readback?.wikiArticles).toBe(
      (await listMemoryFacts(target.root)).length,
    );
    expect(receipt.readback?.ftsRows).toBe(target.index.count());
    expect(receipt.progress.total).not.toBeNull();
    expect(receipt.progress.done).toBe(receipt.progress.total as number);
  });

  test("reindex goes through the daemon's serialized rebuild, not the index", async () => {
    // A rebuild deletes every FTS row and reinserts from the files it listed.
    // Called directly it races an in-flight write: the write lands, the
    // rebuild's listing predates it, and the article is missing from the index
    // afterwards — under a "succeeded" receipt, because the job saw no error.
    // The only way it can be serialized is by going through the daemon's own
    // path, so assert the job actually calls it.
    const target = await rig();
    let routed = 0;
    const deps: MemoryJobDeps = {
      ...target.deps,
      rebuildMemoryIndex: async () => {
        routed += 1;
        return await target.index.rebuild(target.root);
      },
    };
    await target.deps.writeMemoryFact(input());
    const receipt = await startMemoryJob(target.jobs, deps, "reindex", "user")
      .done;
    expect(receipt.state).toBe("succeeded");
    expect(routed).toBe(1);
  });

  test("reindex restores missing repo and global article vectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-memjobs-vectors-"));
    roots.push(root);
    const episodic = new EpisodicStore(join(root, "episodic.db"));
    const db = new HiveDatabase(":memory:");
    const embeddedTexts: string[] = [];
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: {
        spawn: async () => {
          throw new Error("not exercised by memory vector repair test");
        },
      },
      db,
      repoRoot: root,
      episodicStore: episodic,
      memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
      memoryEmbeddingLoad: () =>
        Promise.resolve({
          model: "bge-small-en-v1.5",
          dimensions: 4,
          embed: async (texts) => {
            embeddedTexts.push(...texts);
            return texts.map(() => [1, 0, 0, 0]);
          },
          embedQuery: async () => [1, 0, 0, 0],
        }),
    });
    let globalId: string | null = null;
    try {
      const first = await daemon.writeMemoryFact(input({ title: "First" }));
      const second = await daemon.writeMemoryFact(input({ title: "Second" }));
      const global = await daemon.writeMemoryFact(
        input({ scope: "global", title: "Global missing vector" }),
      );
      globalId = global.id;
      await daemon.embeddingIndex?.settle();
      embeddedTexts.length = 0;
      episodic.removeMemoryEmbedding("article", "global", global.id);
      expect(episodic.memoryEmbeddings({ kind: "article" })).toHaveLength(2);

      await daemon.rebuildMemoryIndex();

      const storedIdentities = new Set(
        episodic
          .memoryEmbeddings({ kind: "article" })
          .map((row) => `${row.scope}:${row.sourceId}`),
      );
      expect(storedIdentities).toEqual(
        new Set([
          `repo:${first.id}`,
          `repo:${second.id}`,
          `global:${global.id}`,
        ]),
      );
      expect(embeddedTexts).toEqual([`Global missing vector\n${global.body}`]);
    } finally {
      if (globalId !== null) await daemon.deleteMemoryFact("global", globalId);
      episodic.close();
      db.close();
    }
  });

  test("consolidation apply cannot leave a searchable row for a deleted article", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-memjobs-consolidate-"));
    roots.push(root);
    const episodic = new EpisodicStore(join(root, "episodic.db"));
    const index = new MemoryIndex(new Database(":memory:"));
    const embedder: MemoryEmbedder = {
      model: "mock-consolidation",
      dimensions: 4,
      embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
      embedQuery: async () => [1, 0, 0, 0],
    };
    const embeddingService = new MemoryEmbeddingService(
      { provider: "local", model: "bge-small-en-v1.5" },
      { load: async () => embedder },
    );
    const embeddingIndex = new MemoryEmbeddingIndex({
      store: episodic,
      service: embeddingService,
    });
    const writer = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex,
    });
    const deps: MemoryJobDeps = {
      repoRoot: root,
      index,
      episodic,
      embeddingService,
      writeMemoryFact: (write) => writer.write(write),
      runRetentionSweep: async () => null,
      rebuildMemoryIndex: async () => await index.rebuild(root),
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    };
    const older = await writer.write(
      input({
        id: "consolidation-ghost-older",
        title: "Old memory route",
        body: "Only the retired article carries ghostonlytoken.",
        date: "2026-07-25",
      }),
    );
    await writer.write(
      input({
        id: "consolidation-ghost-newer",
        title: "Current routing replacement",
        body: "The current article replaces the older routing account.",
        date: "2026-07-26",
      }),
    );
    await embeddingIndex.settle();
    expect(index.search("ghostonlytoken").map((hit) => hit.id)).toContain(
      older.id,
    );
    expect(
      episodic.memoryEmbeddings({ kind: "article" }).map((row) => row.sourceId),
    ).toContain(older.id);

    const receipt = await startMemoryJob(
      new MemoryJobStore(episodic),
      deps,
      "consolidation-apply",
      "user",
    ).done;

    expect(receipt.state).toBe("succeeded");
    expect(await readMemoryFact(root, "repo", older.id)).toBeNull();
    expect(index.search("ghostonlytoken").map((hit) => hit.id)).not.toContain(
      older.id,
    );
    expect(
      episodic.memoryEmbeddings({ kind: "article" }).map((row) => row.sourceId),
    ).not.toContain(older.id);
  });

  test("a job that cannot run fails visibly and isolates the next one", async () => {
    const target = await rig();
    const failed = await startMemoryJob(
      target.jobs,
      target.deps,
      "consolidation-dry-run",
      "user",
    ).done;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("semantic surface");
    // "could not run" and "ran and found nothing" are different answers.
    expect(failed.summary).toBe("could not run");
    expect(failed.readback).not.toBeNull();

    const next = await startMemoryJob(
      target.jobs,
      target.deps,
      "retention-sweep",
      "user",
    ).done;
    expect(next.state).toBe("succeeded");
    expect(next.readback?.events).toBe(target.episodic.rowCounts().events);
  });

  test("a sweep that demotes leaves disk and the index agreeing", async () => {
    // The probe that caught this: the sweep rewrites article files to demote
    // them, so a job calling the bare sweep function left `stale` on disk
    // while the FTS index still answered `verified` — and the receipt said
    // "succeeded" over the top of the disagreement. Routing through the
    // daemon's own path takes the memory lock AND reprojects the index.
    // Verified on the day it was written, then swept a year later with a
    // one-day staleness window, so the demotion is unambiguous.
    const target = await rig({
      staleAfterDays: 1,
      now: () => new Date("2027-07-26T00:00:00.000Z"),
    });
    const written = await target.deps.writeMemoryFact(
      input({
        title: "Long verified article",
        date: "2026-07-25",
        author: "the-author",
      }),
    );
    // Verified by a later session, which is the only way an article gets the
    // status the sweep is here to take away.
    target.index.upsertFact(
      await verifyMemoryFact(target.root, "repo", written.id, {
        verifier: "a-later-session",
        date: "2026-07-26",
      }),
    );
    const before = await listMemoryFacts(target.root);
    expect(before[0]?.status).toBe("verified");
    expect(target.index.search("verified", { limit: 5 })[0]?.status).toBe(
      "verified",
    );

    const receipt = await startMemoryJob(
      target.jobs,
      target.deps,
      "retention-sweep",
      "user",
    ).done;
    expect(receipt.state).toBe("succeeded");

    const onDisk = (await listMemoryFacts(target.root)).find(
      (fact) => fact.title === "Long verified article",
    );
    expect(onDisk?.status).toBe("stale");
    const indexed = target.index
      .search("article", { limit: 20 })
      .find((hit) => hit.id === onDisk?.id);
    expect(indexed?.status).toBe("stale");
  });

  test("a sweep that is switched off reports could-not-run, never success", async () => {
    const target = await rig({ sweepOff: true });
    const receipt = await startMemoryJob(
      target.jobs,
      target.deps,
      "retention-sweep",
      "user",
    ).done;
    expect(receipt.state).toBe("failed");
    expect(receipt.summary).toBe("could not run");
    expect(receipt.error).toContain("nothing was swept");
  });

  test("receipts are bounded and the newest per kind is reported", async () => {
    const target = await rig();
    for (let index = 0; index < 3; index += 1) {
      await startMemoryJob(target.jobs, target.deps, "reindex", "user").done;
    }
    await startMemoryJob(target.jobs, target.deps, "retention-sweep", "user")
      .done;
    expect(target.jobs.recent()[0]?.kind).toBe("retention-sweep");
    const latest = target.jobs.latestPerKind();
    expect(latest.map((receipt) => receipt.kind).sort()).toEqual([
      "reindex",
      "retention-sweep",
    ]);
  });
});

describe("library mutations", () => {
  async function mutationRig(): Promise<{
    root: string;
    episodic: EpisodicStore;
    deps: Parameters<typeof applyMemoryMutation>[0];
    revisionOf: (id: string) => Promise<string>;
  }> {
    const target = await rig();
    const deps = {
      repoRoot: target.root,
      // The rig has no daemon lock; running the operation directly is the
      // same critical section, since nothing else touches this temp root.
      serialize: <T>(operation: () => Promise<T>) => operation(),
      writeMemoryFact: async (write: MemoryWriteInput) =>
        await writeMemoryFact(target.root, write),
      deleteMemoryFact: async (scope: MemoryScope, id: string) =>
        await deleteMemoryFact(target.root, scope, id),
    };
    const revisionOf = async (id: string): Promise<string> =>
      (
        await buildMemoryListPage(
          { repoRoot: target.root, episodic: target.episodic },
          { limit: 200 },
        )
      ).items.find((item) => item.id === id)?.revision ?? "";
    return { root: target.root, episodic: target.episodic, deps, revisionOf };
  }

  test("a stale revision is fenced and the current one comes back", async () => {
    const target = await mutationRig();
    const written = await writeMemoryFact(target.root, input());
    const result = await applyMemoryMutation(target.deps, {
      action: "delete",
      scope: "repo",
      id: written.id,
      expectedRevision: "0000000000000000",
    });
    expect(result.state).toBe("conflict");
    if (result.state === "conflict") {
      expect(result.currentRevision).toBe(await target.revisionOf(written.id));
    }
    expect(
      (await listMemoryFacts(target.root)).some(
        (fact) => fact.id === written.id,
      ),
    ).toBe(true);
  });

  test("create refuses an existing id instead of overwriting it", async () => {
    // The door around the fence: create carries no revision, so if it can land
    // on a live article the compare-and-set guarantee is decorative. The
    // underlying write treats a known id plus a self-supersede as a normal
    // update, which is exactly the shape that slips through.
    const target = await mutationRig();
    const written = await writeMemoryFact(target.root, input());
    const before = await target.revisionOf(written.id);

    const refused = await applyMemoryMutation(target.deps, {
      action: "create",
      input: {
        ...input({ body: "Overwritten by a blind create." }),
        id: written.id,
        supersedes: [written.id],
      },
    });
    expect(refused.state).toBe("already-exists");
    if (refused.state === "already-exists") {
      // The remedy has to be actionable: the caller needs the revision an
      // update would fence on.
      expect(refused.currentRevision).toBe(before);
    }
    // And nothing was written.
    const after = (await listMemoryFacts(target.root)).find(
      (fact) => fact.id === written.id,
    );
    expect(after?.body).not.toContain("Overwritten");
    expect(await target.revisionOf(written.id)).toBe(before);

    // Positive control: the same create path still works for a fresh id.
    const fresh = await applyMemoryMutation(target.deps, {
      action: "create",
      input: input({ title: "A brand new article" }),
    });
    expect(fresh.state).toBe("applied");
  });

  test("the reference guard refuses and names the referring articles", async () => {
    const target = await mutationRig();
    // Three writes, not two: writeMemoryFact REMOVES the file of an article it
    // supersedes, so the two-write version leaves nothing for the guard to
    // protect. Writing the id again rebuilds the guarded state.
    const first = await writeMemoryFact(target.root, input());
    const holder = await writeMemoryFact(
      target.root,
      input({ title: "Referring article", supersedes: [first.id] }),
    );
    const held = await writeMemoryFact(target.root, input());

    const refused = await applyMemoryMutation(target.deps, {
      action: "delete",
      scope: "repo",
      id: held.id,
      expectedRevision: await target.revisionOf(held.id),
    });
    expect(refused.state).toBe("referenced");
    if (refused.state === "referenced") {
      expect(refused.referencedBy).toContain(holder.id);
    }

    // Positive control: with the reference gone the same delete applies.
    await applyMemoryMutation(target.deps, {
      action: "delete",
      scope: "repo",
      id: holder.id,
      expectedRevision: await target.revisionOf(holder.id),
    });
    const applied = await applyMemoryMutation(target.deps, {
      action: "delete",
      scope: "repo",
      id: held.id,
      expectedRevision: await target.revisionOf(held.id),
    });
    expect(applied.state).toBe("applied");
  });

  test("raw evidence physically survives its article's deletion", async () => {
    const target = await mutationRig();
    const written = await writeMemoryFact(target.root, input());
    const rawDirectory = join(
      target.root,
      ".hive",
      "memory",
      "raw",
      "terminal",
    );
    const rawFiles = (await readdir(rawDirectory)).filter((name) =>
      name.includes(written.id),
    );
    expect(rawFiles.length).toBeGreaterThan(0);

    const deleted = await applyMemoryMutation(target.deps, {
      action: "delete",
      scope: "repo",
      id: written.id,
      expectedRevision: await target.revisionOf(written.id),
    });
    expect(deleted.state).toBe("applied");
    expect(
      (await listMemoryFacts(target.root)).some(
        (fact) => fact.id === written.id,
      ),
    ).toBe(false);
    // The filesystem read is deliberate: the claim is that the bytes are still
    // there, and only stat can say that.
    for (const name of rawFiles) {
      expect(existsSync(join(rawDirectory, name))).toBe(true);
    }
    const page = await buildMemoryListPage(
      { repoRoot: target.root, episodic: target.episodic },
      { limit: 200 },
    );
    expect(
      page.items.some(
        (item) => item.kind === "raw-ref" && item.status === "immutable",
      ),
    ).toBe(true);
  });
});

describe("memory configuration compare-and-set", () => {
  test("an absent file has a revision; a stale one is refused; a match applies", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-memcfg-"));
    roots.push(home);
    const path = join(home, "config.toml");

    const before = await readMemoryConfig(path);
    expect(before.revision).toHaveLength(16);
    expect(before.eventsHotDays).toBe(30);

    const conflict = await casWriteMemoryConfig(
      { expectedRevision: "0000000000000000", patch: { eventsHotDays: 45 } },
      path,
    );
    expect(conflict.state).toBe("conflict");
    if (conflict.state === "conflict") {
      expect(conflict.currentRevision).toBe(before.revision);
    }

    const applied = await casWriteMemoryConfig(
      { expectedRevision: before.revision, patch: { eventsHotDays: 45 } },
      path,
    );
    expect(applied.state).toBe("applied");
    // The returned config is a readback of the file, not an echo of the patch.
    const reread = await readMemoryConfig(path);
    expect(reread.eventsHotDays).toBe(45);
    if (applied.state === "applied") {
      expect(applied.config.revision).toBe(reread.revision);
    }
    expect(reread.revision).not.toBe(before.revision);
  });

  test("five concurrent writers: every applied result is a state the file was really in", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-memcfg-race-"));
    roots.push(home);
    const path = join(home, "config.toml");
    const start = await readMemoryConfig(path);

    // All five fence on the SAME revision. Exactly one may win: the others
    // read a document that has moved and must conflict. A CAS that reads and
    // writes outside a lock lets several through, and the losers' edits vanish
    // while they are told "applied".
    const results = await Promise.all(
      [31, 32, 33, 34, 35].map((days) =>
        casWriteMemoryConfig(
          { expectedRevision: start.revision, patch: { eventsHotDays: days } },
          path,
        ),
      ),
    );
    const applied = results.filter((result) => result.state === "applied");
    expect(applied).toHaveLength(1);
    expect(
      results.filter((result) => result.state === "conflict"),
    ).toHaveLength(4);

    // The winner's reported revision and values must match the file on disk —
    // a revision computed from the string a writer intended names a state no
    // reader can reproduce.
    const onDisk = await readMemoryConfig(path);
    const winner = applied[0];
    if (winner?.state !== "applied") throw new Error("no winner");
    expect(winner.config.revision).toBe(onDisk.revision);
    expect(winner.config.eventsHotDays).toBe(onDisk.eventsHotDays);
    // And no edit was lost in the sense of landing without being reported: the
    // value on disk is the one the single winner asked for.
    expect([31, 32, 33, 34, 35]).toContain(onDisk.eventsHotDays);

    // Every conflict must name the revision a retry can actually use — the one
    // now on disk, not the stale one the loser presented. Because each loser
    // reads inside the lock, it sees the winner's document and reports it.
    for (const result of results) {
      if (result.state !== "conflict") continue;
      expect(result.currentRevision).toBe(onDisk.revision);
      expect(result.currentRevision).not.toBe(start.revision);
    }
  });

  test("a memory edit and an autonomy edit do not clobber each other", async () => {
    // Both features rewrite the WHOLE document, so a lock each writer takes
    // only against itself loses edits in both directions: each renders its
    // change over the text it read, and whoever renames last erases the other.
    const home = await mkdtemp(join(tmpdir(), "hive-cfg-cross-"));
    roots.push(home);
    const path = join(home, "config.toml");
    await Bun.write(path, 'autonomy = "sandboxed"\n');

    // Racing the two writers and hoping to catch the bad interleaving is a
    // test that passes on the broken build — it did. The property is
    // mutual exclusion, so assert THAT directly: hold the document lock and
    // prove the autonomy writer cannot commit until it is released.
    let acquired!: () => void;
    const holderHasLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withHiveConfigLock(path, async () => {
      acquired();
      await held;
    });
    await holderHasLock;

    let autonomyCommitted = false;
    const writer = persistAutonomy("dangerous", path).then(() => {
      autonomyCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Without a SHARED lock the autonomy write sails straight through here.
    expect(autonomyCommitted).toBe(false);
    expect(await Bun.file(path).text()).toContain('autonomy = "sandboxed"');

    release();
    await holder;
    await writer;
    expect(autonomyCommitted).toBe(true);

    // And with exclusion in place, sequential edits by both writers both
    // survive in the one document.
    const start = await readMemoryConfig(path);
    const cas = await casWriteMemoryConfig(
      { expectedRevision: start.revision, patch: { eventsHotDays: 45 } },
      path,
    );
    expect(cas.state).toBe("applied");
    const config = HiveConfigSchema.parse(
      Bun.TOML.parse(await Bun.file(path).text()),
    );
    expect(config.autonomy).toBe("dangerous");
    expect(config.memory.retention.events_hot_days).toBe(45);
  });

  test("a memory edit leaves unrelated settings byte-for-byte alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-memcfg-keep-"));
    roots.push(home);
    const path = join(home, "config.toml");
    await Bun.write(
      path,
      [
        'autonomy = "dangerous"',
        "",
        "[memory]",
        "wake_budget_tokens = 500",
        "",
      ].join("\n"),
    );
    const before = await readMemoryConfig(path);
    expect(before.wakeBudgetTokens).toBe(500);

    const applied = await casWriteMemoryConfig(
      { expectedRevision: before.revision, patch: { staleAfterDays: 120 } },
      path,
    );
    expect(applied.state).toBe("applied");
    const text = await Bun.file(path).text();
    expect(text).toContain('autonomy = "dangerous"');
    const reread = await readMemoryConfig(path);
    expect(reread.staleAfterDays).toBe(120);
    expect(reread.wakeBudgetTokens).toBe(500);
  });
});
