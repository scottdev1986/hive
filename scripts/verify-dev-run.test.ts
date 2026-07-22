import { describe, expect, test } from "bun:test";
import {
  formatDaemonStartupAnnouncement,
  parseDaemonStartupAnnouncement,
} from "../src/daemon/startup-announcement";
import { assertBinaryFreshness } from "./verify-dev-run";

const announcement = {
  engineBuildId: "ab".repeat(32),
  binaryPath: "/tmp/hive dev/hive",
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

  test("accepts a binary built at or after HEAD", () => {
    expect(() => assertBinaryFreshness("/tmp/hive", 2_000, 2_000)).not.toThrow();
    expect(() => assertBinaryFreshness("/tmp/hive", 2_001, 2_000)).not.toThrow();
  });

  test("positive control: an older binary fires and names both timestamps", () => {
    expect(() => assertBinaryFreshness("/tmp/hive", 1_000, 2_000)).toThrow(
      "binary mtime 1970-01-01T00:00:01.000Z predates HEAD commit time 1970-01-01T00:00:02.000Z",
    );
  });
});
