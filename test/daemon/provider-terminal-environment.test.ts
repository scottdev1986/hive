import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerTerminalEnvironment } from "../../src/daemon/session-host/provider-terminal-environment";
import { bundledTerminfoPath } from "../../src/daemon/session-host/terminfo";
import { tempRoot } from "../temp-root";

const repoTerminfo = join(import.meta.dir, "..", "..", "resources", "terminfo");

function writeTerminfoTree(root: string): string {
  const tree = join(root, "resources", "terminfo");
  mkdirSync(join(tree, "x"), { recursive: true });
  writeFileSync(join(tree, "x", "xterm-ghostty"), "xterm-ghostty\n");
  return tree;
}

function fakeSessiond(dir: string): string {
  const path = join(dir, "hive-sessiond");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("providerTerminalEnvironment", () => {
  test("keeps launcher NO_COLOR out of the interactive provider terminal", () => {
    const env = providerTerminalEnvironment({
      PATH: "/bin",
      NO_COLOR: "1",
      EMPTY: undefined,
    });
    expect(env.PATH).toBe("/bin");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.EMPTY).toBeUndefined();
    expect(env.TERM).toBe("xterm-ghostty");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.TERMINFO).toBe(repoTerminfo);
    expect(env.TERMINFO_DIRS?.startsWith(`${repoTerminfo}:`)).toBe(true);
  });

  test("does not copy terminfo into the machine hive home", () => {
    const home = tempRoot("hive-terminfo-home-");
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const env = providerTerminalEnvironment({ PATH: "/bin" });
      expect(existsSync(join(home, "terminfo"))).toBe(false);
      expect(env.TERMINFO).toBe(repoTerminfo);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
    }
  });
});

describe("bundledTerminfoPath", () => {
  test("uses the repository tree in a source checkout", () => {
    const root = tempRoot("hive-terminfo-repo-");
    const tree = writeTerminfoTree(root);
    expect(
      bundledTerminfoPath({
        env: {},
        repoRoot: root,
        isReleaseBuild: false,
        execPath: join(root, "missing", "hive"),
      }),
    ).toBe(tree);
  });

  test("uses the tree next to hive-sessiond in a release install", () => {
    const root = tempRoot("hive-terminfo-release-");
    const tree = writeTerminfoTree(root);
    fakeSessiond(root);
    expect(
      bundledTerminfoPath({
        env: {},
        execPath: join(root, "hive"),
        repoRoot: tempRoot("hive-terminfo-empty-"),
        isReleaseBuild: true,
      }),
    ).toBe(tree);
  });

  test("refuses to invent a path when the tree is missing", () => {
    const root = tempRoot("hive-terminfo-missing-");
    expect(() =>
      bundledTerminfoPath({
        env: {},
        repoRoot: root,
        execPath: join(root, "hive"),
        isReleaseBuild: true,
      }),
    ).toThrow("Hive bundled terminfo not found");
  });
});
