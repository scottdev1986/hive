/** Graphify: Hive's repo-local code knowledge graph. Four rules hold this module together, and every one of them exists to keep a third-party tool from reaching the network, the user's global config, or their git history on Hive's behalf: - Installed as a Hive-built frozen bundle: fetched from Hive's signed runtime channel and unpacked only after its size and SHA-256 match the signed manifest. No uv, Python, or PyPI on a user's machine. - Every graphify invocation runs keyless from a scrubbed allowlist environment with `--code-only`, so the LLM-enrichment paths fail closed instead of sending repo content anywhere. - Invocation is by absolute path into Hive's own bundle dir; nothing lands on PATH and upstream's `graphify install` (which writes the user's global assistant configs) is never run. - `hive init` keeps graphify's generated files out of git through the repository's tracked `.gitignore`. */
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import graphifyLock from "../../graphify.lock" with { type: "text" };
import { projectStateDir } from "../daemon/project-identity-core/state";
import { machineHiveHome } from "../hive-home/home";
import { fetchGraphifyRelease, type GraphifyRelease } from "./graphify-channel";
import { errorMessage } from "../shared/error-message";
import { withFileLock } from "./file-lock";

/** The source pin CI and local development build. Runtime clients follow the signed channel instead, so publishing Graphify never edits Hive source. */
export function graphifyPin(): string {
  const match = graphifyLock.match(/^graphifyy(?:\[[^\]]*\])?==(\S+?)\s*\\?$/m);
  if (match === null) {
    throw new Error("graphify.lock does not pin graphifyy — regenerate it");
  }
  return match[1] as string;
}

export function graphifyToolsDir(): string {
  return join(machineHiveHome(), "tools", "graphify");
}

/** One immutable bundle dir per pin, so a pin bump can never layer onto a stale install: the new pin is simply a new directory. */
function legacyBundleDir(): string {
  return join(graphifyToolsDir(), graphifyPin());
}

export function graphifyBin(): string {
  const current = join(graphifyToolsDir(), "current", "graphify");
  return existsSync(current) ? current : join(legacyBundleDir(), "graphify");
}

export function graphifyMcpBin(): string {
  const current = join(graphifyToolsDir(), "current", "graphify-mcp");
  return existsSync(current)
    ? current
    : join(legacyBundleDir(), "graphify-mcp");
}

export function graphOutDir(root: string): string {
  return join(root, "graphify-out");
}

export function graphJsonPath(root: string): string {
  return join(graphOutDir(root), "graph.json");
}

/** The environment every graphify process gets: an allowlist, not a scrub of known key names, so a provider key Hive has never heard of still cannot leak. HOME points into Hive's tools dir so upstream's `~/.graphify` global state is never read or written. Enrichment without a key errors upstream — that error is the fail-closed backstop the design relies on. */
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

export const runCommand: CommandRunner = async (argv, options) => {
  const proc = Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
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

export interface GraphifyInstallDeps {
  resolveRelease: () => Promise<GraphifyRelease>;
  fetchArtifact: (url: string) => Promise<Response>;
  run: CommandRunner;
}

export const defaultInstallDeps: GraphifyInstallDeps = {
  resolveRelease: () => fetchGraphifyRelease(),
  fetchArtifact: async (url) => {
    if (url.startsWith("file:")) {
      return new Response(await readFile(new URL(url)));
    }
    return fetch(url, { signal: AbortSignal.timeout(300_000) });
  },
  run: runCommand,
};

export type GraphifyOutcome =
  | { ok: true; detail: string; changed?: boolean }
  | { ok: false; reason: string };

/** Probe both entry points of an unpacked bundle; a bundle that unpacked but cannot run is a failed install, not a shrug. */
async function probeBundle(
  directory: string,
  run: CommandRunner,
): Promise<GraphifyOutcome> {
  const probe = await run([join(directory, "graphify"), "--help"], {
    env: scrubbedGraphifyEnv(),
    timeoutMs: 30_000,
  });
  if (probe.exitCode !== 0) {
    return {
      ok: false,
      reason: `installed graphify does not run: ${probe.stderr.trim()}`,
    };
  }
  const mcpProbe = await run([join(directory, "graphify-mcp"), "--help"], {
    env: scrubbedGraphifyEnv(),
    timeoutMs: 30_000,
  });
  if (mcpProbe.exitCode !== 0) {
    return {
      ok: false,
      reason: `installed graphify MCP server does not run: ${mcpProbe.stderr.trim()}`,
    };
  }
  return { ok: true, detail: `Graphify runtime in ${directory}` };
}

/** Point `current` at a bundle, atomically. `symlink` refuses to replace an existing name, so the switch is made by creating the link under a private name and renaming it over `current` — rename being the only swap the filesystem performs in one step. An agent resolving `current` during an upgrade therefore sees the old bundle or the new one, never a missing link, which is what unlink-then-symlink would give it. The private name carries this process's pid so two Hives upgrading at once do not stage over each other. */
async function activateBundle(tools: string, directory: string): Promise<void> {
  const temporary = join(tools, `.current-${process.pid}`);
  await rm(temporary, { force: true });
  await symlink(directory, temporary);
  await rename(temporary, join(tools, "current"));
}

function runtimeOrder(value: string): readonly number[] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)-hive\.(\d+)$/);
  return match === null ? null : match.slice(1).map(Number);
}

