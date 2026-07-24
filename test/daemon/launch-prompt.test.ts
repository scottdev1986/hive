import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexInstructionProfilePath,
  wrapCodexWithInstructionProfile,
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
