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
  test("reads context% from the newest transcript's last main-conversation usage", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    // An older transcript that must lose to the newer one.
    writeFileSync(
      join(directory, "old-session.jsonl"),
      transcriptLine({ input_tokens: 10, cache_read_input_tokens: 190_000 }) + "\n",
    );
    utimesSync(join(directory, "old-session.jsonl"), new Date("2026-07-09T00:00:00Z"), new Date("2026-07-09T00:00:00Z"));
    const lines = [
      transcriptLine({
        input_tokens: 8,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 1_000,
        output_tokens: 500,
      }),
      // The last usage wins; a later sidechain entry must not override it.
      transcriptLine({
        input_tokens: 8,
        cache_read_input_tokens: 79_000,
        cache_creation_input_tokens: 1_121,
        output_tokens: 753,
      }),
      transcriptLine({ input_tokens: 4, cache_read_input_tokens: 2_000 }, true),
      JSON.stringify({ type: "system", message: null }),
    ];
    writeFileSync(join(directory, "new-session.jsonl"), lines.join("\n") + "\n");

    const telemetry = await readClaudeTelemetry(WORKTREE, home);
    // (8 + 79000 + 1121 + 753) / 200_000 ≈ 40.4 → 40
    expect(telemetry.contextPct).toEqual(40);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  test("reports nulls when no project directory or usage exists", async () => {
    const home = makeHome();
    expect(await readClaudeTelemetry(WORKTREE, home)).toEqual({
      contextPct: null,
      lastActivityAt: null,
    });
    const directory = claudeProjectDir(home);
    writeFileSync(join(directory, "empty.jsonl"), '{"type":"summary"}\n');
    const telemetry = await readClaudeTelemetry(WORKTREE, home);
    expect(telemetry.contextPct).toEqual(null);
    expect(telemetry.lastActivityAt).not.toEqual(null);
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
