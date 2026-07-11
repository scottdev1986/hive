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
  // The measured numerator: the last non-sidechain assistant turn's usage sum
  // is the context resident right now, byte-identical to what Claude Code's
  // own `context_window.current_usage` reports. No percentage appears here --
  // the transcript records tokens but never the window they fill, so the
  // division happens in the sweep against the statusline-observed window.
  test("sums the last assistant turn's usage into contextTokens", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "session-1.jsonl"),
      [
        transcriptLine({ input_tokens: 8, cache_read_input_tokens: 30_000 }),
        transcriptLine({
          input_tokens: 8,
          cache_read_input_tokens: 220_000,
          cache_creation_input_tokens: 1_121,
          output_tokens: 753,
        }),
      ].join("\n") + "\n",
    );

    const telemetry = await readClaudeTelemetry(WORKTREE, "session-1", home);
    expect(telemetry.contextTokens).toEqual(8 + 220_000 + 1_121 + 753);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  // A subagent's turns are interleaved into the same file but describe a
  // different conversation's context; counting one would swing the reading to
  // whatever the sidechain happened to carry.
  test("skips sidechain turns and turns without usage", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "session-1.jsonl"),
      [
        transcriptLine({ input_tokens: 5, cache_read_input_tokens: 90_000 }),
        JSON.stringify({ type: "user", message: { role: "user" } }),
        transcriptLine({ input_tokens: 2, output_tokens: 9 }, true),
      ].join("\n") + "\n",
    );

    const telemetry = await readClaudeTelemetry(WORKTREE, "session-1", home);
    expect(telemetry.contextTokens).toEqual(90_005);
  });

  // Worktrees are reused across respawns, so the project directory holds every
  // dead predecessor's transcript. The read is keyed to the agent's own
  // session id: a fresh agent that has not spoken yet must read unknown, never
  // its predecessor's number.
  test("reads only the agent's own session, never a neighbouring transcript", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "dead-predecessor.jsonl"),
      transcriptLine({ input_tokens: 8, cache_read_input_tokens: 400_000 }) +
        "\n",
    );

    const fresh = await readClaudeTelemetry(WORKTREE, "fresh-session", home);
    expect(fresh).toEqual({ contextTokens: null, lastActivityAt: null });

    // And the reverse join: asked for the predecessor by id, it reads it.
    const dead = await readClaudeTelemetry(
      WORKTREE,
      "dead-predecessor",
      home,
    );
    expect(dead.contextTokens).toEqual(400_008);
  });

  test("reports the keyed transcript's mtime as the activity signal", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    writeFileSync(
      join(directory, "session-1.jsonl"),
      transcriptLine({ input_tokens: 10 }) + "\n",
    );
    utimesSync(
      join(directory, "session-1.jsonl"),
      new Date("2026-07-09T00:00:00Z"),
      new Date("2026-07-09T00:00:00Z"),
    );

    const telemetry = await readClaudeTelemetry(WORKTREE, "session-1", home);
    expect(telemetry.lastActivityAt).toEqual("2026-07-09T00:00:00.000Z");
  });

  test("reports nulls when there is no session id or no transcript", async () => {
    const home = makeHome();
    expect(await readClaudeTelemetry(WORKTREE, undefined, home)).toEqual({
      contextTokens: null,
      lastActivityAt: null,
    });
    expect(await readClaudeTelemetry(WORKTREE, "session-1", home)).toEqual({
      contextTokens: null,
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
