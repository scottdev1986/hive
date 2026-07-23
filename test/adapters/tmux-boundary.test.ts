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
  test("blocks known direct tmux call forms outside the adapter and SessionHost", async () => {
    const sourceRoot = join(import.meta.dir, "../../src");
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
    const directTmuxSpawn = new RegExp(
      [
        "\\b(?:spawn|spawnSync|execFile|execFileSync)\\s*\\(\\s*['\"]",
        "tm",
        "ux",
        "['\"]",
      ].join(""),
    );
    const directTmuxShell = new RegExp(
      [
        "(?:\\b(?:exec|execSync)\\s*\\(\\s*['\"`]\\s*|(?:Bun\\.)?\\$\\s*`\\s*)",
        "tm",
        "ux",
        "(?:\\s|['\"`])",
      ].join(""),
    );
    const tmuxViaShellSpawn = new RegExp(
      [
        "\\b(?:Bun\\.)?(?:spawn|spawnSync)\\s*\\(\\s*(?:\\[\\s*)?['\"](?:/bin/)?(?:sh|bash|zsh)['\"]",
        "[\\s\\S]{0,300}['\"]-l?c['\"][\\s\\S]{0,300}['\"]\\s*",
        "tm",
        "ux",
        "(?:\\s|['\"])",
      ].join(""),
    );
    const violations: string[] = [];

    expect(directTmuxSpawn.test('spawn("tmux", ["list-sessions"])')).toBe(true);
    expect(directTmuxShell.test('exec("tmux list-sessions")')).toBe(true);
    expect(directTmuxShell.test('Bun.$`tmux list-sessions`')).toBe(true);
    expect(tmuxViaShellSpawn.test(
      'spawn("sh", ["-c", "tmux list-sessions"])',
    )).toBe(true);

    for (const path of await productionTypescript(sourceRoot)) {
      const name = relative(sourceRoot, path);
      if (allowed.has(name)) continue;
      const source = await readFile(path, "utf8");
      if (adapterImport.test(source)) violations.push(`${name}: imports tmux adapter`);
      if (rawTmuxArgv.test(source)) violations.push(`${name}: constructs raw tmux argv`);
      if (directTmuxSpawn.test(source)) violations.push(`${name}: spawns tmux directly`);
      if (directTmuxShell.test(source)) violations.push(`${name}: invokes tmux in a shell string`);
      if (tmuxViaShellSpawn.test(source)) violations.push(`${name}: invokes tmux through a shell`);
    }

    // This lexical tripwire cannot catch computed executable names, dynamically
    // assembled shell strings, or wrappers/aliases that invoke tmux indirectly.
    expect(violations).toEqual([]);
  });
});
