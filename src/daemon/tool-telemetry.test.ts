import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readClaudeTelemetry, readCodexTelemetry } from "./tool-telemetry";

const WORKTREE = "/repo/.hive/worktrees/maya";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "hive-telemetry-"));
}

function claudeProjectDir(home: string): string {
  const munged = resolve(WORKTREE).replace(/[^A-Za-z0-9]/g, "-");
  const directory = join(home, ".claude", "projects", munged);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function transcriptLine(usage: Record<string, unknown>, sidechain = false): string {
  return JSON.stringify({
    type: "assistant",
    ...(sidechain ? { isSidechain: true } : {}),
    message: { role: "assistant", usage },
  });
}

describe("claude transcript telemetry", () => {
  // The transcript cannot answer this and must not pretend to. It records how
  // many tokens a turn used but never the window they fill, and the model id
  // cannot supply it either -- the 1M upgrade rides on the account plan, so
  // `claude-opus-4-8` is 200k on one plan and 1M on another with an identical
  // string. Dividing by a hardcoded 200_000 is what reported live agents at
  // ~22% of a 1M window as 100% full. Occupancy is measured by Claude Code and
  // arrives via POST /statusline; here it is honestly unknown.
  test("never guesses occupancy: a transcript alone yields unknown, not a number", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "session.jsonl"),
      [
        transcriptLine({ input_tokens: 8, cache_read_input_tokens: 30_000 }),
        // Enough tokens to have read 100% against the old hardcoded 200k
        // window, and ~22% against the 1M window the account actually has.
        transcriptLine({
          input_tokens: 8,
          cache_read_input_tokens: 220_000,
          cache_creation_input_tokens: 1_121,
          output_tokens: 753,
        }),
      ].join("\n") + "\n",
    );

    const telemetry = await readClaudeTelemetry(WORKTREE, home);
    expect(telemetry.contextPct).toEqual(null);
    // Liveness is the transcript's remaining job, and it still works.
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  test("reports the newest transcript's mtime as the activity signal", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "old-session.jsonl"),
      transcriptLine({ input_tokens: 10 }) + "\n",
    );
    utimesSync(
      join(directory, "old-session.jsonl"),
      new Date("2026-07-09T00:00:00Z"),
      new Date("2026-07-09T00:00:00Z"),
    );
    writeFileSync(
      join(directory, "new-session.jsonl"),
      transcriptLine({ input_tokens: 8, cache_read_input_tokens: 79_000 }) + "\n",
    );

    const telemetry = await readClaudeTelemetry(WORKTREE, home);
    expect(telemetry.lastActivityAt).not.toEqual(null);
    // The newer transcript wins, so the signal is not the 2026-07-09 one.
    expect(telemetry.lastActivityAt?.startsWith("2026-07-09")).toEqual(false);
  });

  test("reports nulls when no project directory or transcript exists", async () => {
    const home = makeHome();
    expect(await readClaudeTelemetry(WORKTREE, home)).toEqual({
      contextPct: null,
      lastActivityAt: null,
    });
  });
});


describe("codex rollout telemetry", () => {
  function writeRollout(home: string, lines: string[]): string {
    const directory = join(home, ".codex", "sessions", "2026", "07", "10");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "rollout-2026-07-10T10-00-00-abc.jsonl");
    const meta = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", cwd: resolve(WORKTREE) },
    });
    writeFileSync(path, [meta, ...lines].join("\n") + "\n");
    return path;
  }

  function tokenCount(
    inputTokens: number,
    outputTokens: number,
    window: number,
  ): string {
    return JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 999_999,
            output_tokens: 999_999,
          },
          last_token_usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          model_context_window: window,
        },
      },
    });
  }

  test("reads context% from the last token_count against the recorded window", async () => {
    const home = makeHome();
    writeRollout(home, [
      tokenCount(10_000, 100, 258_400),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      tokenCount(129_200, 0, 258_400),
    ]);
    const telemetry = await readCodexTelemetry(WORKTREE, home);
    expect(telemetry.contextPct).toEqual(50);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  test("reports nulls without a matching rollout and tolerates missing usage", async () => {
    const home = makeHome();
    expect(await readCodexTelemetry(WORKTREE, home)).toEqual({
      contextPct: null,
      lastActivityAt: null,
    });
    writeRollout(home, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ]);
    const telemetry = await readCodexTelemetry(WORKTREE, home);
    expect(telemetry.contextPct).toEqual(null);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });
});
