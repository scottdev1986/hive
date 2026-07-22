import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatDaemonStartupAnnouncement,
  parseDaemonStartupAnnouncement,
} from "../src/daemon/startup-announcement";
import { assertBinaryFreshness, observeAnnouncement } from "./verify-dev-run";

const announcement = {
  engineBuildId: "ab".repeat(32),
  binaryPath: "/tmp/hive dev/hive",
  sourceHash: "cd".repeat(32),
};

describe("make run verification", () => {
  test("round-trips the daemon's in-process build id and absolute binary path", () => {
    const line = formatDaemonStartupAnnouncement(announcement);
    expect(line).toContain(announcement.engineBuildId);
    expect(line).toContain(announcement.binaryPath);
    expect(parseDaemonStartupAnnouncement(line)).toEqual(announcement);
  });

  test("rejects announcements without a valid build id or absolute path", () => {
    expect(parseDaemonStartupAnnouncement(
      'Hive daemon ready: {"engineBuildId":"debug","binaryPath":"relative/hive"}',
    )).toBeNull();
  });

  test("surfaces an exited daemon's lock error without waiting for the timeout", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "hive-run-exit-"));
    const log = join(fixture, "daemon.log");
    const child = Bun.spawn([process.execPath, "-e", "process.exit(1)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writeFileSync(log, "hive: Could not acquire Hive daemon lock at /tmp/daemon.lock\n");
      await child.exited;
      const startedAt = Date.now();
      await expect(observeAnnouncement(log, child.pid, 5_000)).rejects.toThrow(
        "Could not acquire Hive daemon lock",
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("negative control: a live silent daemon still reaches the bounded timeout", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "hive-run-live-"));
    const log = join(fixture, "daemon.log");
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writeFileSync(log, "hive: planted diagnostic while still starting\n");
      await expect(observeAnnouncement(log, child.pid, 75)).rejects.toThrow(
        "did not observe the daemon startup announcement",
      );
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("accepts matching build-input content after unrelated commits", () => {
    const builtSourceHash = "12".repeat(32);
    expect(() =>
      assertBinaryFreshness("/tmp/hive", builtSourceHash, builtSourceHash)
    ).not.toThrow();
  });

  test("positive control: changed build-input content fires and names both hashes", () => {
    expect(() =>
      assertBinaryFreshness("/tmp/hive", "12".repeat(32), "34".repeat(32))
    ).toThrow("built from source 12121212, current source is 34343434");
  });
});
