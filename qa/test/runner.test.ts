import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "../../test/outside-repo-tmpdir";
import {
  type Exec,
  type ExecResult,
  type ObserveClients,
  parseCredentialHeaders,
  preflight,
  type RigRoots,
  rowObserveClients,
  rowRouteTransition,
  runnerExitCode,
  runQA,
  waitFor,
} from "../runner";

const repoRoot = join(import.meta.dir, "..", "..");
const validateIsolation = join(
  repoRoot,
  "scripts",
  "qa",
  "validate-isolation.sh",
);

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const realExec: Exec = async (argv): Promise<ExecResult> => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-b", "main"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(init.exitCode, init.stderr.toString()).toBe(0);
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

interface RigFixture {
  fixture: string;
  env: Record<string, string>;
  rig: RigRoots;
  qaBin: string;
}

function makeRig(): RigFixture {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-runner-"));
  fixtures.push(fixture);
  const checkout = join(fixture, "checkout");
  const staging = join(fixture, "qa");
  const userHome = join(fixture, "userhome");
  const userHive = join(userHome, ".hive");
  const project = join(fixture, "project");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(staging, "home"), { recursive: true });
  mkdirSync(userHive, { recursive: true });
  initRepo(project);
  const env: Record<string, string> = {
    HOME: userHome,
    HIVE_QA: "1",
    HIVE_HOME: join(staging, "home"),
    HIVE_DEFAULT_HOME: join(staging, "home"),
    HIVE_EMBEDDINGS_SOURCE: checkout,
    HIVE_INSTALL_ROOT: join(staging, "root"),
    HIVE_BIN_LINK: join(staging, "bin", "hive-qa"),
    HIVE_BIN_DIR: join(staging, "bin"),
    HIVE_GRAPHIFY_MANIFEST: join(staging, "graphify", "graphify-runtime.json"),
    HIVE_SESSIOND_ROOT: join(staging, "sessiond"),
    OTUI_ASSET_ROOT: join(checkout, "node_modules"),
    TMPDIR: join(staging, "tmp"),
    HIVE_DISABLE_UPDATES: "1",
    HIVE_PORT: "0",
  };
  return {
    fixture,
    env,
    rig: {
      repoRoot: checkout,
      stagingRoot: staging,
      devHome: join(fixture, "dev-home"),
      userHive,
      project,
    },
    qaBin: join(staging, "root", "current", "hive"),
  };
}

/** Exec that fakes git/PlistBuddy/the QA binary and delegates validate-isolation (sh) to the real thing, so the isolation fence is exercised, not mocked. */
function rigExec(
  rig: RigFixture,
  overrides: { commit?: string; version?: string; appVersion?: string } = {},
): Exec {
  const commit = overrides.commit ?? "abc1234";
  const version =
    overrides.version ??
    `hive 0.0.0-qa (${commit}, 2026-08-19, darwin-arm64)\n`;
  return async (argv) => {
    if (argv[0] === "sh") return await realExec(argv);
    if (argv[0] === "git")
      return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    if (argv[0] === rig.qaBin && argv[1] === "--version") {
      return { exitCode: 0, stdout: version, stderr: "" };
    }
    if (argv[0] === "/usr/libexec/PlistBuddy") {
      return overrides.appVersion === undefined
        ? { exitCode: 1, stdout: "", stderr: "Print: Entry Does Not Exist" }
        : { exitCode: 0, stdout: `${overrides.appVersion}\n`, stderr: "" };
    }
    return {
      exitCode: 127,
      stdout: "",
      stderr: `unexpected exec: ${argv.join(" ")}`,
    };
  };
}

const sleep = async (ms: number): Promise<void> => Bun.sleep(ms);

