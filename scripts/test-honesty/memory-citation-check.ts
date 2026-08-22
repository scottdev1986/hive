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
