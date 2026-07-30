import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getAgentAdapter } from "../../src/adapters/providers/provider-registry";
import { ROLE_GRANTS } from "../../src/daemon/capabilities";
import {
  buildNormalMessageBatchProjection,
  MESSAGE_BATCH_MAX_BYTES,
} from "../../src/daemon/context-projection";
import { buildAgentPrompt } from "../../src/daemon/spawner-impl";
import {
  AgentMessageSchema,
  CAPABILITY_PROVIDERS,
  MessagePrioritySchema,
} from "../../src/schemas";

const worktree = {
  path: "/repo/.hive/worktrees/reviewer",
  branch: "hive/reviewer-context-economy",
};
const runId = "018f1e90-7b5a-7cc0-8000-000000000601";

function message(id: string, sequence: number, body: string) {
  return AgentMessageSchema.parse({
    id,
    from: sequence % 2 === 0 ? "sam" : "queen",
    to: "maya",
    body,
    createdAt: "2026-07-24T12:00:00.000Z",
    deliveredAt: null,
    sequence,
  });
}

describe("C3 context economy", () => {
  test("bootstrap keeps judgment rules and drops daemon-enforced repetition", () => {
    const task = "Review the context projection.";
    const prompt = buildAgentPrompt("reviewer", task, worktree, "", {
      tool: "codex",
      category: "code_review",
    });

    expect(prompt).toContain(`Your task: ${task}`);
    expect(prompt).toContain("An absent field is unknown");
    expect(prompt).toContain("Measure, do not infer");
    expect(prompt).not.toContain("Urgent is a turn kill");
    expect(prompt).not.toContain("After 3 failed attempts");
    expect(prompt).not.toContain("(src/, not the repo root)");
    expect(prompt).not.toContain("merge-base with main");
    expect(prompt).toContain("primary checkout's current branch");

    const hiveBytes =
      Buffer.byteLength(prompt, "utf8") - Buffer.byteLength(task, "utf8");
    expect(hiveBytes).toBeLessThan(6_000);
  });

  test("an oversized normal message has a bounded lossless projection", () => {
    const full = `begin-${"middle".repeat(2_000)}-end`;
    const projection = buildNormalMessageBatchProjection(
      [message("message-1", 1, full)],
      runId,
    );

    expect(Buffer.byteLength(projection.body, "utf8")).toBeLessThanOrEqual(
      MESSAGE_BATCH_MAX_BYTES,
    );
    expect(projection.complete).toBe(false);
    expect(projection.omitted).toMatchObject({ sources: 1 });
    expect(projection.omitted.bytes).toBeGreaterThan(0);
    expect(projection.body).toContain("begin-");
    expect(projection.body).toContain("-end");
    expect(projection.body).toContain(
      `${projection.omitted.bytes} bytes omitted`,
    );
    expect(projection.sourceRefs[0]).toEqual({
      kind: "message",
      id: "message-1",
      retrieval: {
        tool: "hive_read_message",
        arguments: { id: "message-1" },
      },
    });
    expect(projection.sourceDigests[0]).toBe(
      createHash("sha256").update(full, "utf8").digest("hex"),
    );
  });

  test("a batch preserves message order, identity, and independent references", () => {
    const projection = buildNormalMessageBatchProjection(
      [message("message-1", 1, "first"), message("message-2", 2, "second")],
      runId,
    );

    expect(projection.complete).toBe(true);
    expect(projection.body.indexOf("message-1")).toBeLessThan(
      projection.body.indexOf("message-2"),
    );
    expect(projection.sourceRefs.map((source) => source.id)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(projection.sourceDigests).toHaveLength(2);
    expect(
      buildNormalMessageBatchProjection(
        [message("message-1", 1, "first"), message("message-2", 2, "second")],
        runId,
      ).projectionId,
    ).toBe(projection.projectionId);
    expect(
      buildNormalMessageBatchProjection(
        [message("message-1", 1, "first")],
        runId,
      ).projectionId,
    ).not.toBe(projection.projectionId);
  });

  test("control priorities cannot enter a normal batch", () => {
    const urgent = {
      ...message("urgent-1", 1, "stop"),
      priority: "urgent" as const,
    };
    expect(() => buildNormalMessageBatchProjection([urgent], runId)).toThrow(
      "requires at least one normal message",
    );
  });

  test("limiting context preserves effective provider and control capability", () => {
    const projection = buildNormalMessageBatchProjection(
      [message("message-1", 1, "large".repeat(4_000))],
      runId,
    );

    expect(
      Object.fromEntries(
        CAPABILITY_PROVIDERS.map((provider) => [
          provider,
          getAgentAdapter(provider).communication,
        ]),
      ),
    ).toEqual({
      claude: {
        provider: "claude",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      codex: {
        provider: "codex",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      grok: {
        provider: "grok",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      kimi: {
        provider: "kimi",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: false,
        turnBoundaryEvents: false,
        transcriptReader: false,
        nativeCancel: false,
        conversationResume: true,
      },
      opencode: {
        provider: "opencode",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: false,
        turnBoundaryEvents: false,
        transcriptReader: false,
        nativeCancel: false,
        conversationResume: true,
      },
    });
    expect(MessagePrioritySchema.options).toEqual([
      "normal",
      "steer",
      "urgent",
      "critical",
    ]);
    expect(ROLE_GRANTS.writer.actions).toEqual(
      expect.arrayContaining([
        "terminal:observe",
        "message:send",
        "message:ack",
        "message:read",
        "inbox:read",
        "event:report",
      ]),
    );
    expect(ROLE_GRANTS.orchestrator.actions).toEqual(
      expect.arrayContaining([
        "agent:kill",
        "agent:recover",
        "approval:decide",
        "message:send",
        "message:read",
      ]),
    );
    expect(projection.sourceRefs[0]?.retrieval.tool).toBe("hive_read_message");
  });
});
