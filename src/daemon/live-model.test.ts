import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAssistantModel, readLiveClaudeModel } from "./live-model";
import { claudeProjectDirectory } from "../adapters/tools/claude";

const turn = (type: string, model?: string): string =>
  JSON.stringify(
    model === undefined
      ? { type, message: { role: type } }
      : { type, message: { role: type, model } },
  );

describe("lastAssistantModel", () => {
  test("a session that switched models mid-run reports the model it switched TO", () => {
    // This is the whole bug, in one file: zoe's transcript holds 9 turns of
    // claude-fable-5 and 347 of claude-opus-4-8, because the user typed /model.
    // Only the last one is true now, so we scan backwards.
    const tail = [
      turn("assistant", "claude-fable-5"),
      turn("user"),
      turn("assistant", "claude-opus-4-8"),
      turn("user"),
    ].join("\n");
    expect(lastAssistantModel(tail)).toBe("claude-opus-4-8");
  });

  test("a tail that begins mid-line survives it", () => {
    // We read the last 64KB of a possibly-huge file, so the first line is
    // routinely a fragment. It must be skipped, not throw.
    const tail = `{"type":"assist` + "\n" + turn("assistant", "claude-opus-4-8");
    expect(lastAssistantModel(tail)).toBe("claude-opus-4-8");
  });

  test("no assistant turn yet is null, never a guess", () => {
    expect(lastAssistantModel(turn("user"))).toBeNull();
    expect(lastAssistantModel("")).toBeNull();
  });
});

describe("readLiveClaudeModel", () => {
  test("reads the running model out of the newest transcript", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-"));
    const worktree = await mkdtemp(join(tmpdir(), "hive-wt-"));
    try {
      const directory = claudeProjectDirectory(worktree, home);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "session.jsonl"),
        [turn("assistant", "claude-fable-5"), turn("assistant", "claude-opus-4-8")]
          .join("\n"),
      );
      expect(await readLiveClaudeModel(worktree, home)).toBe("claude-opus-4-8");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("an agent with no transcript yields null — the stored model then stands", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-"));
    const worktree = await mkdtemp(join(tmpdir(), "hive-wt-"));
    try {
      // Null is not "assume the spawn-time value was right"; it is "there is no
      // observation", which is what lets the caller leave the row alone instead
      // of overwriting a real intention with a fabrication.
      expect(await readLiveClaudeModel(worktree, home)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
