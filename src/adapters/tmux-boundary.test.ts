import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function productionTypescript(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionTypescript(path));
    else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("tmux adapter boundary", () => {
  test("production tmux calls stay inside the adapter and SessionHost", async () => {
    const sourceRoot = join(import.meta.dir, "..");
    const allowed = new Set([
      "adapters/tmux.ts",
      "daemon/session-host/tmux-host.ts",
    ]);
    const adapterImport = new RegExp(
      ["(?:from|import\\s*\\()\\s*['\"]", "[^'\"]*adapters/tmux", "['\"]"].join(""),
    );
    const rawTmuxArgv = new RegExp(
      [
        "\\[\\s*['\"]",
        "tm",
        "ux",
        "['\"]\\s*,\\s*['\"](?:-L|new-|has-|kill-|capture-|send-|list-|display-|resize-|load-|paste-|set-)",
      ].join(""),
    );
    const violations: string[] = [];

    for (const path of await productionTypescript(sourceRoot)) {
      const name = relative(sourceRoot, path);
      if (allowed.has(name)) continue;
      const source = await readFile(path, "utf8");
      if (adapterImport.test(source)) violations.push(`${name}: imports tmux adapter`);
      if (rawTmuxArgv.test(source)) violations.push(`${name}: constructs raw tmux argv`);
    }

    expect(violations).toEqual([]);
  });
});
