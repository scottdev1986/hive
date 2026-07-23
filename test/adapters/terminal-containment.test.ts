import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

describe("terminal containment", () => {
  test("src cannot launch or track a terminal outside Workspace", async () => {
    const forbidden = [
      ["Terminal", ".app"].join(""),
      ["i", "Term"].join(""),
      ["osa", "script"].join(""),
      ["x-terminal", "-emulator"].join(""),
      ["Terminal", "Handle"].join(""),
      ["terminal", "Handle"].join(""),
      ["resolve", "Terminal"].join(""),
    ];
    const violations: string[] = [];
    for (const path of await sourceFiles(join(import.meta.dir, "../../src"))) {
      const source = await readFile(path, "utf8");
      for (const token of forbidden) {
        if (source.includes(token)) {
          violations.push(`${relative(join(import.meta.dir, "../../src"), path)}: ${token}`);
        }
      }
      const externalOpen = new RegExp(
        ["open", "\\s+-a\\s+", "(?:Terminal|i", "Term2?)"].join(""),
        "i",
      );
      if (externalOpen.test(source)) {
        violations.push(`${relative(join(import.meta.dir, "../../src"), path)}: external open -a`);
      }
    }
    expect(violations).toEqual([]);
  });
});
