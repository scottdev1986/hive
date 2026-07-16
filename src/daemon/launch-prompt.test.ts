import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCodexTuiShellCommand,
  codexUserPromptPath,
  readCodexDeveloperInstructions,
  writeCodexSessionBootstrap,
} from "./launch-prompt";

let root: string;
let previousHiveHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hive-codex-prompt-"));
  previousHiveHome = process.env.HIVE_HOME;
  const home = join(root, "home with 'apostrophe");
  await mkdir(home, { recursive: true });
  process.env.HIVE_HOME = home;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await rm(root, { recursive: true, force: true });
});

describe("Codex launch prompt transport", () => {
  test("stores separate 0600 artifacts and one valid TOML key=value override", async () => {
    const developerInstructions = [
      'role with quotes: "Hive"',
      "backslash \\ and unicode 🐝",
      "literal hostile data: '$HOME' `id` $(touch /tmp/must-not-run)",
      "x".repeat(64 * 1024),
    ].join("\n");
    const artifacts = await writeCodexSessionBootstrap("hive-maya", {
      developerInstructions,
      initialUserPrompt: "Implement the assignment.\nDo not expand $HOME or $(id).",
    });

    expect(await readCodexDeveloperInstructions(artifacts.developerPath))
      .toEqual(developerInstructions);
    const override = await readFile(artifacts.developerPath, "utf8");
    expect(Object.keys(Bun.TOML.parse(override))).toEqual([
      "developer_instructions",
    ]);
    expect((await stat(artifacts.developerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(artifacts.userPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(artifacts.developerPath))).mode & 0o777)
      .toBe(0o700);
  });

  test("keeps 64 KiB hostile payloads out of the shell and preserves each as one argument", async () => {
    const developerInstructions = `${"d".repeat(64 * 1024)}\n'$HOME' \`id\` $(id)`;
    const userPrompt = "assignment with spaces, 'apostrophe', $HOME, `id`, and $(id)";
    const artifacts = await writeCodexSessionBootstrap("hive-maya", {
      developerInstructions,
      initialUserPrompt: userPrompt,
    });
    const command = buildCodexTuiShellCommand(
      ["codex", "--sandbox", "read-only"],
      artifacts,
    );
    expect(command.length).toBeLessThan(1_000);
    expect(command).not.toContain("d".repeat(1_000));
    expect(command).not.toContain(userPrompt);
    expect(command.indexOf(" -c ")).toBeLessThan(command.indexOf(".user.txt"));

    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "codex"),
      "#!/bin/sh\nprintf '%s\\0' \"$@\"\n",
      { mode: 0o755 },
    );
    const child = Bun.spawn(["sh", "-c", command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
      .toString("utf8").split("\0").filter(Boolean);
    expect(await child.exited).toBe(0);
    expect(output).toEqual([
      "--sandbox",
      "read-only",
      "-c",
      `developer_instructions=${JSON.stringify(developerInstructions)}`,
      userPrompt,
    ]);
  });

  test("repairs artifact modes and removes a stale user prompt for a promptless generation", async () => {
    const staleUser = codexUserPromptPath("hive-maya");
    await mkdir(dirname(staleUser), { recursive: true });
    await writeFile(staleUser, "stale visible prompt", { mode: 0o644 });
    await chmod(dirname(staleUser), 0o755);

    const artifacts = await writeCodexSessionBootstrap("hive-maya", {
      developerInstructions: "fresh root rules",
    });

    expect(artifacts.userPath).toBeUndefined();
    expect(await Bun.file(staleUser).exists()).toBeFalse();
    expect((await stat(artifacts.developerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(artifacts.developerPath))).mode & 0o777)
      .toBe(0o700);
  });
});
