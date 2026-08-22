#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { Glob } from "bun";

type Verdict =
  | "asserts"
  | "no-assertion"
  | "did-not-throw-only"
  | "mock-only"
  | "tautology-only";

interface Case {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly verdict: Verdict;
}

/**
 * Marks every character of `source` that is real code rather than the inside
 * of a string, template literal or comment. Brace and paren counting is done
 * against this mask so punctuation in prose never moves the cursor.
 */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") mode = "line";
      else if (c === "/" && next === "*") mode = "block";
      else if (c === "'" || c === '"' || c === "`") mode = c;
      else mask[i] = 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 1;
      }
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === mode) mode = "code";
  }
  return mask;
}

/** Index of the delimiter closing the one at `open`, or -1. */
function closerOf(
  source: string,
  mask: Uint8Array,
  open: number,
  close: string,
): number {
  const opener = source[open];
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (mask[i] === 0) continue;
    if (source[i] === opener) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `{` opening the callback body inside the call at `openParen`. */
function callbackBrace(
  source: string,
  mask: Uint8Array,
  openParen: number,
): number {
  const end = closerOf(source, mask, openParen, ")");
  if (end === -1) return -1;
  // The callback's parameter list may itself destructure with braces, so anchor
  // on the arrow (or the `function` keyword) rather than the first brace.
  for (let i = openParen; i < end - 1; i += 1) {
    if (mask[i] === 0) continue;
    const isArrow = source[i] === "=" && source[i + 1] === ">";
    const isFunction = source.startsWith("function", i) && mask[i + 7] === 1;
    if (!isArrow && !isFunction) continue;
    for (let j = i + 2; j <= end; j += 1) {
      if (mask[j] === 1 && source[j] === "{") return j;
      if (mask[j] === 1 && !/\s/.test(source.charAt(j)) && source[j] !== ")")
        break;
    }
  }
  return -1;
}

const ASSERTION =
  /\bexpect(?:\.\w+)?\s*\(|\bassert\w*\s*\(|\bexpectTypeOf\s*\(/;
// `expect(fn).not.toThrow()` and friends: the call completed, and nothing about
// what it produced was checked.
const DID_NOT_THROW = /\.(?:resolves|rejects)?\s*\.?not\s*\.\s*toThrow/;
// Assertions whose subject is the double, not the system: they re-state the
// stub the test itself wrote.
const MOCK_SUBJECT =
  /\bexpect\s*\(\s*[A-Za-z0-9_.[\]]*(?:[Mm]ock|[Ss]tub|[Ff]ake|[Ss]py|[Rr]ecorded|calls\b)/;
const MOCK_MATCHER = /\.toHaveBeenCalled(?:Times|With)?\s*\(/;
// expect(literal).toBe(literal) — true no matter what the product does.
const TAUTOLOGY =
  /\bexpect\s*\(\s*(?:true|false|\d+|"[^"]*"|'[^']*')\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(/;

// Most suites here assert through named helpers (expectPromotionError,
// assertRuleIsRetired, ...). Counting only literal `expect(` would call those
// tests assertion-free, so collect the helper names first and treat a call to
// one as the assertion it is.
const helperNames = new Set<string>();
function callsAssertingHelper(body: string): boolean {
  for (const m of body.matchAll(/\b(\w+)\s*\(/g)) {
    const name = m[1];
    if (name !== undefined && helperNames.has(name)) return true;
  }
  return false;
}

function classify(body: string): Verdict {
  const assertions = body.match(new RegExp(ASSERTION, "g")) ?? [];
  if (assertions.length === 0)
    return callsAssertingHelper(body) ? "asserts" : "no-assertion";
  const throwOnly = (body.match(new RegExp(DID_NOT_THROW, "g")) ?? []).length;
  if (throwOnly >= assertions.length) return "did-not-throw-only";
  const mockish =
    (body.match(new RegExp(MOCK_SUBJECT, "g")) ?? []).length +
    (body.match(new RegExp(MOCK_MATCHER, "g")) ?? []).length;
  if (mockish >= assertions.length) return "mock-only";
  const tautologies = (body.match(new RegExp(TAUTOLOGY, "g")) ?? []).length;
  if (tautologies >= assertions.length) return "tautology-only";
  return "asserts";
}

const files = [...new Glob("test/**/*.test.ts").scanSync(".")].sort();
const sources = new Map<string, { text: string; mask: Uint8Array }>();
for (const file of [...new Glob("test/**/*.ts").scanSync(".")].sort()) {
  const text = await Bun.file(file).text();
  sources.set(file, { text, mask: codeMask(text) });
}

// Three definition forms: `function f(`, `const f = (`, and the object-property
// `f: async (` that the table-driven suites use. Each match ends on the `(` of
// the parameter list so the body can be located from there.
const HELPER_DEF =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\(|(?:^|\n)\s*(\w+)\s*:\s*(?:async\s*)?\(/g;

/**
 * Body of a helper whose parameter list opens at `openParen`. A declaration
 * form (`function f(...) {`) takes the brace straight after the parameters; an
 * arrow form must show its `=>` first, which is what keeps an interface member
 * such as `f: (x: string) => Promise<void>;` from claiming an unrelated block
 * further down the file.
 */
function helperBrace(
  source: string,
  mask: Uint8Array,
  openParen: number,
  declaration: boolean,
): number {
  const end = closerOf(source, mask, openParen, ")");
  if (end === -1) return -1;
  let i = end + 1;
  if (declaration) {
    // Skip a return-type annotation: `function f(...): void {`.
    while (
      i < end + 200 &&
      i < source.length &&
      (mask[i] === 0 || source[i] !== "{")
    )
      i += 1;
    return mask[i] === 1 && source[i] === "{" ? i : -1;
  }
  while (
    i < source.length &&
    (mask[i] === 0 ||
      /[\s:)]/.test(source.charAt(i)) ||
      /[\w<>[\],|.]/.test(source.charAt(i)))
  ) {
    if (mask[i] === 1 && source[i] === "=" && source[i + 1] === ">") break;
    i += 1;
  }
  if (!(mask[i] === 1 && source[i] === "=" && source[i + 1] === ">")) return -1;
  i += 2;
  while (i < source.length && (mask[i] === 0 || /\s/.test(source.charAt(i))))
    i += 1;
  return mask[i] === 1 && source[i] === "{" ? i : -1;
}

// A helper counts as asserting if its own body asserts, or if it calls a helper
// already known to assert; repeat until the set stops growing.
for (let grew = true; grew;) {
  grew = false;
  for (const { text, mask } of sources.values()) {
    HELPER_DEF.lastIndex = 0;
    for (let m = HELPER_DEF.exec(text); m !== null; m = HELPER_DEF.exec(text)) {
      const name = m[1] ?? m[2] ?? m[3];
      if (!name || helperNames.has(name)) continue;
      const open = helperBrace(
        text,
        mask,
        m.index + m[0].length - 1,
        m[1] !== undefined,
      );
      if (open === -1) continue;
      const close = closerOf(text, mask, open, "}");
      const body = text.slice(open, close === -1 ? undefined : close);
      if (ASSERTION.test(body) || callsAssertingHelper(body)) {
        helperNames.add(name);
        grew = true;
      }
    }
  }
}
for (const reserved of ["test", "it", "describe"]) helperNames.delete(reserved);

const CASE_START =
  /(?:^|[\s;{}()])(?:test|it)(\.(?:only|skip|todo|each|failing|if|skipIf|todoIf))?\s*\(/g;
const TITLE =
  /^[\s(]*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/;

const cases: Case[] = [];
const unparsed: string[] = [];
for (const file of files) {
  const entry = sources.get(file);
  if (!entry) continue;
  const { text, mask } = entry;
  CASE_START.lastIndex = 0;
  for (let m = CASE_START.exec(text); m !== null; m = CASE_START.exec(text)) {
    let openParen = m.index + m[0].length - 1;
    if (mask[openParen] === 0) continue;
    // `test.each(rows)(title, fn)` puts the callback in the second call.
    if (m[1] === ".each") {
      const afterRows = closerOf(text, mask, openParen, ")");
      if (afterRows === -1) continue;
      const nextParen = text.indexOf("(", afterRows + 1);
      if (nextParen === -1) continue;
      openParen = nextParen;
    }
    const brace = callbackBrace(text, mask, openParen);
    if (brace === -1) {
      // test.todo and one-line arrow bodies have no block to inspect.
      if (m[1] !== ".todo")
        unparsed.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
      continue;
    }
    const close = closerOf(text, mask, brace, "}");
    const titleMatch = TITLE.exec(text.slice(openParen + 1));
    cases.push({
      file,
      line: text.slice(0, m.index).split("\n").length,
      title:
        titleMatch?.[1] ??
        titleMatch?.[2] ??
        titleMatch?.[3] ??
        "(dynamic title)",
      verdict: classify(text.slice(brace, close === -1 ? undefined : close)),
    });
    CASE_START.lastIndex = close === -1 ? brace : close;
  }
}

const weak = cases.filter((c) => c.verdict !== "asserts");
const byVerdict = new Map<Verdict, Case[]>();
for (const c of weak)
  byVerdict.set(c.verdict, [...(byVerdict.get(c.verdict) ?? []), c]);

console.log(`${cases.length} test cases in ${files.length} files`);
if (unparsed.length > 0)
  console.log(
    `${unparsed.length} call sites not parsed: ${unparsed.slice(0, 10).join(", ")}`,
  );
for (const [verdict, list] of [...byVerdict].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.log(`\n${verdict}: ${list.length}`);
  for (const c of list) console.log(`  ${c.file}:${c.line}  ${c.title}`);
}
console.log(
  `\nweak: ${weak.length} / ${cases.length} (${((weak.length / cases.length) * 100).toFixed(1)}%)`,
);

const jsonFlag = Bun.argv.indexOf("--json");
const jsonPath = jsonFlag === -1 ? undefined : Bun.argv[jsonFlag + 1];
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify({ total: cases.length, unparsed, weak }, null, 2),
  );
}