describe("preflight fences", () => {
  test("refuses a missing pin, naming it", async () => {
    const rig = makeRig();
    delete rig.env.HIVE_HOME;
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "pin-set" });
    if (!outcome.ok) expect(outcome.reason).toContain("HIVE_HOME");
  });

  test("refuses a relative pin", async () => {
    const rig = makeRig();
    rig.env.HIVE_HOME = "relative/home";
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "pin-set" });
  });

  test("refuses when HIVE_QA is not pinned on", async () => {
    const rig = makeRig();
    rig.env.HIVE_QA = "0";
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "pin-set" });
    if (!outcome.ok) expect(outcome.reason).toContain("HIVE_QA");
  });

  test("refuses a pin that resolves into the real user home through a symlink", async () => {
    const rig = makeRig();
    const target = join(rig.rig.userHive, "qa-home");
    mkdirSync(target, { recursive: true });
    rmSync(rig.env.HIVE_HOME as string, { recursive: true, force: true });
    symlinkSync(target, rig.env.HIVE_HOME as string);
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "pin-set" });
    if (!outcome.ok) {
      expect(outcome.reason).toContain("real user Hive home");
    }
  });

  test("refuses when HIVE_HOME and HIVE_DEFAULT_HOME diverge", async () => {
    const rig = makeRig();
    rig.env.HIVE_DEFAULT_HOME = join(rig.fixture, "qa", "other-home");
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "pin-set" });
  });

  test("refuses a staging root inside the checkout via the real validate-isolation", async () => {
    const rig = makeRig();
    rig.rig.stagingRoot = join(rig.rig.repoRoot, "qa");
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "isolation" });
    if (!outcome.ok) {
      expect(outcome.reason).toContain("inside the hive checkout");
    }
  });

  test("refuses a sessiond root outside the staging root", async () => {
    const rig = makeRig();
    rig.env.HIVE_SESSIOND_ROOT = join(rig.fixture, "elsewhere");
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "sessiond-root" });
  });

  test("refuses a QA binary built from another commit", async () => {
    const rig = makeRig();
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig, {
        version: "hive 0.0.0-qa (def5678, 2026-08-19, darwin-arm64)\n",
      }),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "build-identity" });
    if (!outcome.ok) {
      expect(outcome.reason).toContain("def5678");
      expect(outcome.reason).toContain("abc1234");
    }
  });

  test("refuses a binary whose build identity cannot be read", async () => {
    const rig = makeRig();
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig, { version: "not a version line\n" }),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "build-identity" });
  });

  test("refuses when no Workspace app sits beside the QA binary", async () => {
    const rig = makeRig();
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({ ok: false, fence: "build-identity" });
    if (!outcome.ok) expect(outcome.reason).toContain("no Workspace app");
  });

  test("passes a fully wired rig and records the build identity", async () => {
    const rig = makeRig();
    const outcome = await preflight({
      env: rig.env,
      exec: rigExec(rig, { appVersion: "0.0.0-qa" }),
      rig: rig.rig,
      validateIsolation,
    });
    expect(outcome).toMatchObject({
      ok: true,
      qaBin: rig.qaBin,
      treeCommit: "abc1234",
      appVersion: "0.0.0-qa",
    });
  });
});

describe("the bounded wait", () => {
  test("expires when the predicate never holds", async () => {
    const outcome = await waitFor(async () => null, 150, sleep, 20);
    expect(outcome).toEqual({ state: "expired" });
  });

  test("returns the value once the predicate holds", async () => {
    let calls = 0;
    const outcome = await waitFor(
      async () => {
        calls += 1;
        return calls >= 3 ? "ready" : null;
      },
      5_000,
      sleep,
      10,
    );
    expect(outcome).toEqual({ state: "met", value: "ready" });
    expect(calls).toBe(3);
  });

  test("an oracle that refuses is not-yet until the bound expires", async () => {
    const outcome = await waitFor(
      async () => {
        throw new Error("connection refused");
      },
      150,
      sleep,
      20,
    );
    expect(outcome).toEqual({ state: "expired" });
  });
});

describe("the exit-code mapping", () => {
  test("0 pass, 1 measured fail, 2 no measurement; no measurement outranks fail", () => {
    expect(runnerExitCode([])).toBe(0);
    expect(runnerExitCode([{ id: "a", status: "PASS", reason: "ok" }])).toBe(0);
    expect(
      runnerExitCode([
        { id: "a", status: "PASS", reason: "ok" },
        { id: "b", status: "FAIL", reason: "bad" },
      ]),
    ).toBe(1);
    expect(
      runnerExitCode([
        { id: "a", status: "FAIL", reason: "bad" },
        { id: "b", status: "NO MEASUREMENT", reason: "rig" },
      ]),
    ).toBe(2);
  });
});

describe("the credential helper contract", () => {
  test("parses the JSON header object", () => {
    expect(parseCredentialHeaders('{"Authorization":"Bearer tok"}')).toEqual({
      Authorization: "Bearer tok",
    });
  });

  test("a raw header line is not a credential", () => {
    expect(() => parseCredentialHeaders("Authorization: Bearer tok")).toThrow();
    expect(() => parseCredentialHeaders('["Authorization"]')).toThrow();
  });
});

function gateExec(handlers: {
  routes: string[];
  invoke?: ExecResult;
  dieAfterInvoke?: boolean;
}): Exec {
  let enumerates = 0;
  let invoked = false;
  return async (argv) => {
    const verb = argv[2];
    if (verb === "invoke") {
      invoked = true;
      return (
        handlers.invoke ?? {
          exitCode: 0,
          stdout: JSON.stringify({ status: "ok", route: "shell" }),
          stderr: "",
        }
      );
    }
    if (verb === "enumerate") {
      if (handlers.dieAfterInvoke === true && invoked) {
        return { exitCode: 2, stdout: "", stderr: "NO MEASUREMENT: gone" };
      }
      const route =
        handlers.routes[Math.min(enumerates, handlers.routes.length - 1)] ??
        "shell";
      enumerates += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: "ok", route }),
        stderr: "",
      };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected" };
  };
}

