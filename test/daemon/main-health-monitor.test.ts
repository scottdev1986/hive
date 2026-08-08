import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeDirtyCheckout,
  type DirtyCheckout,
  MainHealthMonitor,
  type MainHealthResult,
  readPrimaryRevision,
  runMainBunTests,
  SuiteNeverStartedError,
  watchPrimaryRefMove,
} from "../../src/daemon/landing/main-health-monitor";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { MailService } from "../../src/mail-service/service";
import { MailStore } from "../../src/mail-service/store";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const green: MainHealthResult = { ok: true, detail: "" };
const red: MainHealthResult = { ok: false, detail: "one test failed" };

// Settle budgets the fixtures hand the runner in place of its production one.
// A checkout that clears needs a budget comfortably past the window it stays
// dirty for; one that never clears only needs long enough to be re-read, so it
// gets a short budget and the test does not sit out the real one.
const TRANSIENT_WINDOW_MS = 1_500;
const SETTLE_PAST_WINDOW_MS = 6_000;
const SETTLE_BRIEF_MS = 500;
/** A budget no fixture here should ever reach, so reaching it is a failure rather than a slow pass. */
const UNREACHED_BUDGET_MS = 60_000;

// runMainBunTests always spawns through scripts/test-sandbox.ts, the real
// bounded-root entry point (see main-health-monitor.ts). The real script
// mounts a size-capped macOS volume and installs a host sandbox — unsuitable
// for a fixture that wants its own disposable root. This stub keeps the same `-- <command>`
// contract (forward argv, inherit env and stdio, relay the exit code) so a
// fixture still exercises the real spawn call in main-health-monitor.ts.
const installTestSandboxStub = async (root: string): Promise<void> => {
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "test-sandbox.ts"),
    `const args = process.argv.slice(2);\n` +
      `const command = args[0] === "--" ? args.slice(1) : args;\n` +
      `const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });\n` +
      `process.exit(await child.exited);\n`,
  );
};

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
          `RED MAIN: bun test failed at ${revision}.\n${detail}`,
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

  test("reports a genuinely broken committed revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-committed-"));
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "broken.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("committed failure", () => { expect(1).toBe(2); });\n`,
    );
    const revision = await commitTestRepo(root);
    const notifications: Array<{ revision: string; detail: string }> = [];
    const monitor = new MainHealthMonitor({
      readRevision: () => readPrimaryRevision(root),
      runTests: (signal) => runMainBunTests(root, signal),
      notifyRed: async (reportedRevision, detail) => {
        notifications.push({ revision: reportedRevision, detail });
      },
      notifyDeclined: async () => {},
      log: () => {},
    });
    try {
      await monitor.checkNow();

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.revision).toBe(revision);
      expect(notifications[0]?.detail).toContain("1 fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("declines an unmeasured revision once for an untracked dirty test failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-dirty-"));
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "passing.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("committed pass", () => { expect(1).toBe(1); });\n`,
    );
    const revision = await commitTestRepo(root);
    await writeFile(
      join(root, "dirty-failure.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("uncommitted failure", () => { expect(1).toBe(2); });\n`,
    );
    const notifications: Array<{ revision: string; detail: string }> = [];
    const declines: Array<{ revision: string; dirty: DirtyCheckout }> = [];
    const logs: string[] = [];
    const monitor = new MainHealthMonitor({
      readRevision: () => readPrimaryRevision(root),
      runTests: (signal) => runMainBunTests(root, signal, SETTLE_BRIEF_MS),
      notifyRed: async (reportedRevision, detail) => {
        notifications.push({ revision: reportedRevision, detail });
      },
      notifyDeclined: async (declinedRevision, dirty) => {
        declines.push({ revision: declinedRevision, dirty });
      },
      log: (message) => logs.push(message),
    });
    try {
      await monitor.checkNow();
      await monitor.checkNow();

      expect(notifications).toEqual([]);
      expect(declines).toEqual([
        {
          revision,
          dirty: {
            paths: ["?? dirty-failure.test.ts"],
            settleWaitMs: SETTLE_BRIEF_MS,
          },
        },
      ]);
      expect(logs).toEqual([]);
      // The notice has to say which of the two states it found, because a
      // decline nobody can attribute to a file cannot be acted on.
      const notice = declines
        .map((decline) => describeDirtyCheckout(decline.dirty))
        .join("");
      expect(notice).toContain("?? dirty-failure.test.ts");
      expect(notice).toContain("rather than a write still in flight");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a declined revision stays unmeasured after the checkout goes clean", async () => {
    // Pins a decision rather than guarding a live path. Production cannot
    // reach this state by itself: the checkedRevision guard already blocks a
    // second check of the same revision no matter what triggers it, so the
    // test calls checkNow() directly to force that guard's branch. The guard
    // is here so that changing that costs a deliberate edit to this test.
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-final-"));
    await installTestSandboxStub(root);
    // Committed RED, so a second measurement would announce itself as a red
    // notification. Without that, "nothing happened" and "it measured a green
    // tree" would look identical here.
    await writeFile(
      join(root, "broken.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("committed failure", () => { expect(1).toBe(2); });\n`,
    );
    const revision = await commitTestRepo(root);
    const uncommitted = join(root, "left-behind.tmp");
    await writeFile(uncommitted, "work left in the checkout");
    const declines: string[] = [];
    const notifications: string[] = [];
    const monitor = new MainHealthMonitor({
      readRevision: () => readPrimaryRevision(root),
      runTests: (signal) => runMainBunTests(root, signal, SETTLE_BRIEF_MS),
      notifyRed: async (reportedRevision) => {
        notifications.push(reportedRevision);
      },
      notifyDeclined: async (declinedRevision) => {
        declines.push(declinedRevision);
      },
      log: () => {},
    });
    try {
      await monitor.checkNow();
      await rm(uncommitted);
      await monitor.checkNow();

      expect(declines).toEqual([revision]);
      // The committed suite is red, so an empty list is the suite never having
      // run a second time — not a second run that found nothing wrong.
      expect(notifications).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("measures a revision across a dirty window that clears", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-transient-"));
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "passing.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("committed pass", () => { expect(1).toBe(1); });\n`,
    );
    await commitTestRepo(root);
    // Stands in for a write that is already in flight when the check starts:
    // present before the first look, gone well after it. The clearing is on a
    // timer rather than tied to an observation so the window is the same
    // length whatever the machine is doing.
    const inFlight = join(root, "in-flight.tmp");
    await writeFile(inFlight, "a write that has not finished yet");
    const cleared = Bun.sleep(TRANSIENT_WINDOW_MS).then(() => rm(inFlight));
    try {
      const started = Bun.nanoseconds();
      const result = await runMainBunTests(
        root,
        new AbortController().signal,
        SETTLE_PAST_WINDOW_MS,
      );
      const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
      await cleared;

      expect(result.ok).toBe(true);
      // Positive control on the test itself: finishing sooner than the window
      // would mean the check never saw the file, so a pass would prove nothing
      // about waiting for it.
      expect(elapsedMs).toBeGreaterThanOrEqual(TRANSIENT_WINDOW_MS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a settle wait ends the moment its caller aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-settle-stop-"));
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "passing.test.ts"),
      `import { expect, test } from "bun:test";\n` +
        `test("committed pass", () => { expect(1).toBe(1); });\n`,
    );
    await commitTestRepo(root);
    await writeFile(join(root, "never-clears.tmp"), "work left in the tree");
    const abort = new AbortController();
    try {
      const started = Bun.nanoseconds();
      const run = runMainBunTests(root, abort.signal, UNREACHED_BUDGET_MS);
      await Bun.sleep(TRANSIENT_WINDOW_MS);
      abort.abort();
      await expect(run).rejects.toThrow("primary checkout is dirty");
      const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

      // Stopping the daemon must not have to sit out the budget first.
      expect(elapsedMs).toBeLessThan(UNREACHED_BUDGET_MS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the production runner bounds scratch data and removes it after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-test-"));
    const marker = join(root, "scratch-path");
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "failure.test.ts"),
      `import { test, expect } from "bun:test";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `test("fails", () => { writeFileSync(${JSON.stringify(marker)}, process.env.TMPDIR ?? ""); expect(1).toBe(2); });\n`,
    );
    await commitTestRepo(root);
    try {
      const result = await runMainBunTests(root, new AbortController().signal);
      const scratch = await readFile(marker, "utf8");

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("1 fail");
      expect(existsSync(scratch)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the production runner kills its process group and cleans scratch on abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-abort-"));
    const marker = join(root, "scratch-path");
    await installTestSandboxStub(root);
    await writeFile(
      join(root, "hang.test.ts"),
      `import { test } from "bun:test";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `test("hangs", async () => { writeFileSync(${JSON.stringify(marker)}, process.env.TMPDIR ?? ""); await new Promise(() => {}); });\n`,
    );
    await commitTestRepo(root);
    const abort = new AbortController();
    try {
      const run = runMainBunTests(root, abort.signal);
      for (
        let attempt = 0;
        attempt < 100 && !existsSync(marker);
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      abort.abort();
      await run;
      const scratch = await readFile(marker, "utf8");

      expect(existsSync(scratch)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a suite that never executes a test body throws instead of reporting red", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-never-"));
    await installTestSandboxStub(root);
    // Reproduces the real defect's mechanics directly: a bunfig preload that
    // throws before any test file loads, the same shape test/test-root-preload.ts
    // produces when HIVE_TEST_ROOT is unset. bun reports this as "0 pass / N
    // fail / N errors" with no test ever executed — this is real bun output,
    // not a stand-in for it.
    await writeFile(
      join(root, "bunfig.toml"),
      `[test]\npreload = ["./broken-preload.ts"]\n`,
    );
    await writeFile(
      join(root, "broken-preload.ts"),
      `throw new Error("simulated setup failure, unrelated to the guard's own text");\n`,
    );
    await writeFile(
      join(root, "a.test.ts"),
      `import { test, expect } from "bun:test";\n` +
        `test("a", () => { expect(1).toBe(1); });\n`,
    );
    await writeFile(
      join(root, "b.test.ts"),
      `import { test, expect } from "bun:test";\n` +
        `test("b", () => { expect(1).toBe(1); });\n`,
    );
    await commitTestRepo(root);
    try {
      await expect(
        runMainBunTests(root, new AbortController().signal),
      ).rejects.toBeInstanceOf(SuiteNeverStartedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a suite runner that dies before printing any summary also throws instead of reporting red", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-main-health-nosummary-"));
    // No bun-test output at all — not even a truncated one. This stands in
    // for a spawn failure or a crash before bun test prints its summary: the
    // detection reads every missing count as zero, so an absent summary is
    // never-started for the same reason a guard-refused one is, with no
    // special case required.
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "scripts", "test-sandbox.ts"),
      `console.error("could not exec bun test: simulated setup crash");\n` +
        `process.exit(127);\n`,
    );
    await commitTestRepo(root);
    try {
      await expect(
        runMainBunTests(root, new AbortController().signal),
      ).rejects.toBeInstanceOf(SuiteNeverStartedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
