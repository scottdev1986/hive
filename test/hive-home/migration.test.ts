// A home that moved leaves its database in the directory it left. Opening the new path with
// `create: true` at that moment mints an empty database beside surviving data and calls it a fresh
// install, which is how a live board gets replaced by nothing. These cases are the three answers
// start-up is allowed to give: carry the database across, refuse because two of them exist, or mint
// a fresh one because there is nothing to carry.
//
// They go through HiveDatabase rather than through the migration module, for two reasons. The
// behaviour worth proving is what happens when the database is opened, not what a function returns.
// And a case that only exercised the new module could never have been run against the tree that has
// the defect — these ran there first, and the first case minted an empty database exactly as
// described, while the third passed unchanged.
//
// The prior home is a directory inside the test's own temp root rather than the `/tmp/hv-<tag>` the
// record names, because the suite runs under a sandbox that denies writes anywhere outside that
// root. `stagedVariant` asserts that the real record does name a prior home before it substitutes a
// writable one, so the substitution cannot hide an unarmed mechanism.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  artifactReadRoots,
  getArtifact,
  putArtifact,
} from "../../src/daemon/artifact-store/artifact-store";
import { projectKey } from "../../src/daemon/project-identity-core/state";
import { getDatabasePath } from "../../src/hive-home/home";
import { migratePriorHomeState } from "../../src/hive-home/migration";
import {
  resolveVariant,
  type VariantConfig,
} from "../../src/hive-home/variant";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const ATOM = ["hive.db", "hive.db-wal", "hive.db-shm"] as const;

/** Where a home kept its identity marker before markers moved outside the home, which is the only spelling a prior home can have. */
const PRIOR_MARKER = "hive.db.identity";

const PRIOR_IDENTITY = "3f1c9a52-6d84-4b21-9f0e-7c8d2a5b1e43";

/** A row that reached the main database file, and a row that is committed but still only in the write-ahead log. The second one is what a move that takes `hive.db` alone silently drops. */
const CHECKPOINTED = "settled-before-the-move";
const IN_THE_LOG = "committed-into-the-log";