describe("the route-transition proof row", () => {
  test("passes when the second enumerate shows the route moved", async () => {
    const row = await rowRouteTransition(
      gateExec({ routes: ["shell", "models"] }),
      "/qa/hive",
      sleep,
    );
    expect(row.status).toBe("PASS");
    expect(row.reason).toContain("shell -> models");
  });

  test("fails when invoke reported ok but the route stayed", async () => {
    const row = await rowRouteTransition(
      gateExec({ routes: ["shell"] }),
      "/qa/hive",
      sleep,
      150,
    );
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("stayed shell");
  });

  test("a measured invoke refusal is a FAIL, not a rig fact", async () => {
    const row = await rowRouteTransition(
      gateExec({
        routes: ["shell"],
        invoke: {
          exitCode: 1,
          stdout: JSON.stringify({
            status: "fail",
            reason: "control not found",
          }),
          stderr: "",
        },
      }),
      "/qa/hive",
      sleep,
    );
    expect(row).toMatchObject({ status: "FAIL", reason: "control not found" });
  });

  test("a gate that cannot answer is NO MEASUREMENT", async () => {
    const exec: Exec = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "NO MEASUREMENT: Workspace did not answer qa-control",
    });
    const row = await rowRouteTransition(exec, "/qa/hive", sleep);
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("an unparseable gate answer is NO MEASUREMENT", async () => {
    const exec: Exec = async () => ({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
    });
    const row = await rowRouteTransition(exec, "/qa/hive", sleep);
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("a gate that dies after invoke is NO MEASUREMENT, never a fail", async () => {
    const row = await rowRouteTransition(
      gateExec({ routes: ["shell"], dieAfterInvoke: true }),
      "/qa/hive",
      sleep,
      150,
    );
    expect(row.status).toBe("NO MEASUREMENT");
  });
});

function observe(overrides: Partial<ObserveClients>): ObserveClients {
  return {
    httpStatus: async () => 200,
    httpJson: async () => ({ status: 200, body: {} }),
    mcpCall: async () => ({ agents: [] }),
    close: async () => {},
    ...overrides,
  };
}

describe("the observe-clients proof row", () => {
  test("no port or credential is NO MEASUREMENT", async () => {
    const row = await rowObserveClients(null, sleep);
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("passes when the daemon answers on both clients", async () => {
    const row = await rowObserveClients(observe({}), sleep);
    expect(row.status).toBe("PASS");
  });

  test("a daemon answering unhealthy is a measured FAIL", async () => {
    const row = await rowObserveClients(
      observe({ httpStatus: async () => 500 }),
      sleep,
    );
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("500");
  });

  test("a daemon that never answers is NO MEASUREMENT", async () => {
    const row = await rowObserveClients(
      observe({
        httpStatus: async () => {
          throw new Error("connection refused");
        },
      }),
      sleep,
      150,
    );
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("an MCP refusal is NO MEASUREMENT", async () => {
    const row = await rowObserveClients(
      observe({
        mcpCall: async () => {
          throw new Error("hive_status failed: denied");
        },
      }),
      sleep,
    );
    expect(row.status).toBe("NO MEASUREMENT");
    expect(row.reason).toContain("hive_status");
  });
});

describe("runQA end to end with fakes", () => {
  test("a preflight violation exits 2 naming the fence and runs no rows", async () => {
    const rig = makeRig();
    delete rig.env.TMPDIR;
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runQA({
      env: rig.env,
      exec: rigExec(rig),
      rig: rig.rig,
      validateIsolation,
      buildObserve: async () => ({
        observe: observe({}),
        instanceHome: "/qa/instance-home",
      }),
      sleep,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(exit).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain("preflight fence pin-set");
    expect(err[0]).toContain("TMPDIR");
  });

  test("a green rig prints one line per row, exits 0, and records the build identity", async () => {
    const rig = makeRig();
    const gate = gateExec({ routes: ["shell", "models"] });
    const exec: Exec = async (argv) => {
      if (argv[2] === "enumerate" || argv[2] === "invoke")
        return await gate(argv);
      return await rigExec(rig, { appVersion: "0.0.0-qa" })(argv);
    };
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runQA({
      env: rig.env,
      exec,
      rig: rig.rig,
      validateIsolation,
      buildObserve: async () => ({
        observe: observe({}),
        instanceHome: "/qa/instance-home",
      }),
      sleep,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      stage1: async () => [],
    });
    expect(exit).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^PASS QA1-01-route-transition /);
    expect(out[1]).toMatch(/^PASS QA1-02-observe-clients /);
    expect(err.join("\n")).toContain("tree=abc1234");
  });

  test("an unmeasurable row moves the exit to 2", async () => {
    const rig = makeRig();
    const gate = gateExec({ routes: ["shell", "models"] });
    const exec: Exec = async (argv) => {
      if (argv[2] === "enumerate" || argv[2] === "invoke")
        return await gate(argv);
      return await rigExec(rig, { appVersion: "0.0.0-qa" })(argv);
    };
    const out: string[] = [];
    const exit = await runQA({
      env: rig.env,
      exec,
      rig: rig.rig,
      validateIsolation,
      buildObserve: async () => null,
      sleep,
      out: (line) => out.push(line),
      err: () => {},
      stage1: async () => [],
    });
    expect(exit).toBe(2);
    expect(out[1]).toMatch(/^NO MEASUREMENT QA1-02-observe-clients /);
  });
});
