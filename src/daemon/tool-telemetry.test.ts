import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  countGraphifyCallLines,
  readClaudeTelemetry,
  readCodexTelemetry,
  readGraphifyCalls,
  readGrokTelemetry,
} from "./tool-telemetry";

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
    const telemetry = await readCodexTelemetry(WORKTREE, "thread-1", home);
    expect(telemetry.contextPct).toEqual(50);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  test("reports nulls without a matching rollout and tolerates missing usage", async () => {
    const home = makeHome();
    expect(await readCodexTelemetry(WORKTREE, "thread-1", home)).toEqual({
      contextPct: null,
      lastActivityAt: null,
    });
    writeRollout(home, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ]);
    const telemetry = await readCodexTelemetry(WORKTREE, "thread-1", home);
    expect(telemetry.contextPct).toEqual(null);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });
});

// Every record below is verbatim from a real Grok session (agent bridget,
// session 019f5832-6c1a-7920-83f4-fb6cfc639fe2): the 16 tool_call records it
// wrote and its terminal turn_completed. Its truth is known independently —
// 6 graphify calls, contextWindowUsage 6, stop_reason end_turn — so these
// tests measure the vendor's real shape rather than a shape we assumed. If the
// vendor changes it, they fail, which is the entire point.
const GROK_UPDATES = readFileSync(
  join(import.meta.dir, "__fixtures__", "grok-updates-bridget.jsonl"),
  "utf8",
);
const GROK_SIGNALS = readFileSync(
  join(import.meta.dir, "__fixtures__", "grok-signals-bridget.json"),
  "utf8",
);

function writeGrokSession(
  home: string,
  sessionId: string,
  updates: string,
  signals?: string,
): string {
  const directory = join(
    home,
    "sessions",
    encodeURIComponent(resolve(WORKTREE)),
    sessionId,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd: resolve(WORKTREE) },
      current_model_id: "grok-4.5",
    }),
  );
  writeFileSync(join(directory, "updates.jsonl"), updates);
  if (signals !== undefined) {
    writeFileSync(join(directory, "signals.json"), signals);
  }
  return directory;
}

describe("grok session telemetry", () => {
  test("reads the vendor's own context reading and the turn's end from real records", async () => {
    const home = makeHome();
    writeGrokSession(home, "session-1", GROK_UPDATES, GROK_SIGNALS);

    const telemetry = await readGrokTelemetry(WORKTREE, "session-1", home);
    // signals.json says contextWindowUsage 6 -- the vendor's number, not a
    // division of our own against a window we guessed.
    expect(telemetry.contextPct).toEqual(6);
    // The last record is turn_completed, so the turn ended: this is the
    // observable that settles a grok row to idle. Nothing else reports it --
    // grok drives no control channel -- which is why bridget's row sat at
    // "spawning" for her whole life.
    expect(telemetry.turnCompleted).toEqual(true);
    expect(telemetry.lastActivityAt).not.toEqual(null);
  });

  test("a turn still streaming is working, not idle", async () => {
    const home = makeHome();
    // The same session with its terminal record not yet written.
    const streaming = GROK_UPDATES.trimEnd().split("\n").slice(0, -1).join("\n") +
      "\n";
    writeGrokSession(home, "session-1", streaming, GROK_SIGNALS);

    const telemetry = await readGrokTelemetry(WORKTREE, "session-1", home);
    expect(telemetry.turnCompleted).toEqual(false);
  });

  // A cancelled grok turn writes no signals.json at all, and an agent that has
  // not finished a turn has none yet. Occupancy unknown must read null: a zero
  // here would mark a full agent as empty and invite more work onto it.
  test("no signals.json is unknown occupancy, never zero", async () => {
    const home = makeHome();
    writeGrokSession(home, "session-1", GROK_UPDATES);

    const telemetry = await readGrokTelemetry(WORKTREE, "session-1", home);
    expect(telemetry.contextPct).toEqual(null);
    expect(telemetry.turnCompleted).toEqual(true);
  });

  test("no session at all reports unknown, not an empty agent", async () => {
    const home = makeHome();
    expect(await readGrokTelemetry(WORKTREE, undefined, home)).toEqual({
      contextPct: null,
      lastActivityAt: null,
      turnCompleted: null,
    });
  });
});

