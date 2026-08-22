#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "bunx",
  [
    "oxlint",
    "src",
    "test",
    "scripts",
    "native",
    "qa",
    "--deny-warnings",
    "--format",
    "unix",
  ],
  {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const counts = new Map<string, number>();
let parsed = 0;

for (const line of output.split("\n")) {
  const open = line.lastIndexOf("[");
  const close = line.lastIndexOf("]");
  if (open < 0 || close < open) continue;
  const tag = line.slice(open + 1, close);
  const rule = tag.includes("/") ? tag.slice(tag.indexOf("/") + 1) : tag;
  if (rule.length === 0) continue;
  parsed += 1;
  counts.set(rule, (counts.get(rule) ?? 0) + 1);
}

const ranked = [...counts.entries()].sort(
  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
);
const total = ranked.reduce((sum, [, n]) => sum + n, 0);

console.log(`parsed\t${parsed}`);
console.log(`total\t${total}`);
console.log(`exit\t${result.status ?? 1}`);
for (const [rule, n] of ranked) {
  console.log(`${n}\t${rule}`);
}

process.exit(result.status === 0 && total === 0 ? 0 : 1);
