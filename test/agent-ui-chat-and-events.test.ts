import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eventRows } from "../src/cli/agent-ui/events-view";
import {
  applyProviderEvent,
  applyWakeDispatched,
  initialView,
} from "../src/cli/agent-ui/view-state";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

const OCCURRED_AT = "2026-08-30T12:41:07.000Z";

function toolCall(
  toolName: string,
  toolCallId: string,
  detail: string | null,
  output: string | null,
) {
  let view = applyProviderEvent(initialView(), {
    kind: "turn-started",
    turnId: "turn-1",
    sequence: 1,
    occurredAt: OCCURRED_AT,
    raw: {},
  });
  view = applyProviderEvent(view, {
    kind: "tool-started",
    turnId: "turn-1",
    toolCallId,
    toolName,
    detail,
    sequence: 2,
    occurredAt: OCCURRED_AT,
    raw: {},
  });
  if (output !== null) {
    view = applyProviderEvent(view, {
      kind: "tool-updated",
      turnId: "turn-1",
      toolCallId,
      detail,
      output,
      sequence: 3,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
  }
  return applyProviderEvent(view, {
    kind: "tool-finished",
    turnId: "turn-1",
    toolCallId,
    status: "ok",
    sequence: 4,
    occurredAt: OCCURRED_AT,
    raw: {},
  });
}

describe("mail becomes conversation", () => {
  test("a claimed work item is one inbound message row", () => {
    const view = toolCall(
      "mcp__hive__hive_mail_claim",
      "call-1",
      '{"recipient":"queen","itemId":"mit-1","handlerId":"h1"}',
      JSON.stringify({
        itemId: "mit-1",
        handlerId: "h1",
        ownerGeneration: 3,
        sender: "bram",
        lane: "work",
        topic: "runtime-echo",
        body: "Runtime echo for story 905. Shell available.",
      }),
    );
    const messages = view.transcript.filter(
      (entry) => entry.kind === "message",
    );
    expect(messages).toEqual([
      {
        kind: "message",
        turnId: "turn-1",
        key: "in:mit-1",
        direction: "in",
        peer: "bram",
        lane: "work",
        topic: "runtime-echo",
        body: "Runtime echo for story 905. Shell available.",
        at: OCCURRED_AT,
      },
    ]);
  });

  test("a control item polled and then claimed is still one message", () => {
    let view = toolCall(
      "mcp__hive__hive_mail_poll",
      "call-1",
      '{"recipient":"queen"}',
      JSON.stringify({
        recipient: "queen",
        control: {
          itemId: "mit-7",
          sender: "ines",
          topic: "general",
          addressedGeneration: null,
          seq: 7,
          attempts: 1,
          body: "Need a decision on the review lane.",
        },
        workDigest: [],
        cursor: 7,
        backlog: {},
      }),
    );
    view = applyProviderEvent(view, {
      kind: "tool-started",
      turnId: "turn-1",
      toolCallId: "call-2",
      toolName: "hive_mail_claim",
      detail: null,
      sequence: 10,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    view = applyProviderEvent(view, {
      kind: "tool-updated",
      turnId: "turn-1",
      toolCallId: "call-2",
      detail: null,
      output: JSON.stringify({
        itemId: "mit-7",
        sender: "ines",
        body: "Need a decision on the review lane.",
      }),
      sequence: 11,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    const messages = view.transcript.filter(
      (entry) => entry.kind === "message",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "in",
      peer: "ines",
      lane: "control",
    });
  });

  test("a publish becomes an outbound message once the tool succeeds", () => {
    const detail = JSON.stringify({
      from: "queen",
      to: "bram",
      lane: "control",
      topic: "message-test",
      body: "Reply on the control lane, then message the other three.",
      idempotencyKey: "k1",
    });
    const view = toolCall(
      "mcp__hive__hive_mail_publish",
      "call-9",
      detail,
      null,
    );
    const messages = view.transcript.filter(
      (entry) => entry.kind === "message",
    );
    expect(messages).toEqual([
      {
        kind: "message",
        turnId: "turn-1",
        key: "out:call-9",
        direction: "out",
        peer: "bram",
        lane: "control",
        topic: "message-test",
        body: "Reply on the control lane, then message the other three.",
        at: OCCURRED_AT,
      },
    ]);
  });

  test("a mail tool that fails or carries no body adds nothing", () => {
    const failed = applyProviderEvent(
      toolCall("mcp__hive__hive_mail_claim", "call-1", null, "not json"),
      {
        kind: "tool-finished",
        turnId: "turn-1",
        toolCallId: "call-1",
        status: "error",
        reason: "refused",
        sequence: 5,
        occurredAt: OCCURRED_AT,
        raw: {},
      },
    );
    expect(
      failed.transcript.filter((entry) => entry.kind === "message"),
    ).toHaveLength(0);
    const status = toolCall(
      "mcp__hive__hive_mail_status",
      "call-2",
      null,
      "{}",
    );
    expect(
      status.transcript.filter((entry) => entry.kind === "message"),
    ).toHaveLength(0);
  });
});

describe("wake turns are marked", () => {
  test("a turn named by a dispatched wake input is a wake turn", () => {
    let view = applyWakeDispatched(initialView(), "input-wake");
    view = applyProviderEvent(view, {
      kind: "turn-started",
      turnId: "turn-wake",
      clientInputId: "input-wake",
      sequence: 1,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    view = applyProviderEvent(view, {
      kind: "turn-started",
      turnId: "turn-user",
      clientInputId: "input-user",
      sequence: 2,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    expect([...view.wakeTurnIds]).toEqual(["turn-wake"]);
    expect(view.pendingWakeInputs.size).toBe(0);
  });

  test("event rows group by turn and say who started it", () => {
    let view = applyWakeDispatched(initialView(), "input-wake");
    for (const [turnId, clientInputId] of [
      ["turn-a", "input-user"],
      ["turn-b", "input-wake"],
    ] as const) {
      view = applyProviderEvent(view, {
        kind: "turn-started",
        turnId,
        clientInputId,
        sequence: 1,
        occurredAt: OCCURRED_AT,
        raw: {},
      });
      view = applyProviderEvent(view, {
        kind: "tool-started",
        turnId,
        toolCallId: `${turnId}-call`,
        toolName: "mcp__hive__hive_mail_poll",
        detail: null,
        sequence: 2,
        occurredAt: OCCURRED_AT,
        raw: {},
      });
    }
    const rows = eventRows(view.transcript, view.wakeTurnIds);
    expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual([
      "header:turn 1 · user",
      "event:Hive mail poll",
      "header:turn 2 · wake",
      "event:Hive mail poll",
    ]);
  });
});

describe("the pane shows conversation and one live line", () => {
  let harness: AgentUiHarness;

  beforeEach(async () => {
    harness = await createAgentUiHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function settle(): Promise<void> {
    await harness.ui.settleInput();
    await harness.testRenderer.flush();
    await Bun.sleep(60);
    await harness.testRenderer.flush();
  }

  test("an inbound message renders as chat with its sender, and the tool call does not", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "claim-1",
        toolName: "mcp__hive__hive_mail_claim",
        detail: '{"recipient":"maya","itemId":"mit-1"}',
      }),
    );
    await settle();
    // In flight: the live line names the call; the chat has no tool row.
    const running = harness.testRenderer.captureCharFrame();
    expect(running).toContain("Hive mail claim");
    expect(running.split("Hive mail claim")).toHaveLength(2);

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-updated",
        turnId: "t1",
        toolCallId: "claim-1",
        detail: '{"recipient":"maya","itemId":"mit-1"}',
        output: JSON.stringify({
          itemId: "mit-1",
          sender: "queen",
          lane: "control",
          body: "Confirm the fix covers CRLF endings.",
        }),
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-finished",
        turnId: "t1",
        toolCallId: "claim-1",
        status: "ok",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await settle();
    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("queen → you · control");
    expect(frame).toContain("Confirm the fix covers CRLF endings.");
    expect(frame).not.toContain("Hive mail claim");
    // The inbound card is a left rule beside the sender line, never a full box: the composer stays the only bordered box on screen.
    const headerLine = frame
      .split("\n")
      .find((line) => line.includes("queen → you"));
    expect(headerLine).toContain("│");
    expect(
      frame.split("\n").filter((line) => line.trimStart().startsWith("╭")),
    ).toHaveLength(1);

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settle();
    const events = harness.testRenderer.captureCharFrame();
    expect(events).toContain("✓ Hive mail claim");
    expect(events).toContain("↓ Mail in  queen");
    expect(events).toContain("shown in chat");
  });

  test("an idle pane shows no live line", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "All quiet.",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await settle();
    const live =
      harness.testRenderer.renderer.root.findDescendantById("agent-ui-live");
    expect(live?.visible).toBe(false);
    expect(harness.testRenderer.captureCharFrame()).toContain("All quiet.");
  });
});
