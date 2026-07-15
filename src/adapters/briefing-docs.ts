// Generic, repo-neutral discovery of the markdown a scoped brief can point an
// agent at, and which doc is the repo's primary. This is not profiling: it reads
// no commands, conventions, or fingerprints and caches nothing. It answers two
// questions from the tree on demand — "which markdown here is worth briefing an
// agent on?" and "which doc is central?" — and is the surviving piece of the
// removed repo profiler, kept because scoped briefs depend on it.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Git helper — cheap, best-effort. A directory that is not a Git checkout
 * discovers docs fine; it simply falls back to a directory read. */
function git(root: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

// Directories a design/onboarding doc conventionally lives in. Scanned for
// `.md` files; only those that exist and hold docs become briefable directories.
const DOC_DIRECTORIES = [
  "docs/",
  "doc/",
  "research/",
  "rfcs/",
  "rfc/",
  "design/",
  ".github/",
] as const;

// Root-level docs worth briefing even though they are not in a doc directory.
// A design doc can be named anything (DESIGN.md, ARCHITECTURE.md, SPEC.md); we
// collect every root `.md` and let inbound-link ranking find the primary.
async function listRootMarkdown(root: string): Promise<string[]> {
  const out = git(root, ["ls-files", "*.md"]);
  if (out !== null) {
    // Root-level only: a nested path contains a slash. `git ls-files` already
    // omits ignored files, so `.hive/` runtime state never appears here.
    return out.split("\n").filter((f) => f.length > 0 && !f.includes("/"));
  }
  // Non-git repo: fall back to a directory read of the root.
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Walk depth and file caps. Doc discovery sits on the spawn path, so a
// pathological directory must not be able to hang a spawn.
const DOC_WALK_MAX_DEPTH = 8;
const DOC_WALK_MAX_FILES = 500;

/** The `.md` files under one doc directory, read from disk rather than from
 * `git ls-files`: a doc is briefable because it is *there*, not because it is
 * tracked. `docs/` may be gitignored local working state and still be exactly
 * what an agent needs briefing on.
 *
 * The walk is scoped to `<root>/<dir>` and recurses only within it. That scope
 * is load-bearing: it is why dropping `ls-files`' ignore-filtering costs
 * nothing. A walk from the repo root would descend into `node_modules/`,
 * `dist/`, and — worst — `.hive/worktrees/<agent>/`, which holds a full
 * checkout of the repo, its own `docs/` included, and would duplicate the
 * corpus once per live agent. Keep it scoped. */
async function listMarkdownUnder(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > DOC_WALK_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return; // Absent or unreadable: no docs, which is not an error.
    }
    for (const entry of entries) {
      if (found.length >= DOC_WALK_MAX_FILES) return;
      // Symlinks are skipped outright rather than resolved: a doc directory has
      // no business leaving the repo, and following one could.
      if (entry.isSymbolicLink()) continue;
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) await walk(`${path}/`, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
    }
  };

  await walk(dir, 1);
  return found.sort();
}

/** The briefable allowlist by path: every root `.md` plus every `.md` under a
 * doc directory that holds one. `rootDocs` is kept separate because primary-doc
 * ranking considers only root docs as candidates. */
async function inventoryDocPaths(root: string): Promise<{
  rootDocs: string[];
  briefable: string[];
  briefableDirectories: string[];
}> {
  const rootDocs = await listRootMarkdown(root);
  const briefableDirectories: string[] = [];
  const dirDocs: string[] = [];
  for (const dir of DOC_DIRECTORIES) {
    const docs = await listMarkdownUnder(root, dir);
    if (docs.length > 0) {
      briefableDirectories.push(dir);
      dirDocs.push(...docs);
    }
  }
  const briefable = [...new Set([...rootDocs, ...dirDocs])].sort();
  return { rootDocs, briefable, briefableDirectories };
}

/** Markdown link targets, without anchors or queries. Bare filename mentions
 * do not vote in primary-document ranking. */
function citedPaths(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(\s*<?([^)<>\s]+)/g)) {
    targets.push(match[1]!);
  }
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s<>]+)/gm)) {
    targets.push(match[1]!);
  }
  return targets
    .map((target) => target.split("#")[0]!.split("?")[0]!)
    .filter((target) => target.length > 0);
}

/** Rank by inbound Markdown links with a small design-role boost. Returns null
 * when the corpus has neither citations nor a design-role document. */
export function rankPrimaryDoc(
  docs: string[],
  corpus: Array<{ path: string; text: string }>,
): string | null {
  if (docs.length === 0) return null;
  const basename = (p: string): string => p.split("/").pop() ?? p;
  const citations = corpus.map((file) => ({
    path: file.path,
    // Cited by basename, so a relative prefix (`../SPEC.md`, `./SPEC.md`) still
    // resolves to the doc it names.
    targets: citedPaths(file.text).map(basename),
  }));
  const score = new Map<string, number>();
  for (const doc of docs) {
    const name = basename(doc);
    let inbound = 0;
    for (const file of citations) {
      if (file.path === doc) continue;
      inbound += file.targets.filter((target) => target === name).length;
    }
    // Role boost: a design/architecture doc is a natural primary even in a young
    // repo where little cites it yet.
    const roleBoost = /^(spec|design|architecture|readme)\b/i.test(name) ? 1 : 0;
    score.set(doc, inbound + roleBoost);
  }
  const ranked = [...docs].sort((a, b) => (score.get(b)! - score.get(a)!));
  const best = ranked[0]!;
  return (score.get(best) ?? 0) > 0 ? best : null;
}

export interface BriefableDocs {
  /** Every briefable `.md`: root docs plus everything under a doc directory. */
  briefable: string[];
  /** The doc directories that actually held `.md` files. */
  briefableDirectories: string[];
  /** The primary design doc (basename-addressable), or null. */
  primary: string | null;
}

/** Discover the briefable docs and primary design doc for `root`, walked from
 * the tree on demand. Rank primarily against the root docs (a repo's primary
 * design doc lives at the root); read their text plus the directory docs to
 * count inbound links. */
export async function discoverBriefableDocs(root: string): Promise<BriefableDocs> {
  const { rootDocs, briefable, briefableDirectories } = await inventoryDocPaths(root);

  const corpus: Array<{ path: string; text: string }> = [];
  for (const path of briefable) {
    try {
      corpus.push({ path, text: await readFile(join(root, path), "utf8") });
    } catch {
      // A listed doc that cannot be read simply contributes no links.
    }
  }
  const primary = rankPrimaryDoc(rootDocs, corpus);
  return { briefable, briefableDirectories, primary };
}
