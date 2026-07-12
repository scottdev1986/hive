/**
 * Graphify: an opt-in, repo-local code knowledge graph agents can query.
 * Design: docs/architecture/graphify-integration.md — the hard rules live
 * there and are enforced here:
 *
 *   - Installed only through `hive graphify enable` (running it is the
 *     consent), from a Hive-shipped fully hash-pinned lock. The lock is
 *     inlined into the binary the way shipped skills are: a user's machine
 *     has no Hive checkout to read it from.
 *   - Every graphify invocation runs keyless from a scrubbed allowlist
 *     environment with `--code-only`, so the LLM-enrichment paths fail
 *     closed instead of sending repo content anywhere.
 *   - Invocation is by absolute path into Hive's own venv; nothing lands on
 *     PATH and upstream's `graphify install` (which writes the user's global
 *     assistant configs) is never run.
 *   - `graphify-out/` is kept out of git via `.git/info/exclude` — Hive does
 *     not edit the repo's tracked `.gitignore` — and the exclusion is
 *     verified with `check-ignore --no-index`, because plain `check-ignore`
 *     consults the index and cannot prove anything.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import graphifyLock from "../../graphify.lock" with { type: "text" };
import { getHiveHome } from "../daemon/db";
import { projectStateDir } from "./profile";

/** The exact version the embedded lock pins. The lock is the single source of
 * truth; a lock that stops naming graphifyy is a build error, not a fallback. */
export function graphifyPin(): string {
  const match = graphifyLock.match(/^graphifyy(?:\[[^\]]*\])?==(\S+?)\s*\\?$/m);
  if (match === null) {
    throw new Error("graphify.lock does not pin graphifyy — regenerate it");
  }
  return match[1] as string;
}

export function graphifyToolsDir(): string {
  return join(getHiveHome(), "tools", "graphify");
}

function venvDir(): string {
  return join(graphifyToolsDir(), "venv");
}

export function graphifyBin(): string {
  return join(venvDir(), "bin", "graphify");
}

export function graphifyMcpBin(): string {
  return join(venvDir(), "bin", "graphify-mcp");
}

export function graphOutDir(root: string): string {
  return join(root, "graphify-out");
}

export function graphJsonPath(root: string): string {
  return join(graphOutDir(root), "graph.json");
}

/** The environment every graphify process gets: an allowlist, not a scrub of
 * known key names, so a provider key Hive has never heard of still cannot
 * leak. HOME points into Hive's tools dir so upstream's `~/.graphify` global
 * state is never read or written. Enrichment without a key errors upstream —
 * that error is the fail-closed backstop the design relies on. */
export function scrubbedGraphifyEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: join(graphifyToolsDir(), "home"),
  };
  const tmpdir = process.env.TMPDIR;
  if (tmpdir !== undefined) env.TMPDIR = tmpdir;
  return env;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<RunResult>;

/** Run a command with a hard timeout (the landing.ts pattern): kill on the
 * deadline and say so, because a graphify that hangs must degrade, never
 * block anything that waits on it. */
export const runCommand: CommandRunner = async (argv, options) => {
  const proc = Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Per-repo state: enabled or not, and under which pin. Lives in the project's
// derived-state dir (~/.hive/projects/<uuid>/), never in the repo.
// ---------------------------------------------------------------------------

export interface GraphifyState {
  enabled: boolean;
  /** The pin installed when this repo was enabled; null when never enabled. */
  pin: string | null;
}

export function graphifyStatePath(root: string): string {
  return join(projectStateDir(root), "graphify.toml");
}

/** Absent or malformed both read as disabled — but only because `enable`
 * writes a positive record first; a repo that was never enabled and one whose
 * state file was deleted degrade identically, to off. */
export async function readGraphifyState(root: string): Promise<GraphifyState> {
  let source: string;
  try {
    source = await readFile(graphifyStatePath(root), "utf8");
  } catch {
    return { enabled: false, pin: null };
  }
  try {
    const raw = Bun.TOML.parse(source) as Record<string, unknown>;
    return {
      enabled: raw.enabled === true,
      pin: typeof raw.pin === "string" ? raw.pin : null,
    };
  } catch {
    return { enabled: false, pin: null };
  }
}

export async function writeGraphifyState(
  root: string,
  state: GraphifyState,
): Promise<void> {
  const path = graphifyStatePath(root);
  const lines = [
    "# Managed by `hive graphify enable|disable`.",
    `enabled = ${state.enabled}`,
    ...(state.pin === null ? [] : [`pin = ${JSON.stringify(state.pin)}`]),
    "",
  ];
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, lines.join("\n"));
  await rename(temporary, path);
}

// ---------------------------------------------------------------------------
// Install: uv venv + hash-verified `uv pip install` from the embedded lock.
// ---------------------------------------------------------------------------

export const UV_MISSING_MESSAGE =
  "graphify needs uv (https://docs.astral.sh/uv/), which is not on PATH.\n" +
  "Install it yourself — Hive will not run a vendor's installer for you:\n" +
  "  curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
  "then re-run `hive graphify enable`. Everything else in Hive works without it.";

export interface GraphifyInstallDeps {
  which: (command: string) => string | null;
  run: CommandRunner;
}

export const defaultInstallDeps: GraphifyInstallDeps = {
  which: (command) => Bun.which(command),
  run: runCommand,
};

export type GraphifyOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

/** Create Hive's own venv and install the pinned, hash-verified closure into
 * it. The install step (and only the install step) runs with the caller's
 * real environment: uv needs its cache, proxies, and PATH, and the hashes —
 * not the environment — are what make the fetch trustworthy. */
