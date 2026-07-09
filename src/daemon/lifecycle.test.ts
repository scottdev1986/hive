import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPidFilePath,
  isRunning,
  writeLifecycleFiles,
} from "./lifecycle";

describe("daemon lifecycle", () => {
  test("accepts a healthy daemon even when its pidfile is missing", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-health-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    try {
      writeLifecycleFiles(4317);
      rmSync(getPidFilePath());
      expect(await isRunning()).toEqual(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("rejects a live pid when the recorded health endpoint is absent", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-stale-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused"),
    );
    try {
      writeLifecycleFiles(4317, process.pid);
      expect(await isRunning()).toEqual(false);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });
});
