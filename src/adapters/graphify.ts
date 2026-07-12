/**
 * Graphify: an opt-in, repo-local code knowledge graph agents can query.
 * Design: docs/architecture/graphify-integration.md — the hard rules live
 * there and are enforced here:
 *
 *   - Installed as a Hive-built frozen bundle (docs/architecture/
 *     graphify-bundling.md): fetched from Hive's own release, sha256-verified
 *     against a constant embedded in this binary, unpacked only after the
 *     hash matches. No uv, no Python, no PyPI on the user's machine. The
 *     embedded lock remains the pin's source of truth — it is what the
 *     bundle was built from.
 *   - Every graphify invocation runs keyless from a scrubbed allowlist
 *     environment with `--code-only`, so the LLM-enrichment paths fail
 *     closed instead of sending repo content anywhere.
 *   - Invocation is by absolute path into Hive's own bundle dir; nothing
 *     lands on PATH and upstream's `graphify install` (which writes the
 *     user's global assistant configs) is never run.
 *   - `graphify-out/` is kept out of git via `.git/info/exclude` — Hive does
 *     not edit the repo's tracked `.gitignore` — and the exclusion is
 *     verified with `check-ignore --no-index`, because plain `check-ignore`
 *     consults the index and cannot prove anything.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import graphifyLock from "../../graphify.lock" with { type: "text" };
import { getHiveHome } from "../daemon/db";
import {
  graphifyArtifact,
  graphifyArtifactUrl,
  graphifyPlatformKey,
  type GraphifyArtifact,
} from "./graphify-artifacts";
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

/** One immutable bundle dir per pin, so a pin bump can never layer onto a
 * stale install: the new pin is simply a new directory. */
function bundleDir(): string {
  return join(graphifyToolsDir(), graphifyPin());
}

export function graphifyBin(): string {
  return join(bundleDir(), "graphify");
}

