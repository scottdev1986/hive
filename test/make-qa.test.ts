import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const root = join(import.meta.dir, "..");

function runMake(
  target: "qa" | "qa-clean",
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): { exitCode: number; output: string } {
  const result = Bun.spawnSync(
    [
      "make",
      "-f",
      join(root, "Makefile"),
      target,
      ...Object.entries(vars).map(([key, value]) => `${key}=${value}`),
    ],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode ?? 1,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function writeExec(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function initRepo(repo: string, ignore = ""): void {
  mkdirSync(repo, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-b", "main"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(git.exitCode, git.stderr.toString()).toBe(0);
  writeFileSync(join(repo, "README"), "seed\n");
  const toAdd = ["README"];
  if (ignore.length > 0) {
    writeFileSync(join(repo, ".gitignore"), ignore);
    toAdd.push(".gitignore");
  }
  Bun.spawnSync(["git", "add", ...toAdd], { cwd: repo });
  const commit = Bun.spawnSync(["git", "commit", "-m", "seed"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hive-qa",
      GIT_AUTHOR_EMAIL: "qa@hive.local",
      GIT_COMMITTER_NAME: "hive-qa",
      GIT_COMMITTER_EMAIL: "qa@hive.local",
    },
  });
  expect(commit.exitCode, commit.stderr.toString()).toBe(0);
}

test("the five public .PHONY names are unchanged and qa is declared beside them", () => {
  const makefile = readFileSync(join(root, "Makefile"), "utf8");
  expect(makefile).toContain(
    ".PHONY: clean clean-all build run test sessiond toolchain graphify-local",
  );
  expect(makefile).toContain(".PHONY: qa qa-clean");
  expect(makefile).toContain("HIVE_DEFAULT_HOME=$(QA_HOME)");
});

test("make -n qa defaults PROJECT to the designated test repo", () => {
  const result = Bun.spawnSync(["make", "-n", "qa"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("/Users/scottkellar/Projects/hive-test-project");
  expect(output).toContain("HIVE_DEFAULT_HOME=");
  expect(output).not.toContain("dev-memory-setup.ts");
});

test("make qa refuses a PROJECT inside the hive checkout that is not its root", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-inside-"));
  try {
    const nested = join(root, "src");
    const hiveBin = join(fixture, "hive-dev");
    writeExec(hiveBin, "#!/bin/sh\nexit 0\n");
    const result = runMake("qa", {
      HIVE_BIN: hiveBin,
      PROJECT: nested,
      QA: join(fixture, "qa"),
      USER_HIVE: join(fixture, "dot-hive"),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      "PROJECT is inside the hive checkout but is not its root",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa refuses a QA_HOME under the user hive home", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-protected-"));
  try {
    const home = join(fixture, "home");
    const userHive = join(home, ".hive");
    mkdirSync(userHive, { recursive: true });
    const hiveBin = join(fixture, "hive-dev");
    writeExec(hiveBin, "#!/bin/sh\nexit 0\n");
    const result = runMake(
      "qa",
      {
        HIVE_BIN: hiveBin,
        PROJECT: join(fixture, "project"),
        QA: join(fixture, "qa"),
        QA_HOME: join(userHive, "instances", "qa-test"),
        USER_HIVE: userHive,
      },
      { ...process.env, HOME: home },
    );
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("QA_HOME is under the user hive home");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa-clean runs repo uninstall then purge and proves the no-mark check", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-clean-"));
  try {
    const qa = join(fixture, "qa");
    const project = join(fixture, "project");
    const userHive = join(fixture, "dot-hive");
    const argvLog = join(fixture, "uninstall-argv");
    initRepo(project);
    mkdirSync(userHive, { recursive: true });
    writeFileSync(join(userHive, "sentinel"), "untouched\n");
    const hiveBin = join(fixture, "hive-dev");
    writeExec(hiveBin, "#!/bin/sh\nexit 0\n");
    writeExec(
      join(qa, "root", "current", "hive"),
      [
        "#!/bin/sh",
        `log=${JSON.stringify(argvLog)}`,
        'printf "%s\\n" "$*" >> "$log"',
        "exit 0",
        "",
      ].join("\n"),
    );
    mkdirSync(join(qa, "proof"), { recursive: true });
    const captureRepo = Bun.spawnSync(
      [
        join(root, "scripts", "qa", "inventory.sh"),
        "capture-repo",
        project,
        join(qa, "proof", "repo-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(captureRepo.exitCode, captureRepo.stderr.toString()).toBe(0);
    const captureHive = Bun.spawnSync(
      [
        join(root, "scripts", "qa", "isolation-inventory.sh"),
        userHive,
        join(qa, "proof", "hive-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(captureHive.exitCode, captureHive.stderr.toString()).toBe(0);

    const result = runMake("qa-clean", {
      HIVE_BIN: hiveBin,
      PROJECT: project,
      QA: qa,
      QA_HOME: join(qa, "home"),
      USER_HIVE: userHive,
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("identical");
    expect(result.output).toContain("no listed qa path remains");
    expect(readFileSync(argvLog, "utf8")).toBe(
      "stop --force\nuninstall --repo --yes\nuninstall --yes --purge\n",
    );
    expect(readFileSync(join(userHive, "sentinel"), "utf8")).toBe(
      "untouched\n",
    );
    expect(result.output).not.toContain("dev-memory-setup.ts");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa-clean reds the no-mark proof when a stray ignored file is left", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-clean-red-"));
  try {
    const qa = join(fixture, "qa");
    const project = join(fixture, "project");
    const userHive = join(fixture, "dot-hive");
    initRepo(project, "stray.txt\n");
    mkdirSync(userHive, { recursive: true });
    const hiveBin = join(fixture, "hive-dev");
    writeExec(hiveBin, "#!/bin/sh\nexit 0\n");
    writeExec(join(qa, "root", "current", "hive"), "#!/bin/sh\nexit 0\n");
    mkdirSync(join(qa, "proof"), { recursive: true });
    Bun.spawnSync(
      [
        join(root, "scripts", "qa", "inventory.sh"),
        "capture-repo",
        project,
        join(qa, "proof", "repo-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(
      [
        join(root, "scripts", "qa", "isolation-inventory.sh"),
        userHive,
        join(qa, "proof", "hive-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    writeFileSync(join(project, "stray.txt"), "left behind\n");

    const result = runMake("qa-clean", {
      HIVE_BIN: hiveBin,
      PROJECT: project,
      QA: qa,
      QA_HOME: join(qa, "home"),
      USER_HIVE: userHive,
    });
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain("DIFFER");
    expect(result.output).toContain("stray.txt");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
