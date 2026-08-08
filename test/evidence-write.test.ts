import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceWritesEnabled, writeEvidenceFile } from "./evidence-write";

/**
 * A bare `bun test` must leave checked-in evidence alone.
 *
 * The live conformance tests used to rewrite their evidence on every run, so a
 * routine full-suite run republished other agents' files and `git add -A` swept
 * them into whoever committed next — with a fresher timestamp and different
 * live-run contents, under the wrong author. These tests take the guard away
 * from convention and put it in code.
 */

const ROOT = "docs/evidence/protocol-terminal";

const evidenceFiles = (): string[] =>
  existsSync(ROOT)
    ? readdirSync(ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((dir) =>
          readdirSync(join(ROOT, dir.name))
            .filter((file) => file.startsWith("conformance"))
            .map((file) => join(ROOT, dir.name, file)),
        )
    : [];

const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("checked-in evidence survives an ordinary run", () => {
  test("writes are off unless this run was asked for them", () => {
    // The whole guard rests on this being false in a bare run. If the harness
    // ever sets the variable by default, every assertion below passes while
    // protecting nothing, so it is checked first and on its own.
    expect(process.env.HIVE_WRITE_EVIDENCE).not.toBe("1");
    expect(evidenceWritesEnabled()).toBe(false);
  });

  test("every conformance file is byte-identical after a write attempt", () => {
    const files = evidenceFiles();
    // A positive control for the scan itself: an empty list would make the
    // comparison below vacuous, and the tree has five vendors.
    expect(files.length).toBeGreaterThanOrEqual(5);
    const before = new Map(files.map((path) => [path, digest(path)]));

    for (const path of files) {
      expect(writeEvidenceFile(path, '{"clobbered":true}\n')).toBe("skipped");
    }

    for (const [path, hash] of before) {
      expect(digest(path)).toBe(hash);
    }
  });

  test("a file that does not exist is not created either", () => {
    const path = join(ROOT, "no-such-vendor", "conformance.json");
    expect(writeEvidenceFile(path, "{}\n")).toBe("skipped");
    expect(existsSync(path)).toBe(false);
  });

  test("asking for the write is what makes it happen", () => {
    // Without this the guard could be a writer that never works, and the tests
    // above would pass on a permanently broken capture path.
    const path = join(tmpdir(), `hive-evidence-${process.pid}.json`);
    const original = process.env.HIVE_WRITE_EVIDENCE;
    try {
      process.env.HIVE_WRITE_EVIDENCE = "1";
      expect(evidenceWritesEnabled()).toBe(true);
      expect(writeEvidenceFile(path, '{"captured":true}\n')).toBe("written");
      expect(readFileSync(path, "utf8")).toContain("captured");
    } finally {
      rmSync(path, { force: true });
      if (original === undefined) delete process.env.HIVE_WRITE_EVIDENCE;
      else process.env.HIVE_WRITE_EVIDENCE = original;
    }
  });
});