describe("graphify call counting", () => {
  const toolUseLine = (name: string, sidechain = false): string =>
    JSON.stringify({
      type: "assistant",
      ...(sidechain ? { isSidechain: true } : {}),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "using the graph" },
          { type: "tool_use", id: "t1", name, input: {} },
        ],
      },
    });

  const mcpEndLine = (server: string): string =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        invocation: { server, tool: "query_graph", arguments: {} },
      },
    });

  test("counts claude graphify tool_use entries, not sidechains or other servers", () => {
    const slice = [
      toolUseLine("mcp__graphify__query_graph"),
      toolUseLine("mcp__graphify__get_node"),
      toolUseLine("mcp__graphify__god_nodes", true),
      toolUseLine("mcp__hive__hive_send"),
      "not json at all",
    ].join("\n") + "\n";
    expect(countGraphifyCallLines(slice, "claude")).toEqual(2);
  });

  test("counts codex mcp_tool_call_end events for the graphify server only", () => {
    const slice = [
      mcpEndLine("graphify"),
      mcpEndLine("hive"),
      mcpEndLine("graphify"),
    ].join("\n") + "\n";
    expect(countGraphifyCallLines(slice, "codex")).toEqual(2);
  });

  test("cursors advance incrementally and never count a partial line", async () => {
    const home = makeHome();
    const directory = claudeProjectDir(home);
    const path = join(directory, "session-g.jsonl");
    const first = toolUseLine("mcp__graphify__query_graph") + "\n";
    // A complete line plus the torn beginning of the next write.
    writeFileSync(path, first + '{"type":"assist');
    const one = await readGraphifyCalls("claude", WORKTREE, "session-g", undefined, home);
    expect(one?.count).toEqual(1);
    expect(one?.offset).toEqual(Buffer.byteLength(first, "utf8"));

    // The torn line completes and another call lands; only the delta is read.
    writeFileSync(
      path,
      first + '{"type":"assistant"}\n' + toolUseLine("mcp__graphify__graph_stats") + "\n",
    );
    const two = await readGraphifyCalls("claude", WORKTREE, "session-g", one ?? undefined, home);
    expect(two?.count).toEqual(2);
  });

  test("no session id means unknown, never zero", async () => {
    const home = makeHome();
    expect(
      await readGraphifyCalls("claude", WORKTREE, undefined, undefined, home),
    ).toBeNull();
  });

  // The count bridget really made: graph_locate x1, get_node x2,
  // get_neighbors x2, query_graph x1. Grok wraps every MCP call in one native
  // `use_tool`, so all 16 of these records are titled "use_tool" and the
  // called tool's name lives at rawInput.tool_name. A counter keyed on the
  // record's name reads zero against this very file -- which is what shipped,
  // and what made a vendor that was using the graph look like one that never
  // touched it.
  test("counts grok use_tool records by rawInput.tool_name, not the record title", () => {
    expect(countGraphifyCallLines(GROK_UPDATES, "grok")).toEqual(6);
    expect(GROK_UPDATES).toContain('"title":"use_tool"');
    expect(GROK_UPDATES).not.toContain('"title":"graphify__query_graph"');
  });

  test("counts grok calls off the session's real updates.jsonl", async () => {
    const home = makeHome();
    writeGrokSession(home, "session-1", GROK_UPDATES, GROK_SIGNALS);
    const cursor = await readGraphifyCalls(
      "grok",
      WORKTREE,
      "session-1",
      undefined,
      home,
    );
    expect(cursor?.count).toEqual(6);
    expect(cursor?.path.endsWith("updates.jsonl")).toBe(true);
  });

  test("a grok agent with no session yet is unknown, never zero", async () => {
    const home = makeHome();
    expect(
      await readGraphifyCalls("grok", WORKTREE, undefined, undefined, home),
    ).toBeNull();
  });

  // The positive control that catches a regression to all-null: the two
  // vendors that already counted must keep counting. An all-null column reads
  // as "nobody uses the graph" when it actually means "the reader is broken".
  test("every vendor's counter still sees its own graph calls", () => {
    expect(countGraphifyCallLines(toolUseLine("mcp__graphify__query_graph") + "\n", "claude"))
      .toEqual(1);
    expect(countGraphifyCallLines(mcpEndLine("graphify") + "\n", "codex"))
      .toEqual(1);
    expect(countGraphifyCallLines(GROK_UPDATES, "grok")).toBeGreaterThan(0);
  });
});
