import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQAControl } from "../../src/cli/qa-control";

const originalQA = process.env.HIVE_QA;
const originalHome = process.env.HIVE_HOME;
const originalDefaultHome = process.env.HIVE_DEFAULT_HOME;

afterEach(() => {
  process.env.HIVE_QA = originalQA;
  process.env.HIVE_HOME = originalHome;
  process.env.HIVE_DEFAULT_HOME = originalDefaultHome;
});

describe("qa-control fails closed", () => {
  test("refuses before touching the mailbox without the QA gate", async () => {
    delete process.env.HIVE_QA;
    expect(await runQAControl("enumerate")).toBe(2);
  });

  test("reports no measurement when the app is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-qa-control-"));
    process.env.HIVE_QA = "1";
    process.env.HIVE_DEFAULT_HOME = home;
    try {
      expect(await runQAControl("enumerate", undefined, undefined, 20)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("addresses the install home the app watches, not a per-run instance", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-qa-control-"));
    process.env.HIVE_QA = "1";
    process.env.HIVE_DEFAULT_HOME = home;
    // What a live Workspace sees as its own HIVE_HOME. The app serves the
    // mailbox from the install home, so a request addressed here is never read.
    process.env.HIVE_HOME = join(home, "instances", "run-1");
    try {
      expect(await runQAControl("enumerate", undefined, undefined, 20)).toBe(2);
      expect(existsSync(join(home, "qa-control", "request.json"))).toBe(true);
      expect(existsSync(join(home, "instances", "run-1", "qa-control"))).toBe(
        false,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
