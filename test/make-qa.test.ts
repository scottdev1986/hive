import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const root = join(import.meta.dir, "..");

function runMake(
  target: "build-qa" | "qa" | "qa-clean",
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
) {
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

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-b", "main"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(git.exitCode, git.stderr.toString()).toBe(0);
  writeFileSync(join(repo, "README"), "seed\n");
  Bun.spawnSync(["git", "add", "README"], { cwd: repo });
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

test("the dev commands stay unchanged and the independent QA lifecycle is declared", () => {
  const makefile = readFileSync(join(root, "Makefile"), "utf8");
  expect(makefile).toContain(
    ".PHONY: clean clean-all build run test sessiond toolchain graphify-local",
  );
  expect(makefile).toContain(".PHONY: build-qa qa qa-run qa-clean graphify-qa");
  expect(makefile).toContain("HIVE_DEFAULT_HOME=$(QA_HOME)");
  expect(makefile).toContain('bun run "$(ROOT)/qa/run.ts"');
  expect(makefile).toContain('bun run "$(ROOT)/qa/wait-ready.ts"');
});

test("build-qa creates a complete QA candidate without consuming dev output", () => {
  const makefile = readFileSync(join(root, "Makefile"), "utf8");
  const buildStart = makefile.indexOf("\nbuild-qa:\n");
  const buildEnd = makefile.indexOf("\n# PROJECT defaults", buildStart);
  const qaStart = makefile.indexOf("\nqa:\n");
  const qaEnd = makefile.indexOf("\n# Product uninstall", qaStart);
  expect(buildStart).toBeGreaterThan(-1);
  expect(buildEnd).toBeGreaterThan(buildStart);
  expect(qaStart).toBeGreaterThan(-1);
  expect(qaEnd).toBeGreaterThan(qaStart);

  const buildQa = makefile.slice(buildStart, buildEnd);
  const qa = makefile.slice(qaStart, qaEnd);
  expect(buildQa).toContain("--variant qa");
  expect(buildQa).toContain('--out "$$qa_stage"');
  expect(buildQa).toContain("$(SESSIOND_ASSET)");
  expect(buildQa).toContain("HiveWorkspace.tar.gz");
  expect(buildQa).not.toContain('"$(DIST)"');
  expect(buildQa).not.toContain("$(HIVE_BIN)");
  expect(buildQa).not.toContain("--skip-sessiond");
  expect(buildQa).not.toContain("--skip-workspace");
  expect(buildQa).toContain('touch "$(QA_BUILD_STAMP)"');
  expect(qa).not.toContain("$(HIVE_BIN)");
  expect(qa).not.toContain("$(DIST)");
  expect(qa).not.toContain("stage-qa.sh");
  expect(qa).toContain('[ -f "$(QA_BUILD_STAMP)" ]');
  expect(makefile).toContain(
    "HIVE_GRAPHIFY_MANIFEST=$(QA_GRAPHIFY_LOCAL_MANIFEST)",
  );
});

test("make build-qa refuses output paths outside its QA root", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-build-qa-root-"));
  try {
    const qa = join(fixture, "qa");
    const result = runMake("build-qa", {
      QA: qa,
      QA_DIST: join(fixture, "not-qa", "dist"),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("QA_DIST");
    expect(result.output).toContain("is outside QA staging root");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a failed build-qa invalidates the previous QA candidate", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-build-qa-fail-"));
  try {
    const qa = join(fixture, "qa");
    const stamp = join(qa, "build-ready");
    mkdirSync(qa, { recursive: true });
    writeFileSync(stamp, "previous candidate\n");
    const result = runMake("build-qa", {
      MAKE: "/usr/bin/false",
      QA: qa,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(stamp)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
    const home = join(fixture, "home");
    const result = runMake(
      "qa",
      {
        PROJECT: nested,
        QA: join(fixture, "qa"),
        USER_HIVE: join(home, ".hive"),
      },
      { ...process.env, HOME: home },
    );
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      "PROJECT is inside the hive checkout but is not its root",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa requires build-qa instead of a staged dev build", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-unbuilt-"));
  try {
    const project = join(fixture, "project");
    const home = join(fixture, "home");
    initRepo(project);
    const result = runMake(
      "qa",
      {
        PROJECT: project,
        QA: join(fixture, "qa"),
        USER_HIVE: join(home, ".hive"),
      },
      { ...process.env, HOME: home },
    );
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      "no qa build staged; run 'make build-qa' first",
    );
    expect(result.output).not.toContain("no dev build staged");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make -n qa resolves the default staging root outside the checkout", () => {
  const result = Bun.spawnSync(["make", "-n", "qa"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  // Positive proof staging resolves somewhere real, not just an absence of
  // the old path: the default names a concrete /tmp/hvqa-<tag> location, the
  // same isolated-QA-home family the QA lifecycle already uses.
  expect(output).toMatch(/\/tmp\/hvqa-[0-9a-f]+/);
  expect(output).not.toContain(`mkdir -p "${join(root, ".qa")}`);
});

test("make -n qa pins HIVE_SESSIOND_ROOT under the QA staging root", () => {
  const result = Bun.spawnSync(["make", "-n", "qa"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  // Make's own expansion of QA_ENV, not a recipe-text assertion: the sessiond
  // socket root must ride along under the same /tmp/hvqa-<tag> staging root,
  // or sessiond sockets land in the machine-wide run dir (qa-plan-v2 fence 1).
  expect(output).toMatch(
    /HIVE_SESSIOND_ROOT=(?:\/private)?\/tmp\/hvqa-[0-9a-f]+\/sessiond/,
  );
});

test("make qa refuses a QA staging root inside the hive checkout", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-qa-root-inside-"),
  );
  try {
    const result = runMake("qa", {
      PROJECT: join(fixture, "project"),
      QA: join(root, ".qa"),
      USER_HIVE: join(fixture, "dot-hive"),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("refusing: QA staging root");
    expect(result.output).toContain("is inside the hive checkout");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa refuses a staging-root symlink into the user Hive home", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-root-link-"));
  try {
    const home = join(fixture, "home");
    const userHive = join(home, ".hive");
    const qa = join(fixture, "qa");
    mkdirSync(userHive, { recursive: true });
    symlinkSync(userHive, qa);
    for (const target of ["build-qa", "qa", "qa-clean"] as const) {
      const result = runMake(
        target,
        {
          PROJECT: join(fixture, "project"),
          QA: qa,
          USER_HIVE: userHive,
        },
        { ...process.env, HOME: home },
      );
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("QA staging root");
      expect(result.output).toContain("under the user Hive home");
    }
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
    const result = runMake(
      "qa",
      {
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

test("make qa-clean runs repo uninstall then purge and preserves isolation", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-clean-"));
  try {
    const qa = join(fixture, "qa");
    const project = join(fixture, "project");
    const home = join(fixture, "home");
    const userHive = join(home, ".hive");
    const argvLog = join(fixture, "uninstall-argv");
    const capabilityLog = join(fixture, "uninstall-capability");
    initRepo(project);
    mkdirSync(userHive, { recursive: true });
    writeFileSync(join(userHive, "sentinel"), "untouched\n");
    writeExec(
      join(qa, "root", "current", "hive"),
      [
        "#!/bin/sh",
        `log=${JSON.stringify(argvLog)}`,
        `capability_log=${JSON.stringify(capabilityLog)}`,
        'printf "%s\\n" "$*" >> "$log"',
        `printf "%s\\n" "\${HIVE_CAPABILITY_TOKEN-unset}" >> "$capability_log"`,
        "exit 0",
        "",
      ].join("\n"),
    );
    mkdirSync(join(qa, "state"), { recursive: true });
    const captureHive = Bun.spawnSync(
      [
        join(root, "scripts", "qa", "isolation-inventory.sh"),
        userHive,
        join(qa, "state", "hive-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(captureHive.exitCode, captureHive.stderr.toString()).toBe(0);

    const result = runMake(
      "qa-clean",
      {
        PROJECT: project,
        QA: qa,
        QA_HOME: join(qa, "home"),
        USER_HIVE: userHive,
      },
      {
        ...process.env,
        HOME: home,
        HIVE_CAPABILITY_TOKEN: "owner-fleet-capability",
      },
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("no listed qa path remains");
    expect(readFileSync(argvLog, "utf8")).toBe(
      "stop --force\nuninstall --repo --yes\nuninstall --yes --purge\n",
    );
    expect(readFileSync(capabilityLog, "utf8")).toBe("unset\nunset\nunset\n");
    expect(readFileSync(join(userHive, "sentinel"), "utf8")).toBe(
      "untouched\n",
    );
    expect(result.output).not.toContain("dev-memory-setup.ts");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa-clean retries repo uninstall from this checkout when the qa binary fails", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-qa-clean-retry-"),
  );
  try {
    const qa = join(fixture, "qa");
    const project = join(fixture, "project");
    const home = join(fixture, "home");
    const userHive = join(home, ".hive");
    const argvLog = join(fixture, "uninstall-argv");
    initRepo(project);
    mkdirSync(userHive, { recursive: true });
    writeFileSync(join(userHive, "sentinel"), "untouched\n");
    writeExec(
      join(qa, "root", "current", "hive"),
      [
        "#!/bin/sh",
        `log=${JSON.stringify(argvLog)}`,
        'printf "%s\\n" "$*" >> "$log"',
        'if [ "$1" = "uninstall" ] && [ "$2" = "--repo" ]; then',
        '  echo "hive: ENOENT: no such file or directory, open \\"$PWD/.mcp.json\\"" >&2',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    mkdirSync(join(qa, "state"), { recursive: true });
    const captureHive = Bun.spawnSync(
      [
        join(root, "scripts", "qa", "isolation-inventory.sh"),
        userHive,
        join(qa, "state", "hive-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(captureHive.exitCode, captureHive.stderr.toString()).toBe(0);

    const result = runMake(
      "qa-clean",
      {
        PROJECT: project,
        QA: qa,
        QA_HOME: join(qa, "home"),
        USER_HIVE: userHive,
      },
      { ...process.env, HOME: home },
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(
      "qa-clean: product repo uninstall failed; retrying with this checkout",
    );
    expect(result.output).toContain("user Hive isolation preserved");
    expect(readFileSync(argvLog, "utf8")).toBe(
      "stop --force\nuninstall --repo --yes\nuninstall --yes --purge\n",
    );
    expect(existsSync(qa)).toBe(false);
    expect(readFileSync(join(userHive, "sentinel"), "utf8")).toBe(
      "untouched\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make qa-clean finishes isolation when the qa binary is already gone", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-clean-gone-"));
  try {
    const qa = join(fixture, "qa");
    const project = join(fixture, "project");
    const home = join(fixture, "home");
    const userHive = join(home, ".hive");
    initRepo(project);
    mkdirSync(userHive, { recursive: true });
    writeFileSync(join(userHive, "sentinel"), "untouched\n");
    mkdirSync(join(qa, "state"), { recursive: true });
    const captureHive = Bun.spawnSync(
      [
        join(root, "scripts", "qa", "isolation-inventory.sh"),
        userHive,
        join(qa, "state", "hive-before"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(captureHive.exitCode, captureHive.stderr.toString()).toBe(0);

    const result = runMake(
      "qa-clean",
      {
        PROJECT: project,
        QA: qa,
        QA_HOME: join(qa, "home"),
        USER_HIVE: userHive,
      },
      { ...process.env, HOME: home },
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(
      "qa-clean: qa binary already gone; skipping product uninstall",
    );
    expect(result.output).toContain("user Hive isolation preserved");
    expect(existsSync(qa)).toBe(false);
    expect(readFileSync(join(userHive, "sentinel"), "utf8")).toBe(
      "untouched\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
