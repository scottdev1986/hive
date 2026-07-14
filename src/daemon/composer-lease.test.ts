import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composerLeasePath, isComposerLeased } from "./composer-lease";

describe("composer leases", () => {
  test("is scoped to one Hive home and recipient", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-composer-"));
    try {
      const marker = composerLeasePath("maya", home);
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(marker, "");
      expect(isComposerLeased("maya", home)).toBe(true);
      expect(isComposerLeased("orchestrator", home)).toBe(false);
      expect(isComposerLeased("maya", `${home}-other`)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails closed for a recipient that could escape the marker directory", () => {
    expect(() => composerLeasePath("../other", "/tmp/hive"))
      .toThrow("Invalid composer recipient");
    expect(isComposerLeased("../other", "/tmp/hive")).toBe(true);
  });
});
