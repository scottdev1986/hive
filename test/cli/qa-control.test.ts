import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQAControl } from "../../src/cli/qa-control";

const originalQA = process.env.HIVE_QA;
const originalHome = process.env.HIVE_HOME;

afterEach(() => {
  process.env.HIVE_QA = originalQA;
  process.env.HIVE_HOME = originalHome;
});

describe("qa-control fails closed", () => {
  test("refuses before touching the mailbox without the QA gate", async () => {
    delete process.env.HIVE_QA;
    expect(await runQAControl("enumerate")).toBe(2);
  });

  test("reports no measurement when the app is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-qa-control-"));
    process.env.HIVE_QA = "1";
    process.env.HIVE_HOME = home;
    try {
      expect(await runQAControl("enumerate", undefined, undefined, 20)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
