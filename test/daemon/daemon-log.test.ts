// The durable daemon warning sink (defect D2): timestamped appends to
// $HIVE_HOME/logs/daemon.log, size-capped single-rollover rotation, and the
// never-break-the-daemon contract (an unwritable log dir is a no-op), plus
// the daemon-level wiring that lands embedding state transitions in the file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLog, daemonLogPath } from "../../src/daemon/daemon-log";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import { HiveDaemon } from "../../src/daemon/server";
import { HiveDatabase } from "../../src/daemon/db";
import type { SpawnRequest, Spawner } from "../../src/daemon/spawner";
import type { AgentRecord } from "../../src/schemas";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;

beforeEach(() => {
  previousHiveHome = Bun.env.HIVE_HOME;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("DaemonLog", () => {
  test("appends an ISO-timestamped line under $HIVE_HOME/logs/daemon.log", async () => {
    const home = await makeTempDir("hive-dlog-home-");
    Bun.env.HIVE_HOME = home;
    const log = new DaemonLog();
    log.write("Hive memory embeddings: UNAVAILABLE — test line");
    const content = await readFile(
      join(home, "logs", "daemon.log"),
      "utf8",
    );
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

class NoopTmux {
  async hasSession(_session: string): Promise<boolean> {
    return false;
  }
  async capturePane(_session: string): Promise<string> {
    return "";
  }
  async killSession(_session: string): Promise<void> {}
  async newSession(
    _name: string,
    _cwd: string,
    _command: string,
  ): Promise<void> {}
}

async function makeDaemon(options: {
  home: string;
  load?: () => Promise<never>;
}) {
  Bun.env.HIVE_HOME = options.home;
  const repoRoot = await makeTempDir("hive-dlog-repo-");
  const episodic = new EpisodicStore(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    tmux: new NoopTmux(),
    repoRoot,
    episodicStore: episodic,
    memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
    ...(options.load === undefined
      ? {}
      : { memoryEmbeddingLoad: options.load }),
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
      await daemon.embeddingIndex!.settle();
    } finally {
      await daemon.stop();
    }
    const content = await readFile(
      join(home, "logs", "daemon.log"),
      "utf8",
    );
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
      await daemon.embeddingIndex!.settle();
    } finally {
      await daemon.stop();
    }
  });
});
