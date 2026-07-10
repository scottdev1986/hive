#!/usr/bin/env bun
/**
 * `bun run src/release/plan-cli.ts` — decide the next version from git state.
 *
 * CI calls exactly this. The bump rule therefore lives in `plan.ts`, under the
 * tests in `plan.test.ts`, and never in a shell fragment inside a YAML file
 * where nothing can test it. That is the whole reason this file exists: it is a
 * five-line adapter from `git` to a pure function.
 *
 * Writes `version`, `tag`, and `action` to `$GITHUB_OUTPUT` when present, and
 * always prints the plan as JSON.
 */
import { appendFileSync } from "node:fs";
import { planRelease } from "./plan";

const git = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  // `git tag --points-at` exits 0 with no output when nothing points at HEAD.
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return stdout;
};

const lines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

const commit = process.argv[2] ?? "HEAD";
const plan = planRelease({
  tags: lines(await git(["tag", "--list"])),
  headTags: lines(await git(["tag", "--points-at", commit])),
});

console.log(JSON.stringify(plan, null, 2));

const output = process.env.GITHUB_OUTPUT;
if (output !== undefined && output.length > 0) {
  appendFileSync(
    output,
    `action=${plan.action}\nversion=${plan.version}\ntag=${plan.tag}\n`,
  );
}