export function graphifyMcpBin(): string {
  return join(bundleDir(), "graphify-mcp");
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

/** Whether a human ever recorded a graphify decision for this repo (enable OR
 * decline). Absent state reads as disabled either way; this exists so consent
 * surfaces (the init question) ask once and then respect the answer. */
export function graphifyDecisionRecorded(root: string): boolean {
  return existsSync(graphifyStatePath(root));
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
// Install: fetch Hive's own frozen bundle, verify its sha256 against the
// constant embedded in this binary, and unpack only after it matches.
// ---------------------------------------------------------------------------

export function noArtifactMessage(platformKey: string): string {
  return (
    `this Hive build ships no graphify bundle for ${platformKey}; ` +
    "everything else in Hive works identically, and a future Hive release adds it."
  );
}

export interface GraphifyInstallDeps {
  /** The artifact this binary trusts for this platform, or null. */
  artifact: () => GraphifyArtifact | null;
  /** Fetch the published bundle bytes. Injectable so tests never hit the network. */
  fetchArtifact: (url: string) => Promise<Response>;
  run: CommandRunner;
}

export const defaultInstallDeps: GraphifyInstallDeps = {
  artifact: () => graphifyArtifact(),
  fetchArtifact: (url) =>
    fetch(url, { signal: AbortSignal.timeout(300_000) }),
  run: runCommand,
};

export type GraphifyOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

/** Probe both entry points of an unpacked bundle; a bundle that unpacked but
 * cannot run is a failed install, not a shrug. */
async function probeBundle(run: CommandRunner): Promise<GraphifyOutcome> {
  const probe = await run([graphifyBin(), "--help"], {
    env: scrubbedGraphifyEnv(),
    timeoutMs: 30_000,
  });
  if (probe.exitCode !== 0) {
    return { ok: false, reason: `installed graphify does not run: ${probe.stderr.trim()}` };
  }
  const mcpProbe = await run([graphifyMcpBin(), "--help"], {
    env: scrubbedGraphifyEnv(),
    timeoutMs: 30_000,
  });
  if (mcpProbe.exitCode !== 0) {
    return { ok: false, reason: `installed graphify MCP server does not run: ${mcpProbe.stderr.trim()}` };
  }
  return { ok: true, detail: `graphifyy==${graphifyPin()} in ${bundleDir()}` };
}

/** Download, verify, unpack, probe. Nothing is unpacked until the sha256 of
 * the downloaded bytes matches the constant this binary shipped with, so the
 * outcome is always "installed and working" or "cleanly absent" — there is no
 * half-install for an uninstall to miss. A bundle already on disk that probes
 * healthy is kept: the pin names the directory, so a pin bump reinstalls by
 * construction. */
export async function installGraphify(
  deps: GraphifyInstallDeps = defaultInstallDeps,
): Promise<GraphifyOutcome> {
  const artifact = deps.artifact();
  if (artifact === null) {
    return { ok: false, reason: noArtifactMessage(graphifyPlatformKey()) };
  }

  const tools = graphifyToolsDir();
  await mkdir(join(tools, "home"), { recursive: true });

  if (existsSync(graphifyBin())) {
    const probed = await probeBundle(deps.run);
    if (probed.ok) return { ok: true, detail: `${probed.detail} (already installed)` };
    // Present but broken: fall through to a fresh install over it.
  }

  const url = graphifyArtifactUrl(artifact);
  let response: Response;
  try {
    response = await deps.fetchArtifact(url);
  } catch (error) {
    return {
      ok: false,
      reason: `could not download the graphify bundle (${url}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `could not download the graphify bundle (${url}): HTTP ${response.status}` };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    return {
      ok: false,
      reason:
        `refusing to install: downloaded bundle hash ${digest} does not match the ` +
        `sha256 this Hive build trusts (${artifact.sha256}) for ${artifact.asset}`,
    };
  }

  const tarball = join(tools, `${artifact.asset}.download`);
  await writeFile(tarball, bytes);
  try {
    await rm(bundleDir(), { recursive: true, force: true });
    await mkdir(bundleDir(), { recursive: true });
    const untar = await deps.run(
      ["/usr/bin/tar", "-xf", tarball, "-C", bundleDir(), "--strip-components", "1"],
      { timeoutMs: 120_000 },
    );
    if (untar.exitCode !== 0) {
      await rm(bundleDir(), { recursive: true, force: true });
      return { ok: false, reason: `could not unpack the graphify bundle: ${untar.stderr.trim()}` };
    }
  } finally {
    await rm(tarball, { force: true });
  }

  const probed = await probeBundle(deps.run);
  if (!probed.ok) {
    await rm(bundleDir(), { recursive: true, force: true });
    return probed;
  }
  return { ok: true, detail: `${probed.detail} (sha256-verified)` };
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
  // Regenerated before every build so new gitignore rules keep taking effect,
  // and folded into the detail so what was excluded is said out loud.
  const ignore = await writeGraphifyIgnore(root, run);
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
  return {
    ok: true,
    detail: `${summary?.[1] ?? "graph written"}${ignore.ok ? ` (${ignore.detail})` : ""}`,
  };
}

/** Incremental re-extraction after HEAD moved (`graphify update`: code files
 * only, no LLM, per the pinned CLI). `--force` because landings legitimately
 * delete code and a shrinking graph must still apply; the caller only reloads
 * the server on exit 0, so a failed update leaves the old graph serving. */
export async function updateGraph(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  // Same regeneration as buildGraph: a landing can introduce gitignore rules,
  // and the incremental walk honours the ignore file for changed files.
  await writeGraphifyIgnore(root, run);
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
// The spawn-brief digest (integration doc, layer 1): graph-derived context
// injected by the daemon, so the graph pays out even for an agent that never
// touches the MCP tools.
// ---------------------------------------------------------------------------

const GRAPH_BRIEF_PREAMBLE =
  "Graph context (graphify, advisory): a task-scoped slice of this repo's local code " +
  "knowledge graph. It is a hint for orientation — upstream accuracy is 45-76% — so " +
  "verify anything load-bearing against the source before building on it.";

/** Keeps the digest a hint-sized fraction of the prompt: ~1500 tokens with
 * the preamble, alongside a scoped brief of similar size. */
const GRAPH_BRIEF_MAX_CHARS = 6_000;
const GRAPH_BRIEF_TIMEOUT_MS = 3_000;

/** The query's serializer writes every NODE line before the first EDGE line,
 * so a small `--budget` cuts the output before the edges — the only cited,
 * provenance-tagged content — ever appear (measured: on this repo edges start
 * near budget 16000; Hive's old 1200 delivered zero, always). The budget is
 * therefore large enough that edges reliably survive serialization, and
 * selectGraphBrief — not this number — bounds what the brief costs. Measured
 * at 40000 against this repo: ~450ms, ~56KB, well inside the time-box. */
const GRAPH_QUERY_BUDGET = 40_000;
const GRAPH_BRIEF_HEADER_MAX_CHARS = 800;
const GRAPH_BRIEF_NODE_MAX_CHARS = 2_000;

/** Select — never head-slice — the digest out of a `graphify query` dump.
 * The output shape is: header, all NODE lines (name + file:line citation),
 * then all EDGE lines (the provenance-tagged relations). A head slice keeps
 * the least dense part and always drops every edge, so this keeps the header,
 * the edges up to their own budget, and then the node lines that ground those
 * edges' endpoints with citations, before any other nodes. */
export function selectGraphBrief(output: string): string {
  const lines = output.split("\n");
  const headerLines: string[] = [];
  const nodeLines: string[] = [];
  const edgeLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("NODE ")) nodeLines.push(line);
    else if (line.startsWith("EDGE ")) edgeLines.push(line);
    else if (nodeLines.length === 0 && edgeLines.length === 0 && line !== "") {
      headerLines.push(line);
    }
  }

  let header = headerLines.join("\n");
  if (header.length > GRAPH_BRIEF_HEADER_MAX_CHARS) {
    header = `${header.slice(0, GRAPH_BRIEF_HEADER_MAX_CHARS)}…`;
  }

  const edgeBudget =
    GRAPH_BRIEF_MAX_CHARS - header.length - GRAPH_BRIEF_NODE_MAX_CHARS;
  const keptEdges: string[] = [];
  let edgeChars = 0;
  for (const line of edgeLines) {
    if (edgeChars + line.length + 1 > edgeBudget) break;
    keptEdges.push(line);
    edgeChars += line.length + 1;
  }

  // `EDGE <a> --relation [TAG …]--> <b>`: a node cited in a kept edge earns
  // its NODE line (that is where the file:line lives) ahead of the rest, in
  // the order the edges cite it — the head edges are the traversal's closest.
  const endpointRank = new Map<string, number>();
  for (const line of keptEdges) {
    const match = line.match(/^EDGE (.*?) --.*?--> (.*)$/);
    for (const name of [match?.[1], match?.[2]]) {
      if (name !== undefined && !endpointRank.has(name)) {
        endpointRank.set(name, endpointRank.size);
      }
    }
  }
  const nodeName = (line: string): string =>
    (line.match(/^NODE (.*?)(?: \[src=.*)?$/)?.[1] ?? line).trim();
  const cited = nodeLines.filter((line) => endpointRank.has(nodeName(line)));
  cited.sort(
    (a, b) =>
      (endpointRank.get(nodeName(a)) as number) -
      (endpointRank.get(nodeName(b)) as number),
  );
  const orderedNodes = [
    ...cited,
    ...nodeLines.filter((line) => !endpointRank.has(nodeName(line))),
  ];
  const keptNodes: string[] = [];
  let nodeChars = 0;
  for (const line of orderedNodes) {
    if (nodeChars + line.length + 1 > GRAPH_BRIEF_NODE_MAX_CHARS) break;
    keptNodes.push(line);
    nodeChars += line.length + 1;
  }

  // Truncation must be visible: an elided section that looks complete reads
  // as "the graph had nothing else", which is the absent-is-unknown bug.
  const summary =
    `[graph brief: kept ${keptNodes.length}/${nodeLines.length} nodes, ` +
    `${keptEdges.length}/${edgeLines.length} edges]`;
  return [header, keptNodes.join("\n"), keptEdges.join("\n"), summary]
    .filter((section) => section !== "")
    .join("\n\n");
}

/** The task-scoped digest for a spawn brief, or null when this repo never
 * opted in (silence — a repo without graphify should not hear about it).
 * Once opted in, every failure degrades to one loud line instead: an absent
 * graph must never look like a repo with nothing to find. Bounded by the
 * query's own token budget and a hard time-box; the spawn never waits longer
 * than this on graphify, healthy or not. */
export async function buildGraphBrief(
  root: string,
  task: string,
  run: CommandRunner = runCommand,
): Promise<string | null> {
  const state = await readGraphifyState(root);
  if (!state.enabled) return null;
  if (!existsSync(graphifyBin()) || !existsSync(graphJsonPath(root))) {
    return "Graph context: unavailable (graph not built yet); proceeding without it.";
  }
  const result = await run(
    [
      graphifyBin(),
      "query",
      task,
      "--budget",
      String(GRAPH_QUERY_BUDGET),
      "--graph",
      graphJsonPath(root),
    ],
    { cwd: root, env: scrubbedGraphifyEnv(), timeoutMs: GRAPH_BRIEF_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    return `Graph context: unavailable (${
      result.timedOut ? "query timed out" : "query failed"
    }); proceeding without it.`;
  }
  const output = result.stdout.trim();
  if (output === "") {
    return "Graph context: unavailable (empty query result); proceeding without it.";
  }
  return `${GRAPH_BRIEF_PREAMBLE}\n\n${selectGraphBrief(output)}`;
}

// ---------------------------------------------------------------------------
// The serving snapshot: the MCP server must never read a file a rebuild is
// rewriting.
// ---------------------------------------------------------------------------

/** The graph file the MCP server is pointed at. The serve process re-resolves
 * and re-reads its graph from disk on every query (upstream's hot-reload), and
 * `graphify update` rewrites `graphify-out/graph.json` in place — so a server
 * aimed at the live file answers "graph.json not found" to any query landing
 * inside a rebuild's write window, which post-landing rebuilds open on every
 * merge (measured 2026-07-12: a fresh agent hit exactly that). The daemon
 * therefore serves a copy under Hive's project state dir that no rebuild ever
 * touches; each successful rebuild refreshes it and restarts the server. */
export function servingGraphPath(root: string): string {
  return join(projectStateDir(root), "graphify-serving", "graph.json");
}

/** Refresh the serving snapshot from the freshly built graph. The copy lands
 * via tmp+rename so even the snapshot itself is never half-written. */
export async function snapshotGraphForServing(
  root: string,
): Promise<GraphifyOutcome> {
  const target = servingGraphPath(root);
  try {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await copyFile(graphJsonPath(root), temporary);
    await rename(temporary, target);
  } catch (error) {
    return {
      ok: false,
      reason: `could not snapshot graph for serving: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  // Display-only annotation sidecar, read from the served graph's directory;
  // absent upstream degrades to un-annotated output, so best-effort is right.
  try {
    await copyFile(
      join(graphOutDir(root), ".graphify_learning.json"),
      join(dirname(target), ".graphify_learning.json"),
    );
  } catch {
    // No sidecar to carry over.
  }
  return { ok: true, detail: target };
}

// ---------------------------------------------------------------------------
// Ignore hygiene: `.git/info/exclude`, verified, never `.gitignore`.
// ---------------------------------------------------------------------------

const EXCLUDE_COMMENT = "# hive graphify: local knowledge graph, never committed";
/** Both are Hive-written, machine-local state: the graph output dir and the
 * generated ignore file below. Excluding them here — never in the tracked
 * `.gitignore` — is what keeps enablement from mutating the user's repo. */
const EXCLUDE_ENTRIES = ["graphify-out/", ".graphifyignore"];

/** Append Hive's graphify entries to the repo's `.git/info/exclude` (the
 * common dir, so one entry covers every linked worktree) and prove they took:
 * check-ignore without `--no-index` answers from the index and would happily
 * say "ignored" about nothing. */
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
  const lines = existing.split("\n").map((line) => line.trim());
  const missing = EXCLUDE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length > 0) {
    await mkdir(dirname(excludePath), { recursive: true });
    const lead = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFile(
      excludePath,
      `${existing}${lead}${EXCLUDE_COMMENT}\n${missing.join("\n")}\n`,
    );
  }

  const verify = await run(
    ["git", "check-ignore", "--no-index", "graphify-out/probe", ".graphifyignore"],
    { cwd: root, timeoutMs: 10_000 },
  );
  // check-ignore exits 0 when ANY path is ignored; both must be, so count the
  // echoed matches instead of trusting the exit code.
  if (
    verify.exitCode !== 0 ||
    verify.stdout.trim().split("\n").length !== EXCLUDE_ENTRIES.length
  ) {
    return {
      ok: false,
      reason: "wrote .git/info/exclude but check-ignore --no-index does not confirm it",
    };
  }
  return { ok: true, detail: excludePath };
}

/** Remove exactly the exclude lines `ensureGraphifyIgnored` appended (the
 * comment and the entry), leaving every other line byte-identical. Uninstall
 * calls this; it is a no-op on a repo Hive never touched. */
export async function removeGraphifyExcludeEntry(
  root: string,
  run: CommandRunner = runCommand,
): Promise<boolean> {
  const commonDir = await run(
    ["git", "rev-parse", "--git-common-dir"],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (commonDir.exitCode !== 0) return false;
  const gitDir = commonDir.stdout.trim();
  const excludePath = join(
    isAbsolute(gitDir) ? gitDir : resolve(root, gitDir),
    "info",
    "exclude",
  );
  let existing: string;
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    return false;
  }
  const kept = existing
    .split("\n")
    .filter((line) =>
      !EXCLUDE_ENTRIES.includes(line.trim()) && line !== EXCLUDE_COMMENT
    );
  if (kept.length === existing.split("\n").length) return false;
  await writeFile(excludePath, kept.join("\n"));
  return true;
}

// ---------------------------------------------------------------------------
// The generated .graphifyignore: keep vendored dependencies out of the graph.
// ---------------------------------------------------------------------------

/** First line of a Hive-generated `.graphifyignore`. A file without it is the
 * user's own and is never rewritten or removed. */
export const GRAPHIFY_IGNORE_MARKER =
  "# Generated by Hive from this repo's own gitignore rules; excluded from git via .git/info/exclude.";

/** Vendored-dependency dirs that are commonly *committed*, so no gitignore
 * rule ever names them. Everything gitignored is handled by the derived
 * section instead — this floor is deliberately short, because a hand-kept
 * ecosystem list is always one ecosystem behind. */
const VENDORED_DIR_FLOOR = [
  ".build/",
  ".swiftpm/",
  "Pods/",
  "Carthage/",
  "DerivedData/",
  "vendor/",
  "third_party/",
  "bower_components/",
  ".gradle/",
];

/** Keep the pattern list bounded: extraction evaluates every pattern against
 * every file, and a monorepo can gitignore thousands of directories. */
const GITIGNORED_DIR_CAP = 400;

/** Write `<root>/.graphifyignore` so extraction skips vendored dependencies.
 *
 * Why this exists at all: the pinned binary honours gitignore rules **only
 * from the scan root itself** (`_load_graphifyignore` walks ancestors, never
 * descendants), so a nested declaration like `workspace/.gitignore: .build/`
 * is invisible to it — measured on this repo, that one gap put 5,142 vendored
 * Swift nodes (51%) into the graph and poisoned query start-node selection.
 * The repo's own gitignore rules are the general signal: they are the team's
 * declaration of "not our code", per-repo, ecosystem-free. `git ls-files
 * --ignored` evaluates them at every level, so its directory list is exactly
 * the nested-gitignore knowledge the binary cannot see, and the static floor
 * covers vendored dirs that teams commit. The file lands in the repo root
 * because the binary reads it nowhere else; the `.git/info/exclude` entry
 * above keeps it out of anyone's `git status`.
 *
 * Over-exclusion is a silent failure, so: a `.graphifyignore` Hive did not
 * generate is left alone entirely (edit or replace the file to override any
 * rule — gitignore `!` negations win by last-match), and callers surface the
 * returned detail so what was excluded is said out loud at build time. */
export async function writeGraphifyIgnore(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const path = join(root, ".graphifyignore");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // Absent: generate below.
  }
  if (existing !== null && !existing.startsWith(GRAPHIFY_IGNORE_MARKER)) {
    return { ok: true, detail: ".graphifyignore is user-authored; left untouched" };
  }

  // Everything the repo's own gitignore machinery (root, nested, and
  // .git/info/exclude) already excludes, collapsed to directories.
  const ignored = await run(
    ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { cwd: root, timeoutMs: 30_000 },
  );
  const derived = ignored.exitCode !== 0
    ? []
    : ignored.stdout
        .split("\n")
        .filter((line) => line.endsWith("/") && line !== "graphify-out/");
  const capped = derived.slice(0, GITIGNORED_DIR_CAP);

  const lines = [
    GRAPHIFY_IGNORE_MARKER,
    "# Regenerated before each graph build. To override, replace this file with",
    "# your own (any content not starting with the line above is never touched).",
    "",
    "# Vendored-dependency dirs that are commonly committed:",
    ...VENDORED_DIR_FLOOR,
    "",
    "# Directories this repo's own gitignore rules exclude:",
    ...capped.map((dir) => `/${dir}`),
    ...(derived.length > capped.length
      ? [`# (+${derived.length - capped.length} more git-ignored directories omitted)`]
      : []),
    "",
  ];
  // Never let ignore hygiene block a build: an unwritable root degrades to
  // extraction without exclusions, reported through the build detail.
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, lines.join("\n"));
    await rename(temporary, path);
  } catch (error) {
    return {
      ok: false,
      reason: `could not write .graphifyignore: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    ok: true,
    detail: `excluding ${VENDORED_DIR_FLOOR.length} common vendored patterns` +
      `${capped.length > 0 ? ` and ${capped.length} git-ignored dirs (${capped.slice(0, 5).join(" ")}${capped.length > 5 ? " …" : ""})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Removal: the durable install is `rm -rf` twice. Spawn-time hook files are
// derived runtime config: they fail open once this removes the server and are
// removed with their worktrees (or by the next graphless config write).
// ---------------------------------------------------------------------------

export async function purgeGraphify(root: string): Promise<string[]> {
  const removed: string[] = [];
  for (const path of [graphifyToolsDir(), graphOutDir(root), dirname(servingGraphPath(root))]) {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // force:true means the only failures are exotic (permissions); the
      // caller prints what was removed, and what wasn't stays visible.
    }
  }
  // The generated ignore file goes too — but only Hive's: a user-authored
  // .graphifyignore (no marker) is their file, not our uninstall's.
  const ignorePath = join(root, ".graphifyignore");
  try {
    if ((await readFile(ignorePath, "utf8")).startsWith(GRAPHIFY_IGNORE_MARKER)) {
      await rm(ignorePath, { force: true });
      removed.push(ignorePath);
    }
  } catch {
    // Absent or unreadable: nothing of Hive's to remove.
  }
  return removed;
}
