/**
 * Staged-CLI proof that broker-start failure after daemon.port is written
 * does NOT advertise-then-fail: process exits non-zero and leaves no
 * daemon.port / daemon.pid / daemon.lock.
 *
 * Skips when make build has not staged .dev/root/current/{hive,hive-sessiond}.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const stagedHive = join(repoRoot, ".dev/root/current/hive");
const stagedSessiond = join(repoRoot, ".dev/root/current/hive-sessiond");
const describeIfStaged =
  existsSync(stagedHive) && existsSync(stagedSessiond) ? describe : describe.skip;

function shortHome(tag: string): string {
  const home = `/tmp/hsf-${tag}-${Math.random().toString(16).slice(2, 6)}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

describeIfStaged("sessiond broker startup fail-loud (staged CLI)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    homes.length = 0;
  });

  test("orphan broker.sock: daemon exits 1 with no daemon.port left", async () => {
    const home = shortHome("or");
    homes.push(home);

    const orphan = Bun.spawn([stagedSessiond, "serve"], {
      env: { ...process.env, HIVE_HOME: home },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const sock = join(home, "runtime/sessiond/broker.sock");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(sock) && orphan.exitCode === null) break;
      if (orphan.exitCode !== null) {
        throw new Error(`orphan exited ${orphan.exitCode} before ready`);
      }
      await Bun.sleep(20);
    }
    expect(existsSync(sock)).toBe(true);

    const daemon = Bun.spawn([stagedHive, "daemon"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HIVE_HOME: home,
        HIVE_INSTALL_ROOT: join(repoRoot, ".dev/root"),
        HIVE_PORT: "0",
        HIVE_PROJECT_ROOT: repoRoot,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await daemon.exited;
    const err = await new Response(daemon.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(1);
    expect(existsSync(join(home, "daemon.port"))).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
    expect(err).toMatch(/sessiond broker failed to start|kernel peer pid/);

    try {
      orphan.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([orphan.exited, Bun.sleep(2_000)]);
  }, 60_000);
});
