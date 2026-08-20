import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindCliHiveHome,
  cliCommandKeepsMachineHome,
} from "../../src/cli/bind-hive-home";
import { requireDaemonPort } from "../../src/cli/control";
import {
  namedInstanceHome,
  repoInstanceName,
} from "../../src/daemon/lifecycle/instances";
import { projectKey } from "../../src/daemon/project-identity-core/state";
import { getHiveHome } from "../../src/hive-home/home";

const originalHiveHome = process.env.HIVE_HOME;
const originalDefaultHome = process.env.HIVE_DEFAULT_HOME;

let machineHome: string;

beforeAll(async () => {
  machineHome = await mkdtemp(join(tmpdir(), "hive-cli-home-"));
  process.env.HIVE_DEFAULT_HOME = machineHome;
  process.env.HIVE_HOME = machineHome;
});

afterAll(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  if (originalDefaultHome === undefined) delete process.env.HIVE_DEFAULT_HOME;
  else process.env.HIVE_DEFAULT_HOME = originalDefaultHome;
  await rm(machineHome, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

async function bareRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-cli-repo-"));
  git(root, ["init"]);
  await writeFile(join(root, "README.md"), "repo\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init", "--no-gpg-sign"]);
  return root;
}

function writePort(home: string, port: number): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "daemon.port"), `${port}\n`);
}

describe("CLI Hive-home resolution", () => {
  test("hive routing export's port lookup reads the repo-instance daemon.port, not the machine home", async () => {
    const root = await bareRepo();
    process.env.HIVE_HOME = machineHome;
    const instanceHome = namedInstanceHome(repoInstanceName(projectKey(root)));
    writePort(machineHome, 45_001);
    writePort(instanceHome, 45_002);
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      expect(requireDaemonPort()).toBe(45_002);
      expect(getHiveHome()).toBe(instanceHome);
    } finally {
      process.chdir(previousCwd);
      process.env.HIVE_HOME = machineHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an explicit HIVE_HOME is left alone even inside a git repo", async () => {
    const root = await bareRepo();
    const isolated = mkdtempSync(join(tmpdir(), "hive-explicit-"));
    writePort(isolated, 45_011);
    process.env.HIVE_HOME = isolated;
    try {
      expect(bindCliHiveHome(root)).toBe(isolated);
      expect(requireDaemonPort()).toBe(45_011);
    } finally {
      process.env.HIVE_HOME = machineHome;
      await rm(root, { recursive: true, force: true });
      await rm(isolated, { recursive: true, force: true });
    }
  });

  test("cwd outside a git repository stays on the machine home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "hive-not-git-"));
    writePort(machineHome, 45_021);
    process.env.HIVE_HOME = machineHome;
    try {
      expect(bindCliHiveHome(outside)).toBe(machineHome);
      expect(getHiveHome()).toBe(machineHome);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("uninstall, update, init, and bare hive keep the machine home; routing does not", () => {
    expect(cliCommandKeepsMachineHome(["node", "hive"])).toBe(true);
    expect(cliCommandKeepsMachineHome(["node", "hive", "uninstall"])).toBe(
      true,
    );
    expect(cliCommandKeepsMachineHome(["node", "hive", "update"])).toBe(true);
    expect(
      cliCommandKeepsMachineHome(["node", "hive", "update", "check"]),
    ).toBe(true);
    expect(cliCommandKeepsMachineHome(["node", "hive", "init"])).toBe(true);
    expect(
      cliCommandKeepsMachineHome(["node", "hive", "routing", "export"]),
    ).toBe(false);
    expect(cliCommandKeepsMachineHome(["node", "hive", "status"])).toBe(false);
    expect(cliCommandKeepsMachineHome(["node", "hive", "credential"])).toBe(
      false,
    );
    expect(
      cliCommandKeepsMachineHome([
        "node",
        "hive",
        "--instance",
        "qa",
        "routing",
        "export",
      ]),
    ).toBe(false);
  });
});