function isOlderRuntime(candidate: string, active: string): boolean {
  const left = runtimeOrder(candidate);
  const right = runtimeOrder(active);
  if (left === null || right === null) return false;
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

export async function installGraphify(
  deps: GraphifyInstallDeps = defaultInstallDeps,
): Promise<GraphifyOutcome> {
  let release: GraphifyRelease;
  try {
    release = await deps.resolveRelease();
  } catch (error) {
    return withGraphifyInstallLock(async () => {
      const current = dirname(graphifyBin());
      if (existsSync(graphifyBin())) {
        const cached = await probeBundle(current, deps.run);
        if (cached.ok) {
          return {
            ok: true,
            detail: `${cached.detail} (channel unavailable: ${errorMessage(
              error,
            )})`,
          };
        }
      }
      return {
        ok: false,
        reason: errorMessage(error),
      };
    });
  }

  return withGraphifyInstallLock(() => installGraphifyLocked(release, deps));
}

async function withGraphifyInstallLock(
  operation: () => Promise<GraphifyOutcome>,
): Promise<GraphifyOutcome> {
  const tools = graphifyToolsDir();
  await mkdir(dirname(tools), { recursive: true });
  return withFileLock(`${tools}.install.lock`, operation, {
    deadlineMs: 600_000,
  });
}

async function installGraphifyLocked(
  release: GraphifyRelease,
  deps: GraphifyInstallDeps,
): Promise<GraphifyOutcome> {
  const artifact = release.artifact;
  const tools = graphifyToolsDir();
  const releaseId = `${release.manifest.graphifyVersion}-hive.${release.manifest.hiveBuild}`;
  const current = join(tools, "current");
  const activeId = await realpath(current)
    .then((path) => path.slice(path.lastIndexOf("/") + 1))
    .catch(() => null);
  if (
    !release.local &&
    activeId !== null &&
    isOlderRuntime(releaseId, activeId)
  ) {
    return {
      ok: true,
      detail: `kept newer verified Graphify runtime ${activeId}`,
    };
  }
  const directory = join(tools, "versions", releaseId);
  if (existsSync(join(directory, "graphify"))) {
    const probed = await probeBundle(directory, deps.run);
    if (probed.ok) {
      await activateBundle(tools, directory);
      return {
        ok: true,
        detail: `graphifyy==${release.manifest.graphifyVersion} (${release.local ? "local" : release.signed ? "signed" : "GitHub-trusted"}, already installed)`,
      };
    }
  }

  let response: Response;
  try {
    response = await deps.fetchArtifact(artifact.url);
  } catch (error) {
    return {
      ok: false,
      reason: `could not download the graphify bundle (${artifact.url}): ${errorMessage(
        error,
      )}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `could not download the graphify bundle (${artifact.url}): HTTP ${response.status}`,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== artifact.size) {
    return {
      ok: false,
      reason: `refusing to install: downloaded bundle size ${bytes.byteLength} does not match signed size ${artifact.size}`,
    };
  }
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    return {
      ok: false,
      reason:
        `refusing to install: downloaded bundle hash ${digest} does not match the ` +
        `manifest sha256 (${artifact.sha256}) for ${artifact.name}`,
    };
  }

  await mkdir(join(tools, "home"), { recursive: true });
  await mkdir(join(tools, "versions"), { recursive: true });
  const tarball = join(tools, `${artifact.name}.download`);
  await writeFile(tarball, bytes);
  try {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const untar = await deps.run(
      [
        "/usr/bin/tar",
        "-xf",
        tarball,
        "-C",
        directory,
        "--strip-components",
        "1",
      ],
      { timeoutMs: 120_000 },
    );
    if (untar.exitCode !== 0) {
      await rm(directory, { recursive: true, force: true });
      return {
        ok: false,
        reason: `could not unpack the graphify bundle: ${untar.stderr.trim()}`,
      };
    }
  } finally {
    await rm(tarball, { force: true });
  }

  const probed = await probeBundle(directory, deps.run);
  if (!probed.ok) {
    await rm(directory, { recursive: true, force: true });
    return probed;
  }
  await activateBundle(tools, directory);
  return {
    ok: true,
    detail: `graphifyy==${release.manifest.graphifyVersion} (${release.local ? "local" : release.signed ? "signature and SHA-256 verified" : "GitHub and SHA-256 verified"})`,
    changed: true,
  };
}

export async function buildGraph(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const ignore = await writeGraphifyIgnore(root, run);
  const result = await run([graphifyBin(), "extract", root, "--code-only"], {
    cwd: root,
    env: scrubbedGraphifyEnv(),
    timeoutMs: 900_000,
  });
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

export async function updateGraph(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  await writeGraphifyIgnore(root, run);
  const result = await run([graphifyBin(), "update", root, "--force"], {
    cwd: root,
    env: scrubbedGraphifyEnv(),
    timeoutMs: 900_000,
  });
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

const GRAPH_BRIEF_PREAMBLE =
  "Graph context (graphify, advisory): a task-scoped slice of this repo's local code " +
  "knowledge graph. It is a hint for orientation — upstream accuracy is 45-76% — so " +
  "verify anything load-bearing against the source before building on it.";

const GRAPH_BRIEF_MAX_CHARS = 6_000;
const GRAPH_BRIEF_TIMEOUT_MS = 3_000;

/** The serializer emits every node before any edge, so the query budget must reach provenance-bearing edges. `selectGraphBrief` bounds prompt cost. */
const GRAPH_QUERY_BUDGET = 40_000;
const GRAPH_BRIEF_HEADER_MAX_CHARS = 800;
const GRAPH_BRIEF_NODE_MAX_CHARS = 2_000;

const BRIEF_SEED_FILES = 5;
const BRIEF_EXPANSION_FILES = 8;
const BRIEF_SYMBOLS_PER_FILE = 3;
/** A hub file touching many weakly matched symbols stops accumulating here, so `db.ts`-shaped files cannot crowd out precise leads. */
const BRIEF_SYMBOL_BONUS_CAP = 25;

interface BriefNode {
  id: string;
  label: string;
  file: string;
  location: string;
  community: string;
  tokens: Set<string>;
}

const BRIEF_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "where",
  "does",
  "do",
  "is",
  "are",
  "how",
  "what",
  "when",
  "why",
  "and",
  "or",
  "that",
  "this",
  "its",
  "into",
  "new",
  "another",
  "after",
  "happen",
]);

function stemToken(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function briefTokens(text: string): Set<string> {
  const parts =
    text.replace(/([a-z])([A-Z])/g, "$1 $2").match(/[A-Za-z]{3,}/g) ?? [];
  const out = new Set<string>();
  for (const part of parts) {
    const token = stemToken(part.toLowerCase());
    if (!BRIEF_STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/** Test and doc files are legitimate leads but must not outrank the code that answers; the dampening is a rank nudge, not an exclusion. */
function briefDamp(file: string): number {
  let damp = 1.0;
  if (file.toLowerCase().includes("test")) damp *= 0.3;
  if (file.endsWith(".md")) damp *= 0.7;
  return damp;
}

/** Locate from task-matched seeds plus one normalized structural hop. Output retains the binary's cited NODE/EDGE grammar; invalid or matchless graphs return null for the bounded binary fallback. */
export function buildTargetedGraphBrief(
  graph: unknown,
  task: string,
): string | null {
  if (typeof graph !== "object" || graph === null) return null;
  const raw = graph as { nodes?: unknown; links?: unknown; edges?: unknown };
  if (!Array.isArray(raw.nodes)) return null;
  const rawLinks = Array.isArray(raw.links)
    ? raw.links
    : Array.isArray(raw.edges)
      ? raw.edges
      : null;
  if (rawLinks === null) return null;

  const nodes = new Map<string, BriefNode>();
  const fileLabelTokens = new Map<string, Set<string>>();
  const fileNodes = new Map<string, BriefNode[]>();
  for (const entry of raw.nodes as Record<string, unknown>[]) {
    if (typeof entry?.id !== "string") continue;
    const label = typeof entry.label === "string" ? entry.label : entry.id;
    const file = typeof entry.source_file === "string" ? entry.source_file : "";
    const node: BriefNode = {
      id: entry.id,
      label,
      file,
      location:
        typeof entry.source_location === "string" ? entry.source_location : "",
      community:
        typeof entry.community === "number" ? String(entry.community) : "",
      tokens: briefTokens(label),
    };
    nodes.set(node.id, node);
    if (file === "") continue;
    const tokens = fileLabelTokens.get(file) ?? new Set<string>();
    for (const t of node.tokens) tokens.add(t);
    fileLabelTokens.set(file, tokens);
    const list = fileNodes.get(file) ?? [];
    list.push(node);
    fileNodes.set(file, list);
  }
  if (fileLabelTokens.size === 0) return null;

  const documentFrequency = new Map<string, number>();
  for (const [file, labelTokens] of fileLabelTokens) {
    const all = new Set([...labelTokens, ...briefTokens(file)]);
    for (const t of all) {
      documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
    }
  }
  const fileCount = fileLabelTokens.size;
  const idf = (token: string): number =>
    Math.log(1 + fileCount / (1 + (documentFrequency.get(token) ?? 0)));

  interface BriefLink {
    relation: string;
    confidence: string;
    context: string;
    source: BriefNode;
    target: BriefNode;
  }
  const links: BriefLink[] = [];
  const fileLinkCounts = new Map<string, Map<string, number>>();
  for (const entry of rawLinks as Record<string, unknown>[]) {
    const source =
      typeof entry?.source === "string" ? nodes.get(entry.source) : undefined;
    const target =
      typeof entry?.target === "string" ? nodes.get(entry.target) : undefined;
    if (source === undefined || target === undefined) continue;
    links.push({
      relation: typeof entry.relation === "string" ? entry.relation : "related",
      confidence:
        typeof entry.confidence === "string" ? entry.confidence : "UNKNOWN",
      context: typeof entry.context === "string" ? entry.context : "",
      source,
      target,
    });
    if (
      source.file !== "" &&
      target.file !== "" &&
      source.file !== target.file
    ) {
      for (const [a, b] of [
        [source.file, target.file],
        [target.file, source.file],
      ] as const) {
        const counts = fileLinkCounts.get(a) ?? new Map<string, number>();
        counts.set(b, (counts.get(b) ?? 0) + 1);
        fileLinkCounts.set(a, counts);
      }
    }
  }

  const taskTokens = briefTokens(task);
  const fileScore = new Map<string, number>();
  for (const [file, labelTokens] of fileLabelTokens) {
    const baseTokens = briefTokens(file.split("/").at(-1) ?? file);
    const pathTokens = briefTokens(file);
    let score = 0;
    for (const t of taskTokens) {
      if (baseTokens.has(t)) score += 3 * idf(t);
      else if (labelTokens.has(t)) score += 2 * idf(t);
      else if (pathTokens.has(t)) score += 1.5 * idf(t);
    }
    score *= briefDamp(file);
    if (score > 0) fileScore.set(file, score);
  }
  if (fileScore.size === 0) return null;
  const seeds = [...fileScore.keys()]
    .sort((a, b) => (fileScore.get(b) as number) - (fileScore.get(a) as number))
    .slice(0, BRIEF_SEED_FILES);
  const seedSet = new Set(seeds);

  const neighborScore = new Map<string, number>();
  for (const seed of seeds) {
    for (const [neighbor, count] of fileLinkCounts.get(seed) ?? []) {
      if (seedSet.has(neighbor)) continue;
      const degree = fileLinkCounts.get(neighbor)?.size ?? 0;
      let hitIdf = 0;
      for (const t of taskTokens) {
        if (fileLabelTokens.get(neighbor)?.has(t) ?? false) hitIdf += idf(t);
      }
      neighborScore.set(
        neighbor,
        (neighborScore.get(neighbor) ?? 0) +
          ((1 + Math.log(1 + count)) / Math.log(2 + degree)) *
            (1 + hitIdf) *
            briefDamp(neighbor),
      );
    }
  }
  const symbolBonus = new Map<string, number>();
  const seenSymbol = new Set<string>();
  for (const link of links) {
    for (const [near, far, symbol] of [
      [link.source.file, link.target.file, link.target],
      [link.target.file, link.source.file, link.source],
    ] as const) {
      if (
        !seedSet.has(near) ||
        far === "" ||
        seedSet.has(far) ||
        far === near
      ) {
        continue;
      }
      const key = `${symbol.id} ${far}`;
      if (seenSymbol.has(key)) continue;
      let matchIdf = 0;
      for (const t of symbol.tokens) if (taskTokens.has(t)) matchIdf += idf(t);
      if (matchIdf === 0) continue;
      seenSymbol.add(key);
      symbolBonus.set(
        far,
        (symbolBonus.get(far) ?? 0) + 2 * matchIdf * briefDamp(far),
      );
    }
  }
  for (const [file, bonus] of symbolBonus) {
    neighborScore.set(
      file,
      (neighborScore.get(file) ?? 0) + Math.min(bonus, BRIEF_SYMBOL_BONUS_CAP),
    );
  }
  const expansion = [...neighborScore.keys()]
    .sort(
      (a, b) =>
        (neighborScore.get(b) as number) - (neighborScore.get(a) as number),
    )
    .slice(0, BRIEF_EXPANSION_FILES);
  const selected = [...seeds, ...expansion];
  const selectedSet = new Set(selected);

  const nodeLines: string[] = [];
  for (const file of selected) {
    const own = fileNodes.get(file) ?? [];
    const moduleNode =
      own.find((n) => n.label === (file.split("/").at(-1) ?? "")) ?? own[0];
    const symbols = own
      .filter((n) => n !== moduleNode)
      .map((n) => {
        let s = 0;
        for (const t of n.tokens) if (taskTokens.has(t)) s += idf(t);
        return { n, s };
      })
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, BRIEF_SYMBOLS_PER_FILE)
      .map(({ n }) => n);
    for (const n of [
      ...(moduleNode === undefined ? [] : [moduleNode]),
      ...symbols,
    ]) {
      nodeLines.push(
        `NODE ${n.label} [src=${n.file}${n.location === "" ? "" : ` loc=${n.location}`}${n.community === "" ? "" : ` community=${n.community}`}]`,
      );
    }
  }
  const edgeLines: string[] = [];
  const seenEdges = new Set<string>();
  const formatEdge = (link: BriefLink): string =>
    `EDGE ${link.source.label} --${link.relation} [${link.confidence}${link.context === "" ? "" : ` context=${link.context}`}]--> ${link.target.label}`;
  const crossFile = links.filter(
    (l) =>
      l.source.file !== l.target.file &&
      selectedSet.has(l.source.file) &&
      selectedSet.has(l.target.file),
  );
  const matchesTask = (n: BriefNode): boolean => {
    for (const t of n.tokens) if (taskTokens.has(t)) return true;
    return false;
  };
  // Module↔module edges first: the import skeleton BETWEEN the selected files is the relational answer ("what attaches to what"). Task-matched symbol edges next; everything else fills whatever budget remains.
  const isModule = (n: BriefNode): boolean =>
    n.label === (n.file.split("/").at(-1) ?? "");
  const edgePass = (link: BriefLink): number =>
    isModule(link.source) && isModule(link.target)
      ? 0
      : matchesTask(link.source) || matchesTask(link.target)
        ? 1
        : 2;
  for (const pass of [0, 1, 2]) {
    for (const link of crossFile) {
      if (edgePass(link) !== pass) continue;
      const key = `${link.source.id} ${link.relation} ${link.target.id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edgeLines.push(formatEdge(link));
    }
  }

  const header =
    `Graph locate: ${selected.length} files matched to the task ` +
    `(name/symbol match + import structure; strongest first)`;
  const nodeText = nodeLines.join("\n");
  const parts = [header, nodeText];
  let used = header.length + nodeText.length;
  const keptEdges: string[] = [];
  for (const line of edgeLines) {
    if (used + line.length + 1 > GRAPH_BRIEF_MAX_CHARS) break;
    keptEdges.push(line);
    used += line.length + 1;
  }
  if (keptEdges.length > 0) parts.push(keptEdges.join("\n"));
  parts.push(
    `[graph brief: ${selected.length} files, ${nodeLines.length} nodes, ${keptEdges.length}/${edgeLines.length} edges]`,
  );
  return parts.join("\n\n");
}

export interface GraphLocateResult {
  available: boolean;
  answer: string;
}

let locateCache: { key: string; graph: unknown } | null = null;

const LOCATE_NO_LEADS =
  "No strong leads: nothing in the graph's file or symbol names matches this " +
  "question's vocabulary. That is locate's known limit (it matches names, not " +
  "file contents) — search content with grep/rg instead, or re-ask using words " +
  "from the code's own naming.";

const LOCATE_VERIFY_FOOTER =
  "\n\nLeads, not authority: verify in source before building on any of this.";

/** Mid-task locate over the same mechanisms and output grammar as the spawn brief — exposed so the graph-first mandate stays true after spawn, not only at it. Reads the serving snapshot first (the file rebuilds never mutate; the live graph.json is rewritten in place by every post-landing rebuild) and degrades every failure — absent, oversized, corrupt — to an honest unavailable answer. Never throws, never blocks on a subprocess. */
export async function graphLocate(
  root: string,
  question: string,
  signal?: AbortSignal,
): Promise<GraphLocateResult> {
  signal?.throwIfAborted();
  const candidates = [servingGraphPath(root), graphJsonPath(root)];
  const path = candidates.find((p) => existsSync(p));
  if (path === undefined) {
    return {
      available: false,
      answer: "Graph not built yet; proceeding without it — use grep/rg/Glob.",
    };
  }
  let graph: unknown;
  try {
    const stats = await stat(path);
    signal?.throwIfAborted();
    if (stats.size > TARGETED_BRIEF_MAX_GRAPH_BYTES) {
      return {
        available: false,
        answer: "Graph too large for interactive locate; use grep/rg/Glob.",
      };
    }
    const key = `${path} ${stats.mtimeMs} ${stats.size}`;
    if (locateCache?.key === key) {
      graph = locateCache.graph;
    } else {
      graph = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
      signal?.throwIfAborted();
      locateCache = { key, graph };
    }
  } catch {
    signal?.throwIfAborted();
    return {
      available: false,
      answer: "Graph unreadable (corrupt or mid-write); use grep/rg/Glob.",
    };
  }
  signal?.throwIfAborted();
  const brief = buildTargetedGraphBrief(graph, question);
  if (brief === null) return { available: true, answer: LOCATE_NO_LEADS };
  return { available: true, answer: `${brief}${LOCATE_VERIFY_FOOTER}` };
}

/** Preserve edges and their cited endpoint nodes when reducing node-first query output. A head slice would discard every edge. */
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

  const summary =
    `[graph brief: kept ${keptNodes.length}/${nodeLines.length} nodes, ` +
    `${keptEdges.length}/${edgeLines.length} edges]`;
  return [header, keptNodes.join("\n"), keptEdges.join("\n"), summary]
    .filter((section) => section !== "")
    .join("\n\n");
}

const TARGETED_BRIEF_MAX_GRAPH_BYTES = 50 * 1024 * 1024;

/** The task-scoped spawn digest. Failures are explicit so absence cannot masquerade as an empty graph. Hive locates from explicit seed nodes because the binary query cannot accept them; its bounded query remains the oversized or matchless fallback. */
export async function buildGraphBrief(
  root: string,
  task: string,
  run: CommandRunner = runCommand,
): Promise<string> {
  if (!existsSync(graphifyBin()) || !existsSync(graphJsonPath(root))) {
    return "Graph context: unavailable (graph not built yet); proceeding without it.";
  }
  try {
    const stats = await stat(graphJsonPath(root));
    if (stats.size <= TARGETED_BRIEF_MAX_GRAPH_BYTES) {
      const graph: unknown = JSON.parse(
        await readFile(graphJsonPath(root), "utf8"),
      );
      const targeted = buildTargetedGraphBrief(graph, task);
      if (targeted !== null) return `${GRAPH_BRIEF_PREAMBLE}\n\n${targeted}`;
    }
  } catch {}
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
    {
      cwd: root,
      env: scrubbedGraphifyEnv(),
      timeoutMs: GRAPH_BRIEF_TIMEOUT_MS,
    },
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

export function servingGraphPath(root: string): string {
  return join(projectStateDir(root), "graphify-serving", "graph.json");
}

/** Refresh the serving snapshot from the freshly built graph. The copy lands via tmp+rename so even the snapshot itself is never half-written. */
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
      reason: `could not snapshot graph for serving: ${errorMessage(error)}`,
    };
  }
  try {
    await copyFile(
      join(graphOutDir(root), ".graphify_learning.json"),
      join(dirname(target), ".graphify_learning.json"),
    );
  } catch {}
  return { ok: true, detail: target };
}

