// memory-citation-check.ts Verify that memory articles' code citations still point at real code. Compiled wiki articles cite evidence as repo paths with line ranges (src/hive-home/home.ts:5-7), and when a file moves or shrinks nothing fires — the article keeps its delivered authority while its evidence quietly rots. This check walks the compiled wiki of one memory scope (raw/ is immutable history and exempt), extracts every path:line citation, and asserts the two facts that are mechanically decidable: the cited file exists, and the cited line range falls inside it.
//
// WHAT A GREEN RUN DOES NOT PROVE — read before trusting one:
// - It cannot catch a citation that is in range but describes the WRONG code: a function moved, and its old lines still exist saying something else. That was the most dangerous class in the 2026-08 corpus audit (a live file, a valid range, the wrong content), and no line-number check can see it. Green means "points at real lines", never "points at the right thing".
// - It only checks citations that carry line numbers. A bare path mention (a docs directory, a deleted file named in prose) is as often deliberate history as a live reference, and the two are not mechanically separable, so bare paths are not checked. Cite live code with line numbers; write dead-path history as prose, because a historical citation kept in path:line form WILL be flagged.
// - It sees nothing wrong when citations have been REMOVED rather than broken. The memory consolidator's merge overwrites an article's evidence frontmatter with boilerplate; afterwards there is no path left to validate, and this check passes an article whose evidence is silently gone. That is also an ordering constraint: consolidation must run before citation repair and before this check, never after, because the overwrite is invisible to it.
// - A green run proves citations against the tree this check ran in, nothing else. Run it against the tree the articles describe (current main): green against a stale checkout is a label, not a mechanism.
// - Only the first range of a compact multi-range citation (file.ts:5-7,22-27) is checked; write one range per path mention.
//
// Usage: bun run scripts/test-honesty/memory-citation-check.ts [memoryRoot] [repoRoot]
// Defaults: memoryRoot <repo>/.hive/memory, repoRoot two levels above this script. Exit 0 when every citation resolves, 1 when at least one is dead.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.argv[3] ?? join(import.meta.dir, "../.."));
const memoryRoot = resolve(process.argv[2] ?? join(repoRoot, ".hive/memory"));
const wikiRoot = join(memoryRoot, "wiki");

interface DeadCitation {
  readonly article: string;
  readonly citation: string;
  readonly reason: string;
}

function* wikiFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* wikiFiles(path);
    else if (entry.name.endsWith(".md")) yield path;
  }
}

// A citation is a path-like token immediately followed by :N or :N-M. The
// token must contain a slash (a repo-relative path) or name a file at the
// repository root (Makefile) — anything shorter is prose: 14:27Z,
// 127.0.0.1:63104, `updated: 2026-08-12` all carry colons and digits without
// citing code.
const CITATION = /([A-Za-z0-9_][A-Za-z0-9_./-]*):(\d+)(?:-(\d+))?/g;

function lineCount(path: string): number {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const dead: DeadCitation[] = [];
let checked = 0;

for (const article of wikiFiles(wikiRoot)) {
  const text = readFileSync(article, "utf8");
  for (const match of text.matchAll(CITATION)) {
    const [citation, citedPath, startText, endText] = match;
    if (citedPath === undefined) continue;
    // A match can be the tail of a longer path the pattern's first character
    // class excluded: ../../raw/x.md:3 or /Users/scott/file.ts:10. Those are
    // article-relative or absolute, never repo-relative, so skip them.
    const before = match.index > 0 ? text[match.index - 1] : "";
    if (before === "." || before === "/") continue;
    const target = join(repoRoot, citedPath);
    if (!citedPath.includes("/") && !existsSync(target)) continue;
    checked++;
    if (!existsSync(target)) {
      dead.push({ article, citation, reason: "cited file does not exist" });
      continue;
    }
    if (statSync(target).isDirectory()) {
      dead.push({
        article,
        citation,
        reason: "cited path is a directory, not a file",
      });
      continue;
    }
    const start = Number(startText);
    const end = Number(endText ?? startText);
    const lines = lineCount(target);
    if (start < 1 || end > lines) {
      dead.push({
        article,
        citation,
        reason: `line range ${start}-${end} is outside the file's ${lines} lines`,
      });
    }
  }
}

if (dead.length > 0) {
  console.error(
    `memory citation check: ${dead.length} dead citation(s) under ${wikiRoot}`,
  );
  for (const d of dead) {
    console.error(`  ${d.article}: ${d.citation} — ${d.reason}`);
  }
  process.exit(1);
}
console.log(
  `memory citation check: ${checked} citation(s) verified under ${wikiRoot}`,
);
