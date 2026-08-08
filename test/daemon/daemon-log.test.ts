// The durable daemon warning sink: timestamped appends to
// $HIVE_HOME/logs/daemon.log, size-capped single-rollover rotation, and the
// never-break-the-daemon contract (an unwritable log dir is a no-op), plus
// the daemon-level wiring that lands embedding state transitions in the file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonLog,
  daemonLogPath,
} from "../../src/daemon/observability/daemon-log";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { EpisodicStore } from "../../src/memory-service/episodic";
import type { AgentRecord } from "../../src/schemas/agent";
import { required } from "../required";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;

beforeEach(() => {
  previousHiveHome = Bun.env.HIVE_HOME;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
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

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hive Test",
      GIT_AUTHOR_EMAIL: "hive@example.test",
      GIT_COMMITTER_NAME: "Hive Test",
      GIT_COMMITTER_EMAIL: "hive@example.test",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function readRef(root: string, ref: string): string | null {
  const result = Bun.spawnSync([
    "git",
    "-C",
    root,
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

describe("DaemonLog", () => {
  test("appends an ISO-timestamped line under $HIVE_HOME/logs/daemon.log", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    Bun.env.HIVE_HOME = home;
    const log = new DaemonLog();
    log.write("Hive memory embeddings: UNAVAILABLE — test line");
    const content = await readFile(join(home, "logs", "daemon.log"), "utf8");
    const line = content.trimEnd();
    // "<ISO timestamp> <message>"
    const stamp = line.slice(0, 24);
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
    expect(line.slice(25)).toBe(
      "Hive memory embeddings: UNAVAILABLE — test line",
    );
    expect(daemonLogPath()).toBe(join(home, "logs", "daemon.log"));
  });

  test("rolls over at the size cap, keeping one .1 generation", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    const path = join(home, "logs", "daemon.log");
    const log = new DaemonLog(path, 120);
    log.write("first generation line that takes up some space");
    log.write("second generation line that pushes past the cap easily");
    log.write("third generation line");
    // The second rollover clobbered the first: exactly one .1 generation is
    // kept, so growth is bounded no matter how long the daemon runs.
    const rolled = await readFile(`${path}.1`, "utf8");
    expect(rolled).toContain("second generation line");
    expect(rolled).not.toContain("first generation line");
    const current = await readFile(path, "utf8");
    expect(current).toContain("third generation line");
    expect(current.length).toBeLessThan(120);
  });

  test("an unwritable log dir never throws — the sink is a no-op", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    // A FILE where the logs directory would be: mkdir/append both fail.
    const blocker = join(home, "logs");
    await writeFile(blocker, "not a directory");
    const log = new DaemonLog(join(blocker, "daemon.log"));
    expect(() => log.write("this line goes nowhere")).not.toThrow();
  });

  test("report() without a stderr redirect: console once and file once", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    const path = join(home, "logs", "daemon.log");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      new DaemonLog(path).report("embedded-mode report line");
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("embedded-mode report line");
    const content = await readFile(path, "utf8");
    expect(content.trim().split("\n").length).toBe(1);
    expect(content).toContain("embedded-mode report line");
  });

  test("report() with stderr opened onto the log file writes the line once", async () => {
    // The deployed daemon's shape: stderr IS the log file, so the console leg
    // lands in the file through the fd and report() must not append a second
    // copy. Only a child process can hold that redirect honestly.
    const home = await makeTempDir("hive-dlog-home-");
    const path = join(home, "logs", "daemon.log");
    await mkdir(join(home, "logs"), { recursive: true });
    const script = join(home, "report-child.ts");
    await writeFile(
      script,
      `import { DaemonLog } from ${JSON.stringify(
        join(
          import.meta.dir,
          "..",
          "..",
          "src",
          "daemon",
          "observability",
          "daemon-log.ts",
        ),
      )};\nnew DaemonLog(process.argv[2]).report("deployed-mode report line");\n`,
    );
    const { openSync, closeSync } = await import("node:fs");
    const stderr = openSync(path, "a");
    try {
      const child = Bun.spawn(["bun", script, path], {
        stdout: "ignore",
        stderr,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      expect(await child.exited).toBe(0);
    } finally {
      closeSync(stderr);
    }
    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("deployed-mode report line");
    // The fd carried the console leg verbatim, timestamp and all — the same
    // shape an append would have written.
    expect(Number.isNaN(Date.parse((lines[0] as string).slice(0, 24)))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Daemon wiring: embedding state transitions and the startup config line land
// in the log file, and the daemon runs fine when the log dir is unwritable.
// ---------------------------------------------------------------------------

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by daemon-log tests");
  }
}

async function makeDaemon(options: {
  home: string;
  load?: () => Promise<never>;
  reconcile?: () => Promise<void>;
}) {
  Bun.env.HIVE_HOME = options.home;
  const repoRoot = await makeTempDir("hive-dlog-repo-");
  git(repoRoot, "init", "-b", "main");
  await writeFile(join(repoRoot, "README.md"), "# daemon lifecycle test\n");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");
  const episodic = new EpisodicStore(":memory:");
  const reconcile = options.reconcile;
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
    episodicStore: episodic,
    memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
    ...(options.load === undefined
      ? {}
      : { memoryEmbeddingLoad: options.load }),
    ...(reconcile === undefined
      ? {}
      : {
          reconcileOrphanedWorktrees: async () => {
            await reconcile();
            return {
              worktrees: [],
              preservedRefs: { releasable: [], kept: [] },
            };
          },
        }),
  });
  return { daemon, repoRoot };
}

describe("HiveDaemon daemon-log wiring (defect D2)", () => {
  test("the startup embedding line and a load-failure transition land in the file", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    const { daemon } = await makeDaemon({
      home,
      load: () =>
        Promise.reject(
          new Error("embedding-runtime-missing: no bundle for the test"),
        ),
    });
    daemon.start();
    try {
      // Trip the lazy load: the first write queues the projection, which
      // fails in the background and logs the UNAVAILABLE transition.
      await daemon.writeMemoryFact({
        scope: "repo",
        topic: "testing",
        title: "Daemon log visibility check",
        body: "Body.",
        source: "agent",
        evidence: "daemon-log.test.ts",
        status: "unverified",
        kind: "article",
        tags: [],
        supersedes: [],
      });
      await required(daemon.embeddingIndex).settle();
    } finally {
      // stop() must drain the startup recovery sweep; otherwise git against
      // hive-dlog-repo-* lands inside later tests that share this process.
      await daemon.stop();
    }
    const content = await readFile(join(home, "logs", "daemon.log"), "utf8");
    expect(content).toContain(
      "Hive memory embeddings: provider=local model=bge-small-en-v1.5",
    );
    expect(content).toContain("embedding-runtime-missing");
    // Every line carries its ISO timestamp prefix.
    for (const line of content.trim().split("\n")) {
      expect(Number.isNaN(Date.parse(line.slice(0, 24)))).toBe(false);
    }
  });

  test("the daemon works when the log dir is unwritable", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    // A file named "logs": the sink's mkdir/append fail, swallowed by design.
    await writeFile(join(home, "logs"), "not a directory");
    const { daemon } = await makeDaemon({
      home,
      load: () => Promise.reject(new Error("no runtime at all")),
    });
    daemon.start();
    try {
      const written = await daemon.writeMemoryFact({
        scope: "repo",
        topic: "testing",
        title: "Unwritable log dir check",
        body: "Body.",
        source: "agent",
        evidence: "daemon-log.test.ts",
        status: "unverified",
        kind: "article",
        tags: [],
        supersedes: [],
      });
      expect(written.embedding).toBe("queued");
      await required(daemon.embeddingIndex).settle();
    } finally {
      await daemon.stop();
    }
  });

  test("stop drains in-flight maintenance before returning", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    let markReconcileStarted = () => {};
    const reconcileStarted = new Promise<void>((resolve) => {
      markReconcileStarted = resolve;
    });
    let releaseReconcile = () => {};
    const reconcileRelease = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let reconcileFinished = false;
    const { daemon } = await makeDaemon({
      home,
      reconcile: async () => {
        markReconcileStarted();
        await reconcileRelease;
        reconcileFinished = true;
      },
    });
    daemon.start();
    try {
      await reconcileStarted;
      let stopped = false;
      const stopping = daemon.stop().then(() => {
        stopped = true;
        expect(reconcileFinished).toBe(true);
      });
      await Bun.sleep(50);
      expect(stopped).toBe(false);
      releaseReconcile();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      releaseReconcile();
      await daemon.stop();
    }
  });

  test("stop drains every admitted settlement write and rejects later writes", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    let markReconcileStarted = () => {};
    const reconcileStarted = new Promise<void>((resolve) => {
      markReconcileStarted = resolve;
    });
    let releaseReconcile = () => {};
    const reconcileRelease = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const { daemon, repoRoot } = await makeDaemon({
      home,
      reconcile: async () => {
        markReconcileStarted();
        await reconcileRelease;
      },
    });
    const aggregateRef = `refs/hive-settlement-aggregate/${hiveInstanceSuffix()}`;
    const sweeping = daemon.reconcileOrphanedWorktrees();
    try {
      await reconcileStarted;
      let stopped = false;
      const stopping = daemon.stop().then(() => {
        stopped = true;
      });
      await Bun.sleep(50);
      expect(stopped).toBe(false);
      expect(readRef(repoRoot, aggregateRef)).toBeNull();
      releaseReconcile();
      await Promise.all([sweeping, stopping]);
      expect(stopped).toBe(true);
      expect(readRef(repoRoot, aggregateRef)).not.toBeNull();
      await expect(daemon.reconcileOrphanedWorktrees()).rejects.toThrow(
        "worktree lifecycle service is stopped",
      );
    } finally {
      releaseReconcile();
      await sweeping.catch(() => undefined);
      await daemon.stop();
    }
  });
});
