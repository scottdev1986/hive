import { describe, expect, test } from "bun:test";
import { detectInstallMethod, updateCommand } from "../../src/update/paths";

const ROOT = "/Users/scott/.local/share/hive";
const method = (path: string) => detectInstallMethod(path, ROOT, true);

describe("who owns this install", () => {
  test("a binary inside the version directories is Hive's own", () => {
    expect(method(`${ROOT}/versions/0.0.7/hive`)).toEqual("native");
  });

  test("a release binary somewhere else is unmanaged, not assumed ours", () => {
    // Guessing here means rewriting a file we did not install.
    expect(method("/usr/local/bin/hive")).toEqual("unmanaged");
    expect(method("/Users/scott/Downloads/hive")).toEqual("unmanaged");
  });

  test("a source checkout is a source checkout wherever it sits", () => {
    // `bun run src/cli.ts` reports `process.execPath` as the bun binary, and a
    // dev build copied into the install root is still a dev build.
    expect(detectInstallMethod(`${ROOT}/versions/0.0.7/hive`, ROOT, false))
      .toEqual("source");
    expect(detectInstallMethod("/usr/local/bin/bun", ROOT, false)).toEqual("source");
  });

  test("a path that merely starts with the versions prefix is not inside it", () => {
    expect(method(`${ROOT}/versions-backup/0.0.7/hive`)).toEqual("unmanaged");
  });

  test("the native owner is told the native update command", () => {
    expect(updateCommand("native")).toEqual("hive update");
  });
});