export async function installGraphify(
  deps: GraphifyInstallDeps = defaultInstallDeps,
): Promise<GraphifyOutcome> {
  const uv = deps.which("uv");
  if (uv === null) return { ok: false, reason: UV_MISSING_MESSAGE };

  const tools = graphifyToolsDir();
  await mkdir(join(tools, "home"), { recursive: true });
  const lockPath = join(tools, "graphify.lock");
  await writeFile(lockPath, graphifyLock);

  // A fresh venv every install: re-enable after a pin bump must never layer
  // onto a stale environment.
  await rm(venvDir(), { recursive: true, force: true });
  const venv = await deps.run([uv, "venv", venvDir()], { timeoutMs: 120_000 });
  if (venv.exitCode !== 0) {
    return { ok: false, reason: `uv venv failed: ${venv.stderr.trim()}` };
  }

  const install = await deps.run(
    [
      uv,
      "pip",
      "install",
      "--python",
      join(venvDir(), "bin", "python"),
      "--require-hashes",
      "-r",
      lockPath,
    ],
    { timeoutMs: 600_000 },
  );
  if (install.exitCode !== 0) {
    return {
      ok: false,
      reason: install.timedOut
        ? "uv pip install timed out"
        : `uv pip install failed (hash or fetch error): ${install.stderr.trim().slice(-2000)}`,
    };
  }

  const probe = await deps.run([graphifyBin(), "--help"], {
    env: scrubbedGraphifyEnv(),
    timeoutMs: 30_000,
  });
  if (probe.exitCode !== 0) {
    return { ok: false, reason: `installed graphify does not run: ${probe.stderr.trim()}` };
  }
  return { ok: true, detail: `graphifyy==${graphifyPin()} (hash-verified) in ${tools}` };
}

// ---------------------------------------------------------------------------
// Graph builds: always --code-only, always scrubbed, always time-boxed.
// ---------------------------------------------------------------------------

/** Full extraction into `<root>/graphify-out/`. Local AST only: `--code-only`
 * is the pinned CLI's own zero-LLM switch, and the scrubbed environment makes
 * any upstream drift toward an LLM call fail loudly instead of egressing. */
export async function buildGraph(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const result = await run(
    [graphifyBin(), "extract", root, "--code-only"],
    { cwd: root, env: scrubbedGraphifyEnv(), timeoutMs: 900_000 },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: result.timedOut
        ? "graphify extract timed out after 15 minutes"
        : `graphify extract failed: ${result.stderr.trim().slice(-2000)}`,
    };
  }
  const summary = result.stdout.match(/wrote .*graph\.json: (.*)$/m);
  return { ok: true, detail: summary?.[1] ?? "graph written" };
}

/** Incremental re-extraction after HEAD moved (`graphify update`: code files
 * only, no LLM, per the pinned CLI). `--force` because landings legitimately
 * delete code and a shrinking graph must still apply; the caller only reloads
 * the server on exit 0, so a failed update leaves the old graph serving. */
export async function updateGraph(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const result = await run(
    [graphifyBin(), "update", root, "--force"],
    { cwd: root, env: scrubbedGraphifyEnv(), timeoutMs: 900_000 },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: result.timedOut
        ? "graphify update timed out after 15 minutes"
        : `graphify update failed: ${result.stderr.trim().slice(-2000)}`,
    };
  }
  return { ok: true, detail: "graph updated" };
}

// ---------------------------------------------------------------------------
// Ignore hygiene: `.git/info/exclude`, verified, never `.gitignore`.
// ---------------------------------------------------------------------------

const EXCLUDE_COMMENT = "# hive graphify: local knowledge graph, never committed";
const EXCLUDE_ENTRY = "graphify-out/";

/** Append `graphify-out/` to the repo's `.git/info/exclude` (the common dir,
 * so one entry covers every linked worktree) and prove it took: check-ignore
 * without `--no-index` answers from the index and would happily say "ignored"
 * about nothing. */
export async function ensureGraphifyIgnored(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const commonDir = await run(
    ["git", "rev-parse", "--git-common-dir"],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (commonDir.exitCode !== 0) {
    return { ok: false, reason: `not a git repo: ${commonDir.stderr.trim()}` };
  }
  const gitDir = commonDir.stdout.trim();
  const excludePath = join(
    isAbsolute(gitDir) ? gitDir : resolve(root, gitDir),
    "info",
    "exclude",
  );

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // No exclude file yet; git treats it as optional and so do we.
  }
  const present = existing
    .split("\n")
    .some((line) => line.trim() === EXCLUDE_ENTRY);
  if (!present) {
    await mkdir(dirname(excludePath), { recursive: true });
    const lead = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFile(
      excludePath,
      `${existing}${lead}${EXCLUDE_COMMENT}\n${EXCLUDE_ENTRY}\n`,
    );
  }

  const verify = await run(
    ["git", "check-ignore", "--no-index", "graphify-out/probe"],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (verify.exitCode !== 0) {
    return {
      ok: false,
      reason: "wrote .git/info/exclude but check-ignore --no-index does not confirm it",
    };
  }
  return { ok: true, detail: excludePath };
}

// ---------------------------------------------------------------------------
// Removal: the uninstall story is `rm -rf` twice and nothing else, because
// nothing else was ever written.
// ---------------------------------------------------------------------------

export async function purgeGraphify(root: string): Promise<string[]> {
  const removed: string[] = [];
  for (const path of [graphifyToolsDir(), graphOutDir(root)]) {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // force:true means the only failures are exotic (permissions); the
      // caller prints what was removed, and what wasn't stays visible.
    }
  }
  return removed;
}
