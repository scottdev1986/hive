import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { repairIdentityFromStagedVersionProbe } from "../../src/update/bootstrap";

describe("legacy updater bootstrap", () => {
  test("a staged version probe repairs the current project", () => {
    const root = "/install";
    const executable = join(root, "versions", "0.0.28", "hive");
    let repaired = "";
    expect(repairIdentityFromStagedVersionProbe(
      [executable, "--version"],
      {
        root,
        executablePath: executable,
        cwd: "/project",
        realpath: (path) => path.includes("/current/")
          ? join(root, "versions", "0.0.25", "hive")
          : path,
        repair: (directory) => {
          repaired = directory;
          return true;
        },
      },
    )).toBe(true);
    expect(repaired).toBe("/project");
  });

  test("the current binary and non-version commands never run the bridge", () => {
    const root = "/install";
    const executable = join(root, "versions", "0.0.28", "hive");
    let calls = 0;
    const deps = {
      root,
      executablePath: executable,
      realpath: (_path: string) => executable,
      repair: () => {
        calls += 1;
        return true;
      },
    };
    expect(repairIdentityFromStagedVersionProbe([executable, "--version"], deps)).toBe(false);
    expect(repairIdentityFromStagedVersionProbe([executable, "update"], deps)).toBe(false);
    expect(calls).toBe(0);
  });
});
