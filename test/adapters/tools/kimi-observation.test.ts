import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKimiProviderEvents } from "../../../src/adapters/tools/kimi-observation";
import type { ProviderRun } from "../../../src/schemas";

const startedAt = "2026-07-24T19:00:00.000Z";

function run(conversationId: string | null = null): ProviderRun {
  return {
    runId: "018f1e90-7b5a-7cc0-8000-000000000210",
    agentId: "agent-kimi",
    terminal: {
      schemaVersion: 1,
      instanceId: "kimi-observation-test",
      subject: { kind: "agent", agentId: "agent-kimi" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000210",
      hostKind: "sessiond",
      engineBuildId: "test",
    },
    provider: "kimi",
    model: "kimi-code/k3",
    effort: null,
    conversationId,
    pid: 4210,
    startToken: "4210:1",
    foregroundProcessGroupId: 4210,
    capabilityEpoch: 2,
    launchGrantId: "grant-kimi",
    startedAt,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
}

async function writeSession(
  home: string,
  sessionId: string,
  workDir: string,
  wire: readonly object[],
) {
  const sessionDir = join(home, "sessions", sessionId);
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(
    join(sessionDir, "state.json"),
    JSON.stringify({
      workDir,
      createdAt: "2026-07-24T19:00:01.000Z",
    }),
  );
  await writeFile(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    `${wire.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  return { sessionId, sessionDir, workDir };
}

describe("Kimi file observation", () => {
  test("binds the exact indexed worktree and maps measured wire records", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-observation-"));
    try {
      const workDir = join(home, "worktree");
      const row = await writeSession(home, "session_exact", workDir, [
        {
          type: "turn.prompt",
          origin: { kind: "user" },
          time: 1_784_939_159_674,
        },
        {
          type: "context.append_loop_event",
          time: 1_784_939_160_000,
          event: { type: "tool.call", name: "Read", args: { path: "a.ts" } },
        },
        {
          type: "context.append_loop_event",
          time: 1_784_939_160_100,
          event: { type: "tool.result", toolCallId: "call-1" },
        },
        {
          type: "context.append_loop_event",
          time: 1_784_939_166_524,
          event: { type: "step.end", finishReason: "end_turn" },
        },
        { type: "turn.cancel", time: 1_784_396_122_989 },
      ]);
      await writeFile(
        join(home, "session_index.jsonl"),
        `${JSON.stringify(row)}\n${JSON.stringify({
          ...row,
          sessionId: "wrong",
          workDir: `${workDir}-other`,
        })}\n`,
      );

      const observed = await readKimiProviderEvents(
        run("session_exact"),
        workDir,
        home,
      );
      expect(observed.completeness).toBe("complete");
      expect(observed.through).not.toBeNull();
      expect(observed.events.map((event) => event.kind)).toEqual([
        "turn-started",
        "tool-started",
        "tool-finished",
        "turn-idle",
        "interrupted",
      ]);
      expect(observed.events[1]).toMatchObject({
        providerRunId: run().runId,
        conversationId: "session_exact",
        toolName: "Read",
        inputDigest: createHash("sha256")
          .update(JSON.stringify({ path: "a.ts" }))
          .digest("hex"),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("returns unknown rather than guessing between matching sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-ambiguous-"));
    try {
      const workDir = join(home, "worktree");
      const first = await writeSession(home, "session_one", workDir, []);
      const second = await writeSession(home, "session_two", workDir, []);
      await writeFile(
        join(home, "session_index.jsonl"),
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      );
      expect(await readKimiProviderEvents(run(), workDir, home)).toEqual({
        events: [],
        through: null,
        completeness: "unknown",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.todo(
    "normalizes Grok hooks after live hook firing can be verified",
    () => {},
  );
  test.todo(
    "normalizes the OpenCode plugin after OpenCode can be launched",
    () => {},
  );
});
