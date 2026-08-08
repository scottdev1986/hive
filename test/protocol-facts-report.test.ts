import { expect, test } from "bun:test";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveDaemon } from "../src/daemon/server";
import type { AgentRecord } from "../src/schemas/agent";
import { postProtocolSessionFacts } from "../src/usage-service/protocol-facts-report";
import { TokenUsageStore } from "../src/usage-service/token-usage";

const AT = "2026-08-09T12:00:00.000Z";
const REPO = "/tmp/protocol-facts-report";

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5",
    category: "standard_coding",
    status: "working",
    taskDescription: "protocol facts integration",
    worktreePath: "/tmp/maya",
    branch: "hive/maya",
    contextPct: null,
    createdAt: AT,
    lastEventAt: AT,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

test("protocol facts update the real daemon agent and token-usage stores", async () => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent());
  const tokenUsage = new TokenUsageStore(db);
  await tokenUsage.startSession(REPO, AT);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    tokenUsage,
    spawner: { spawn: async () => agent() },
    repoRoot: REPO,
  });
  const token = daemon.capabilities.mint("maya", "writer").token;
  const fetcher = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

  try {
    await postProtocolSessionFacts(
      {
        agent: "maya",
        observedAt: "2026-08-09T12:01:00.000Z",
        model: "gpt-5.6-sol",
        contextWindow: 258_400,
        contextPercent: 37.6,
        usage: {
          usageKey: "turn:protocol-facts",
          inputTokens: 47,
          cachedInputTokens: 11,
          cacheCreationInputTokens: null,
          outputTokens: 5,
          reasoningTokens: 3,
          cumulative: true,
          source: "codex-app-server",
        },
      },
      4483,
      fetcher,
    );

    expect(db.getAgentByName("maya")).toMatchObject({
      liveModel: "gpt-5.6-sol",
      contextWindow: 258_400,
      contextPct: 37.6,
    });
    const snapshot = await tokenUsage.snapshot(REPO);
    expect(snapshot.sessions[0]?.subjects[0]).toMatchObject({
      name: "maya",
      model: "gpt-5.6-sol",
      reading: {
        state: "measured",
        counts: {
          inputTokens: 47,
          cachedInputTokens: 11,
          cacheCreationInputTokens: null,
          outputTokens: 5,
          reasoningTokens: 3,
          totalTokens: 52,
        },
        source: "codex-app-server",
      },
    });
  } finally {
    await daemon.stop();
    db.close();
  }
});
