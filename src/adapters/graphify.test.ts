import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import graphifyLock from "../../graphify.lock" with { type: "text" };
import {
  buildGraph,
  buildGraphBrief,
  ensureGraphifyIgnored,
  graphifyPin,
  graphifyStatePath,
  installGraphify,
  readGraphifyState,
  runCommand,
  scrubbedGraphifyEnv,
  UV_MISSING_MESSAGE,
  writeGraphifyState,
  type CommandRunner,
  type RunResult,
} from "./graphify";

let hiveHome: string;
const originalHiveHome = process.env.HIVE_HOME;

beforeAll(async () => {
  hiveHome = await mkdtemp(join(tmpdir(), "hive-home-"));
  process.env.HIVE_HOME = hiveHome;
});

afterAll(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
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

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-graphify-"));
  git(root, ["init"]);
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

const ok = (stdout = ""): RunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

describe("the embedded lock", () => {
  test("pins graphifyy to an exact version", () => {
    expect(graphifyPin()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("carries a hash for every pinned requirement", () => {
    // The provenance invariant: a lock entry without hashes silently disables
    // --require-hashes verification for that artifact. Every requirement line
    // must open a continuation block containing at least one --hash.
    const lines = graphifyLock.split("\n");
    const requirements = lines.filter((line) => /^[a-z0-9._-]+==/i.test(line));
    expect(requirements.length).toBeGreaterThan(0);
    for (const requirement of requirements) {
      const start = lines.indexOf(requirement);
      const block: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!line.startsWith(" ")) break;
        block.push(line);
      }
      expect(
        block.some((line) => line.includes("--hash=sha256:")),
        `${requirement} has no --hash`,
      ).toBe(true);
    }
  });

  test("includes the mcp extra's server dependencies", () => {
    // graphify-mcp import-errors without the [mcp] extra; the lock must carry
    // it or the installed tool cannot serve.
    expect(graphifyLock).toContain("\nmcp==");
  });
});

describe("scrubbedGraphifyEnv", () => {
  test("is an allowlist that cannot leak provider keys", () => {
    process.env.FAKE_PROVIDER_API_KEY = "secret";
    try {
      const env = scrubbedGraphifyEnv();
      expect(Object.keys(env).sort()).toEqual(
        ["HOME", "PATH", ...(process.env.TMPDIR === undefined ? [] : ["TMPDIR"])].sort(),
      );
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.HOME).toContain(join("tools", "graphify"));
      expect(JSON.stringify(env)).not.toContain("secret");
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });
});

describe("per-repo state", () => {
  test("round-trips, and absence reads as disabled", async () => {
    const root = await gitRepo();
    expect(await readGraphifyState(root)).toEqual({ enabled: false, pin: null });
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    expect(await readGraphifyState(root)).toEqual({
      enabled: true,
      pin: graphifyPin(),
    });
    expect(graphifyStatePath(root).startsWith(hiveHome)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("a malformed state file reads as disabled", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: null });
    await writeFile(graphifyStatePath(root), "enabled = maybe???");
    expect(await readGraphifyState(root)).toEqual({ enabled: false, pin: null });
    await rm(root, { recursive: true, force: true });
  });
});

describe("ensureGraphifyIgnored", () => {
  test("writes .git/info/exclude once and verifies with --no-index", async () => {
    const root = await gitRepo();
    const first = await ensureGraphifyIgnored(root);
    expect(first.ok).toBe(true);
    const second = await ensureGraphifyIgnored(root);
    expect(second.ok).toBe(true);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    const occurrences = exclude
      .split("\n")
      .filter((line) => line.trim() === "graphify-out/").length;
    expect(occurrences).toBe(1);
    const check = Bun.spawnSync(
      ["git", "-C", root, "check-ignore", "--no-index", "graphify-out/probe"],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(check.exitCode).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  test("from a linked worktree, one exclude in the common dir covers it", async () => {
    const root = await gitRepo();
    const worktree = join(root, ".wt");
    git(root, ["worktree", "add", worktree, "-b", "wt"]);
    const result = await ensureGraphifyIgnored(worktree);
    expect(result.ok).toBe(true);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("graphify-out/");
    const check = Bun.spawnSync(
      ["git", "-C", worktree, "check-ignore", "--no-index", "graphify-out/probe"],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(check.exitCode).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  test("outside a git repo it fails loudly instead of writing anywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-nogit-"));
    const result = await ensureGraphifyIgnored(root);
    expect(result.ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

describe("installGraphify", () => {
  test("without uv: instructions, no state change, no commands run", async () => {
    const calls: string[][] = [];
    const result = await installGraphify({
      which: () => null,
      run: async (argv) => {
        calls.push(argv);
        return ok();
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(UV_MISSING_MESSAGE);
    expect(UV_MISSING_MESSAGE).not.toContain("Hive will run");
    expect(calls).toEqual([]);
  });

  test("installs hash-verified from the embedded lock, then probes the binary", async () => {
    const calls: string[][] = [];
    const result = await installGraphify({
      which: (cmd) => (cmd === "uv" ? "/fake/uv" : null),
      run: async (argv) => {
        calls.push(argv);
        return ok();
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(4);
    const [venv, install, probe, mcpProbe] = calls as [
      string[], string[], string[], string[],
    ];
    expect(venv.slice(0, 2)).toEqual(["/fake/uv", "venv"]);
    expect(install).toContain("--require-hashes");
    expect(install[0]).toBe("/fake/uv");
    const lockPath = install[install.indexOf("-r") + 1] as string;
    expect(await readFile(lockPath, "utf8")).toBe(graphifyLock);
    // The probe runs the venv binary by absolute path, never a PATH lookup.
    expect(probe[0]).toContain(join("tools", "graphify", "venv", "bin", "graphify"));
    expect(mcpProbe[0]).toContain(
      join("tools", "graphify", "venv", "bin", "graphify-mcp"),
    );
  });
});

describe("buildGraph", () => {
  test("always --code-only, always scrubbed, by absolute path", async () => {
    let seen: { argv: string[]; env: Record<string, string> | undefined } | null =
      null;
    const run: CommandRunner = async (argv, options) => {
      seen = { argv, env: options.env };
      return ok("[graphify extract] wrote /r/graphify-out/graph.json: 5 nodes, 9 edges, 2 communities");
    };
    const result = await buildGraph("/repo", run);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toBe("5 nodes, 9 edges, 2 communities");
    const call = seen as unknown as {
      argv: string[];
      env: Record<string, string> | undefined;
    };
    expect(call.argv).toContain("--code-only");
    expect(call.argv[0]).toContain(join("venv", "bin", "graphify"));
    expect(call.env).toEqual(scrubbedGraphifyEnv());
    expect(JSON.stringify(call.argv)).not.toContain("--backend");
  });

  test("a timeout degrades to a loud failure, never a hang", async () => {
    const run: CommandRunner = async () => ({
      exitCode: 143,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const result = await buildGraph("/repo", run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("timed out");
  });
});

describe("buildGraphBrief", () => {
  test("a repo that never opted in gets silence, not a note", async () => {
    const root = await gitRepo();
    expect(await buildGraphBrief(root, "fix the bug")).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  test("opted in but no graph yet: one loud line, no command run", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    const calls: string[][] = [];
    const brief = await buildGraphBrief(root, "fix the bug", async (argv) => {
      calls.push(argv);
      return ok();
    });
    expect(brief).toContain("unavailable");
    expect(brief).toContain("proceeding without it");
    expect(calls).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a timed-out query degrades to the loud line inside its time-box", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    // Fake an installed binary and graph so the query path is reached.
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    const { graphifyBin, graphJsonPath } = await import("./graphify");
    const { dirname } = await import("node:path");
    await mkdir(dirname(graphifyBin()), { recursive: true });
    await write(graphifyBin(), "");
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await write(graphJsonPath(root), "{}");
    let seen: { argv: string[]; timeoutMs: number } | null = null;
    const brief = await buildGraphBrief(root, "fix the bug", async (argv, options) => {
      seen = { argv, timeoutMs: options.timeoutMs };
      return { exitCode: 143, stdout: "", stderr: "", timedOut: true };
    });
    expect(brief).toContain("timed out");
    const call = seen as unknown as { argv: string[]; timeoutMs: number };
    // The digest is budgeted and time-boxed — the two bounds that keep the
    // spawn from ever waiting on a sick graphify.
    expect(call.timeoutMs).toBe(3_000);
    expect(call.argv).toContain("--budget");
    expect(call.argv).toContain("query");
    await rm(root, { recursive: true, force: true });
  });

  test("a healthy query becomes an advisory-prefixed digest", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    const { graphifyBin, graphJsonPath } = await import("./graphify");
    const { dirname } = await import("node:path");
    await mkdir(dirname(graphifyBin()), { recursive: true });
    await write(graphifyBin(), "");
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await write(graphJsonPath(root), "{}");
    const brief = await buildGraphBrief(root, "fix the bug", async () =>
      ok("NODE server.ts [src=src/daemon/server.ts]"));
    expect(brief).toContain("advisory");
    expect(brief).toContain("verify");
    expect(brief).toContain("NODE server.ts");
    await rm(root, { recursive: true, force: true });
  });
});

describe("runCommand", () => {
  test("kills at the deadline and reports timedOut", async () => {
    const result = await runCommand(["/bin/sleep", "5"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