const TOUCHED = [
  "HIVE_HOME",
  "HIVE_DEFAULT_HOME",
  "HIVE_BUILD_VARIANT",
] as const;
const PRIOR_ENV = Object.fromEntries(
  TOUCHED.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of TOUCHED) {
    const value = PRIOR_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Builds a home holding a real `hive.db` with a real `-wal` and `-shm` beside it, and its identity
 * marker at the spelling a prior home uses.
 *
 * The files are built in a scratch directory and copied out while a connection still holds them,
 * because closing the last connection checkpoints the log and deletes it — and the log is the whole
 * point. `wal_autocheckpoint = 0` keeps the rows written after the explicit checkpoint in the log
 * rather than folded back into the main file.
 */
function stagePriorHome(root: string, name = "prior"): string {
  const build = join(root, `${name}-build`);
  const prior = join(root, name);
  mkdirSync(build, { recursive: true });
  mkdirSync(prior, { recursive: true });
  const writer = new Database(join(build, "hive.db"), { create: true });
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("CREATE TABLE board (name TEXT PRIMARY KEY)");
  writer.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  writer
    .query("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("databaseIdentity", PRIOR_IDENTITY);
  writer.query("INSERT INTO board (name) VALUES (?)").run(CHECKPOINTED);
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.query("INSERT INTO board (name) VALUES (?)").run(IN_THE_LOG);
  for (const member of ATOM) {
    copyFileSync(join(build, member), join(prior, member));
  }
  writer.close();
  rmSync(build, { recursive: true, force: true });
  writeFileSync(join(prior, PRIOR_MARKER), `${PRIOR_IDENTITY}\n`, {
    mode: 0o600,
  });
  return prior;
}

/** Points the process at a dev home that does not exist yet and hands back the record for it, with the prior home replaced by one the sandbox lets the test write to. */
function stagedVariant(root: string, priorHome: string): VariantConfig {
  const machineHome = join(root, "machine");
  const home = join(machineHome, "instances", "dev-fixture");
  process.env.HIVE_DEFAULT_HOME = machineHome;
  process.env.HIVE_HOME = home;
  process.env.HIVE_BUILD_VARIANT = "dev";
  const resolved = resolveVariant(home);
  expect(resolved.priorHomes).not.toBeEmpty();
  return { ...resolved, priorHomes: [priorHome] };
}

function boardRows(database: Database): string[] {
  return (
    database.query("SELECT name FROM board ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function storedIdentity(database: Database): string | null {
  const row = database
    .query("SELECT value FROM meta WHERE key = 'databaseIdentity'")
    .get() as { value: string } | null;
  return row === null ? null : row.value;
}

describe("a home that moved", () => {
  test("the write-ahead log is where the fixture's newest row lives", () => {
    // Positive control for every assertion below that counts on the log: without it, the row
    // committed after the checkpoint is simply gone, which is what a partial move would ship.
    const root = tempRoot("hive-migration-control-");
    const prior = stagePriorHome(root);
    const alone = join(root, "db-only");
    mkdirSync(alone);
    copyFileSync(join(prior, "hive.db"), join(alone, "hive.db"));
    // Read-write, because a WAL-mode database has to be able to rebuild its `-shm` index to be read
    // at all, and a read-only open of one that arrived without its sidecars cannot even do that.
    const database = new Database(join(alone, "hive.db"));
    try {
      expect(boardRows(database)).toEqual([CHECKPOINTED]);
    } finally {
      database.close();
    }
  });

  test("carries its database across instead of minting an empty one", () => {
    const root = tempRoot("hive-migration-carry-");
    const prior = stagePriorHome(root);
    const config = stagedVariant(root, prior);
    expect(existsSync(config.home)).toBe(false);
    expect(existsSync(config.databaseIdentityPath)).toBe(false);

    migratePriorHomeState(config);
    const hive = new HiveDatabase(getDatabasePath(), { variant: config });
    try {
      expect(boardRows(hive.database)).toEqual(
        [CHECKPOINTED, IN_THE_LOG].sort(),
      );
      expect(storedIdentity(hive.database)).toBe(PRIOR_IDENTITY);
    } finally {
      hive.database.close();
    }

    // The step a hand-copy forgets: without it the marker is re-established from whatever arrived,
    // and the guard that would have caught a swapped database is disarmed without a word.
    expect(readFileSync(config.databaseIdentityPath, "utf8").trim()).toBe(
      PRIOR_IDENTITY,
    );
    // The atom moved rather than being copied, so the next start has one database, not two.
    for (const member of [...ATOM, PRIOR_MARKER]) {
      expect(existsSync(join(prior, member))).toBe(false);
    }
    for (const member of ATOM) {
      expect(existsSync(join(config.home, member))).toBe(true);
    }
  });

  test("carries selections and the complete quota database atom", () => {
    const root = tempRoot("hive-migration-selections-");
    const prior = stagePriorHome(root);
    const config = stagedVariant(root, prior);
    writeFileSync(join(prior, "config.toml"), 'autonomy = "dangerous"\n');
    writeFileSync(join(prior, "quota.toml"), "limit = 7\n");
    mkdirSync(join(prior, "credentials"), { mode: 0o700 });
    writeFileSync(join(prior, "credentials", "provider.json"), "secret\n");
    writeFileSync(join(prior, "billing-2026-08.json"), "{}\n");
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(join(prior, `quota.db${suffix}`), `quota${suffix}\n`);
    }

    migratePriorHomeState(config);

    for (const name of [
      "config.toml",
      "quota.toml",
      "billing-2026-08.json",
      "quota.db",
      "quota.db-wal",
      "quota.db-shm",
    ]) {
      expect(readFileSync(join(config.home, name), "utf8")).toBeTruthy();
    }
    expect(
      readFileSync(join(config.home, "credentials", "provider.json"), "utf8"),
    ).toBe("secret\n");
  });

  test("refuses to start when the new home and a prior home both hold a database", () => {
    const root = tempRoot("hive-migration-both-");
    const prior = stagePriorHome(root);
    const config = stagedVariant(root, prior);
    mkdirSync(config.home, { recursive: true });
    for (const member of ATOM) {
      copyFileSync(join(prior, member), join(config.home, member));
    }
    const arrived = readFileSync(join(config.home, "hive.db"));

    let message = "";
    try {
      const migration = migratePriorHomeState(config);
      if (migration.kind !== "conflict") {
        throw new Error("migrating two databases unexpectedly succeeded");
      }
      throw new Error(migration.databases.join(", "));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Two boards is a question only the owner can answer, so the refusal names both and stops.
    expect(message).toContain(join(config.home, "hive.db"));
    expect(message).toContain(join(prior, "hive.db"));
    for (const member of [...ATOM, PRIOR_MARKER]) {
      expect(existsSync(join(prior, member))).toBe(true);
    }
    expect(readFileSync(join(config.home, "hive.db"))).toEqual(arrived);
  });

  test("carries a prior home that holds artifacts but no database", () => {
    // A prior home is worth carrying from because it holds state this install owns, not only
    // because it holds a database: a home that moved after its first artifact but before its
    // first database still has evidence the new home needs.
    const root = tempRoot("hive-migration-artifacts-only-");
    const prior = join(root, "prior");
    const store = join(prior, "artifacts", "project-a", "task_1");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "art_1.md"), "evidence\n");
    writeFileSync(join(prior, "config.toml"), 'autonomy = "dangerous"\n');
    const config = stagedVariant(root, prior);

    const migration = migratePriorHomeState(config);

    expect(migration).toEqual({ kind: "settled", migratedFrom: prior });
    expect(
      readFileSync(
        join(config.home, "artifacts", "project-a", "task_1", "art_1.md"),
        "utf8",
      ),
    ).toBe("evidence\n");
    expect(readFileSync(join(config.home, "config.toml"), "utf8")).toBe(
      'autonomy = "dangerous"\n',
    );
    // Carried, never moved: artifact bytes are evidence, and a migration does not delete evidence.
    expect(readFileSync(join(store, "art_1.md"), "utf8")).toBe("evidence\n");
  });

  test("an artifact id cited before the move resolves from the new home after it", () => {
    const root = tempRoot("hive-migration-artifact-resolve-");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const prior = join(root, "prior");
    mkdirSync(prior, { recursive: true });
    const config = stagedVariant(root, prior);
    const stored = putArtifact({
      root: join(prior, "artifacts", projectKey(repo)),
      taskOrRunId: "task_019fec14-1005-7000-8000-0000000000a1",
      title: null,
      author: "harper",
      body: "the evidence the board cites\n",
      now: new Date("2026-08-14T12:00:00.000Z"),
    });
    // The failure mode restated: the board moved and every root the live store scans came up
    // empty for the ids it cites.
    for (const readRoot of artifactReadRoots(repo)) {
      expect(getArtifact(readRoot, stored.artifactId)).toBeNull();
    }

    const migration = migratePriorHomeState(config);
    expect(migration.kind).toBe("settled");

    const resolved = artifactReadRoots(repo)
      .map((readRoot) => getArtifact(readRoot, stored.artifactId))
      .find((artifact) => artifact !== null);
    expect(resolved?.artifactId).toBe(stored.artifactId);
    expect(resolved?.body).toContain("the evidence the board cites");
    // The carry lands in the home's own store, which is the read root the store keeps for bytes
    // written before the store moved to the machine-level home — where a reader already looks.
    expect(resolved?.storagePath).toBe(
      join(
        config.home,
        "artifacts",
        projectKey(repo),
        stored.taskOrRunId,
        `${stored.artifactId}.md`,
      ),
    );
  });

  test("mints a fresh database when neither home holds one", () => {
    const root = tempRoot("hive-migration-fresh-");
    const emptyPrior = join(root, "prior");
    mkdirSync(emptyPrior, { recursive: true });
    writeFileSync(join(emptyPrior, "config.toml"), 'autonomy = "dangerous"\n');
    for (const prior of [emptyPrior, join(root, "never-existed")]) {
      const config = stagedVariant(root, prior);
      rmSync(config.machineHome, { recursive: true, force: true });

      const hive = new HiveDatabase(getDatabasePath(), { variant: config });
      const minted = required(
        storedIdentity(hive.database),
        "a fresh database must establish an identity",
      );
      hive.database.close();

      expect(minted).not.toBe(PRIOR_IDENTITY);
      expect(readFileSync(config.databaseIdentityPath, "utf8").trim()).toBe(
        minted,
      );
      expect(existsSync(join(config.home, "hive.db"))).toBe(true);
      rmSync(config.home, { recursive: true, force: true });
    }
    // A prior home with no database is left exactly as it was found.
    expect(existsSync(join(emptyPrior, "hive.db"))).toBe(false);
    expect(readFileSync(join(emptyPrior, "config.toml"), "utf8")).toBe(
      'autonomy = "dangerous"\n',
    );
  });
});
