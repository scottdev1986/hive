import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexInstructionProfilePath,
  wrapCodexWithInstructionProfile,
  wrapGrokWithRulesFile,
  writeCodexInstructionProfile,
  writeLaunchPrompt,
} from "../../src/daemon/launch-prompt";

let root = "";
let previousHiveHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hive-instructions-"));
  previousHiveHome = process.env.HIVE_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.HIVE_HOME = join(root, "hive");
  process.env.CODEX_HOME = join(root, "codex");
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(root, { recursive: true, force: true });
});

test("instruction files are forced to owner-only permissions", async () => {
  const path = await writeLaunchPrompt("hive-maya", "secret instructions");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).toBe("secret instructions");
});

test("Grok's launch leaves the bootstrap shell alive so the pane survives its exit", async () => {
  const rules = join(root, "rules.txt");
  await writeFile(rules, "be helpful");
  const command = wrapGrokWithRulesFile("'/bin/echo' 'grok-ran'", rules);

  // The property under test is behavioural, not textual: after the provider
  // exits, control must return to the bootstrap shell. `exec` would replace
  // that shell, and the line standing in for `exec /bin/zsh -l -i` would never
  // run — which is exactly how a short-lived Grok took its whole pane down.
  const script = [
    `hive_terminal_command=${JSON.stringify(command)}`,
    'eval "$hive_terminal_command"',
    "print -r -- FALLBACK_REACHED",
  ].join("\n");
  const child = Bun.spawn(["/bin/zsh", "-c", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();

  expect(output).toContain("grok-ran");
  expect(output).toContain("FALLBACK_REACHED");
});

test("Codex receives developer instructions through an ephemeral profile", async () => {
  const session = "hive-maya";
  await writeCodexInstructionProfile(session, "secret instructions");
  const profile = codexInstructionProfilePath(session);
  const command = wrapCodexWithInstructionProfile(
    `grep -q 'developer_instructions' '${profile}'`,
    session,
  );
  const child = Bun.spawn(["sh", "-lc", command], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(existsSync(profile)).toBe(false);
});
