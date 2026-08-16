import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  MainHealthMonitor,
  type MainHealthResult,
  readPrimaryRevision,
  watchPrimaryRefMove,
} from "../../src/daemon/landing/main-health-monitor";
import { MailService } from "../../src/mail-service/service";
import { MailStore } from "../../src/mail-service/store";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const green: MainHealthResult = { ok: true, detail: "" };
const red: MainHealthResult = { ok: false, detail: "one test failed" };

test("the daemon does not compile in a Hive-repo suite", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../src/daemon/server.ts"),
    "utf8",
  );
  expect(source).not.toContain("runMainBunTests");
  expect(source).not.toContain("scripts/test-sandbox.ts");
  expect(source).not.toContain("bun test");
});

const git = async (root: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
};

const commitTestRepo = async (root: string): Promise<string> => {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "main-health@example.test");
  await git(root, "config", "user.name", "Main Health");
  await writeFile(join(root, ".gitignore"), "scratch-path\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return readPrimaryRevision(root);
};

describe("MainHealthMonitor", () => {
  test("announces a stable red revision once", async () => {
    const notifications: Array<{ revision: string; detail: string }> = [];
    let runs = 0;
    const monitor = new MainHealthMonitor({
      readRevision: async () => "bad-sha",
      runTests: async () => {
        runs += 1;
        return red;
      },
      notifyRed: async (revision, detail) => {
        notifications.push({ revision, detail });
      },
      notifyDeclined: async () => {},
      log: () => {},
    });

    await monitor.checkNow();
    await monitor.checkNow();

    expect(runs).toBe(1);
    expect(notifications).toEqual([
      { revision: "bad-sha", detail: "one test failed" },
    ]);
  });

  test("a deliberately red revision is durably queued for queen", async () => {
    const db = new HiveDatabase(":memory:");
    const store = new MailStore(db);
    const mail = new MailService({
      store,
      recipients: (named) =>
        named === ORCHESTRATOR_NAME
          ? { kind: "live", canonical: ORCHESTRATOR_NAME }
          : { kind: "absent" },
    });
    const monitor = new MainHealthMonitor({
      readRevision: async () => "deliberately-broken-sha",
      runTests: async () => red,
      notifyRed: (revision, detail) =>
        mail.publishSystem(
          "hive-main-health",
          ORCHESTRATOR_NAME,
          `RED MAIN at ${revision}.\n${detail}`,
          { idempotencyKey: `hive-main-health:red:${revision}` },
        ),
      notifyDeclined: async () => {},
      log: () => {},
    });
    try {
      await monitor.checkNow();
      const queued = store.listAvailable(
        ORCHESTRATOR_NAME,
        "control",
        0,
        10,
        new Date().toISOString(),
      );

      expect(queued).toHaveLength(1);
      expect(queued[0]?.sender).toBe("hive-main-health");
      expect(queued[0]?.body).toContain("deliberately-broken-sha");
      expect(queued[0]?.body).toContain("one test failed");
    } finally {
      db.close();
    }
  });

  test("discards a result when main moves and checks the new revision", async () => {
    let revision = "old-sha";
    const checked: string[] = [];
    const notifications: string[] = [];
    const monitor = new MainHealthMonitor({
      readRevision: async () => revision,
      runTests: async () => {
        checked.push(revision);
        if (revision === "old-sha") {
          revision = "new-sha";
          return red;
        }
        return green;
      },
      notifyRed: async (sha) => {
        notifications.push(sha);
      },
      notifyDeclined: async () => {},
      log: () => {},
    });

    await monitor.checkNow();

    expect(checked).toEqual(["old-sha", "new-sha"]);
    expect(notifications).toEqual([]);
  });

  test("retries a refused notification without rerunning the suite", async () => {
    let runs = 0;
    let attempts = 0;
    const monitor = new MainHealthMonitor({
      readRevision: async () => "bad-sha",
      runTests: async () => {
        runs += 1;
        return red;
      },
      notifyRed: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("control lane busy");
      },
      notifyDeclined: async () => {},
      log: () => {},
    });

    await monitor.checkNow();
    await monitor.checkNow();

    expect(runs).toBe(1);
    expect(attempts).toBe(2);
  });

  test("an idle monitor reads the ref it booted on and then nothing", async () => {
    let reads = 0;
    const monitor = new MainHealthMonitor({
      readRevision: async () => {
        reads += 1;
        return "sha";
      },
      runTests: async () => green,
      notifyRed: async () => {},
      notifyDeclined: async () => {},
      log: () => {},
      // Small enough that a monitor which still armed a repeating timer would
      // have fired it many times inside the wait below.
      retryMs: 5,
    });

    monitor.start();
    await Bun.sleep(120);

    // The boot check reads the ref twice — once to pick the revision, once to
    // confirm main did not move under the suite — and then never again.
    expect(reads).toBe(2);
    await monitor.stop();
  });

  test("a refused report re-offers itself, and a delivered one arms nothing", async () => {
    let runs = 0;
    let attempts = 0;
    const monitor = new MainHealthMonitor({
      readRevision: async () => "bad-sha",
      runTests: async () => {
        runs += 1;
        return red;
      },
      notifyRed: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("control lane busy");
      },
      notifyDeclined: async () => {},
      log: () => {},
      retryMs: 5,
    });

    await monitor.checkNow();
    await Bun.sleep(120);

    // The retry is the monitor's own doing — nothing called checkNow again —
    // and once the report lands there is no timer left to fire a third time.
    expect(attempts).toBe(2);
    expect(runs).toBe(1);
    await monitor.stop();
  });

  test("a report the control lane keeps refusing never holds the process open", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-exit-"));
    const script = join(root, "pending-report.ts");
    const modulePath = join(
      import.meta.dir,
      "../../src/daemon/landing/main-health-monitor.ts",
    );
    await writeFile(
      script,
      `import { MainHealthMonitor } from ${JSON.stringify(modulePath)};\n` +
        `const monitor = new MainHealthMonitor({\n` +
        `  readRevision: async () => "bad-sha",\n` +
        `  runTests: async () => ({ ok: false, detail: "one test failed" }),\n` +
        `  notifyRed: async () => { throw new Error("control lane busy"); },\n` +
        `  notifyDeclined: async () => {},\n` +
        `  log: () => {},\n` +
        `});\n` +
        `await monitor.checkNow();\n` +
        `console.log("report is pending");\n`,
    );
    try {
      const child = Bun.spawn(["bun", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(15_000).then(() => "still running" as const),
      ]);
      if (exitCode === "still running") child.kill("SIGKILL");
      const stdout = await new Response(child.stdout).text();

      expect(stdout).toContain("report is pending");
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stop aborts an active test run", async () => {
    let aborted = false;
    const monitor = new MainHealthMonitor({
      readRevision: async () => "sha",
      runTests: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(green);
            },
            { once: true },
          );
        }),
      notifyRed: async () => {},
      notifyDeclined: async () => {},
      log: () => {},
    });

    const check = monitor.checkNow();
    await Promise.resolve();
    await monitor.stop();
    await check;

    expect(aborted).toBe(true);
  });

  test("watchPrimaryRefMove fires on a ref change and stops after disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "main-health-watch-primitive-"));
    try {
      await commitTestRepo(root);
      let changes = 0;
      const logs: string[] = [];
      const dispose = await watchPrimaryRefMove(
        root,
        () => {
          changes += 1;
        },
        (message) => logs.push(message),
      );
      expect(dispose).not.toBeNull();

      await writeFile(join(root, "note.txt"), "one\n");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "first");
      await Bun.sleep(500);
      expect(changes).toBeGreaterThanOrEqual(1);

      dispose?.();
      const changesAtDisposal = changes;
      await writeFile(join(root, "note.txt"), "two\n");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "second");
      await Bun.sleep(500);

      // Disposal really stops the watch — it does not just stop mattering.
      expect(changes).toBe(changesAtDisposal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("watchPrimaryRefMove degrades gracefully outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "main-health-watch-nogit-"));
    try {
      const logs: string[] = [];
      const dispose = await watchPrimaryRefMove(
        root,
        () => {},
        (message) => logs.push(message),
      );
      expect(dispose).toBeNull();
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("start arms the external-move watch and stop disposes it", async () => {
    let armed = 0;
    let disposed = 0;
    const monitor = new MainHealthMonitor({
      readRevision: async () => "sha",
      runTests: async () => green,
      notifyRed: async () => {},
      notifyDeclined: async () => {},
      log: () => {},
      watchExternalMove: async () => {
        armed += 1;
        return () => {
          disposed += 1;
        };
      },
    });

    monitor.start();
    await Bun.sleep(20);
    expect(armed).toBe(1);

    await monitor.stop();
    expect(disposed).toBe(1);
  });

  test("a direct commit to main is picked up without an explicit checkNow", async () => {
    const root = await mkdtemp(join(tmpdir(), "main-health-watch-direct-"));
    try {
      const firstRevision = await commitTestRepo(root);
      const checked: string[] = [];
      const monitor = new MainHealthMonitor({
        readRevision: () => readPrimaryRevision(root),
        runTests: async () => {
          checked.push(await readPrimaryRevision(root));
          return green;
        },
        notifyRed: async () => {},
        notifyDeclined: async () => {},
        log: () => {},
        watchExternalMove: (onChange) =>
          watchPrimaryRefMove(root, onChange, () => {}),
      });

      monitor.start();
      await Bun.sleep(200); // let the boot check settle on firstRevision

      // A commit made straight into the checkout, the way the owner works —
      // nothing calls checkNow() for it.
      await writeFile(join(root, "note.txt"), "second\n");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "direct commit");
      const secondRevision = await readPrimaryRevision(root);

      await Bun.sleep(500); // fs.watch is a real OS event; give it room to arrive
      await monitor.stop();

      expect(secondRevision).not.toBe(firstRevision);
      expect(checked).toContain(secondRevision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the ref watcher and an explicit checkNow after a landing do not double-check the same revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "main-health-watch-dup-"));
    try {
      await commitTestRepo(root);
      const runsByRevision: Record<string, number> = {};
      const monitor = new MainHealthMonitor({
        readRevision: () => readPrimaryRevision(root),
        runTests: async () => {
          const revision = await readPrimaryRevision(root);
          runsByRevision[revision] = (runsByRevision[revision] ?? 0) + 1;
          return green;
        },
        notifyRed: async () => {},
        notifyDeclined: async () => {},
        log: () => {},
        watchExternalMove: (onChange) =>
          watchPrimaryRefMove(root, onChange, () => {}),
      });

      monitor.start();
      await Bun.sleep(200);

      // A landing: the branch moves, and landing-service.ts calls checkNow()
      // itself — the same ref change the watcher will also see.
      await writeFile(join(root, "note.txt"), "landed\n");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "landing");
      const landedRevision = await readPrimaryRevision(root);
      await monitor.checkNow();

      await Bun.sleep(500);
      await monitor.stop();

      expect(runsByRevision[landedRevision]).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
