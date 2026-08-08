import { describe, expect, test } from "bun:test";
import {
  applyMailNotice,
  applyProviderEvent,
  initialView,
} from "../src/cli/agent-ui/view-state";

const OCCURRED_AT = "1970-01-01T00:00:00.000Z";

describe("transcript reduction", () => {
  test("a failed turn changes state without synthesizing a UI diagnostic", () => {
    const view = applyProviderEvent(initialView(), {
      kind: "turn-failed",
      turnId: "turn-1",
      reason: "rate limit reached; resets at 1:50 PM",
      sequence: 1,
      occurredAt: OCCURRED_AT,
      raw: {},
    });

    expect(view.turn).toBe("failed");
    expect(view.transcript.length).toBe(0);
  });

  test("a delta after 10k entries mutates only the tail and reports its range", () => {
    let view = initialView();
    for (let index = 0; index < 10_000; index += 1) {
      view = applyMailNotice(view, "work", `mail-${index}`);
    }
    expect(view.transcript.consumeChangedStart()).toBe(0);

    const transcript = view.transcript;
    view = applyProviderEvent(view, {
      kind: "message-delta",
      turnId: "turn-1",
      text: "first",
      sequence: 1,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    expect(view.transcript).toBe(transcript);
    expect(view.transcript.consumeChangedStart()).toBe(10_000);

    const length = view.transcript.length;
    view = applyProviderEvent(view, {
      kind: "message-delta",
      turnId: "turn-1",
      text: " second",
      sequence: 2,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    expect(view.transcript).toBe(transcript);
    expect(view.transcript.length).toBe(length);
    expect(view.transcript.at(-1)).toEqual({
      kind: "agent",
      turnId: "turn-1",
      text: "first second",
      streaming: true,
    });
    expect(view.transcript.consumeChangedStart()).toBe(10_000);
  });

  test("coalesced changes retain the earliest dirty entry", () => {
    let view = applyProviderEvent(initialView(), {
      kind: "tool-started",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "Read",
      detail: "before",
      sequence: 1,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    view.transcript.consumeChangedStart();
    for (let index = 0; index < 10_000; index += 1) {
      view = applyMailNotice(view, "work", `mail-${index}`);
    }
    view = applyProviderEvent(view, {
      kind: "tool-updated",
      turnId: "turn-1",
      toolCallId: "call-1",
      detail: "after",
      sequence: 2,
      occurredAt: OCCURRED_AT,
      raw: {},
    });

    expect(view.transcript.consumeChangedStart()).toBe(0);
    expect(view.transcript[0]).toMatchObject({
      kind: "tool",
      detail: "after",
    });
  });

  test("reasoning stops reading as active when a question begins", () => {
    let view = applyProviderEvent(initialView(), {
      kind: "thought-delta",
      turnId: "turn-1",
      text: "Considering the choices",
      sequence: 1,
      occurredAt: OCCURRED_AT,
      raw: {},
    });
    const questionAt = "1970-01-01T00:00:03.000Z";
    view = applyProviderEvent(view, {
      kind: "question-waiting",
      requestId: "question-1",
      turnId: "turn-1",
      summary: "Choose",
      questions: [],
      sequence: 2,
      occurredAt: questionAt,
      raw: {},
    });

    expect(view.transcript[0]).toMatchObject({
      kind: "thought",
      completedAt: questionAt,
    });
  });
});