/** First line of a Hive-generated `.graphifyignore`. A file without it is the user's own and is never rewritten or removed. */
export const GRAPHIFY_IGNORE_MARKER =
  "# Generated by Hive from this repo's own gitignore rules.";

/** Vendored-dependency dirs that are commonly *committed*, so no gitignore rule ever names them. Everything gitignored is handled by the derived section instead — this floor is deliberately short, because a hand-kept ecosystem list is always one ecosystem behind. */
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

/** Keep the pattern list bounded: extraction evaluates every pattern against every file, and a monorepo can gitignore thousands of directories. */
const GITIGNORED_DIR_CAP = 400;

/** Materialize nested Git ignore rules at the scan root because graphify reads only root-level rules. Never replace a user-owned `.graphifyignore`; silent over-exclusion is worse than retaining extra nodes. */
export async function writeGraphifyIgnore(
  root: string,
  run: CommandRunner = runCommand,
): Promise<GraphifyOutcome> {
  const path = join(root, ".graphifyignore");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {}
  if (existing !== null && !existing.startsWith(GRAPHIFY_IGNORE_MARKER)) {
    return {
      ok: true,
      detail: ".graphifyignore is user-authored; left untouched",
    };
  }

  const ignored = await run(
    [
      "git",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { cwd: root, timeoutMs: 30_000 },
  );
  const derived =
    ignored.exitCode !== 0
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
      ? [
          `# (+${derived.length - capped.length} more git-ignored directories omitted)`,
        ]
      : []),
    "",
  ];
  // Never let ignore hygiene block a build: an unwritable root degrades to extraction without exclusions, reported through the build detail.
  try {
    // Staged inside graphify-out/ rather than beside the file it replaces:
    // `.graphifyignore.<pid>.tmp` at the scan root is an untracked path to
    // anything reading `git status`, because the root gitignore names
    // `.graphifyignore` exactly and does not cover a suffixed name. Same
    // filesystem either way, so the rename is still the atomic swap.
    const staging = graphOutDir(root);
    await mkdir(staging, { recursive: true });
    const temporary = join(staging, `.graphifyignore.${process.pid}.tmp`);
    await writeFile(temporary, lines.join("\n"));
    await rename(temporary, path);
  } catch (error) {
    return {
      ok: false,
      reason: `could not write .graphifyignore: ${errorMessage(error)}`,
    };
  }
  return {
    ok: true,
    detail:
      `excluding ${VENDORED_DIR_FLOOR.length} common vendored patterns` +
      `${capped.length > 0 ? ` and ${capped.length} git-ignored dirs (${capped.slice(0, 5).join(" ")}${capped.length > 5 ? " …" : ""})` : ""}`,
  };
}
