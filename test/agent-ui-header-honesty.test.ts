import { describe, expect, test } from "bun:test";
import {
  agentHeaderText,
  type PaneIdentity,
} from "../src/cli/agent-ui/agent-ui-exports";
import {
  applyProviderEvent,
  initialView,
  type ViewState,
} from "../src/cli/agent-ui/view-state";

const IDENTITY: PaneIdentity = {
  agentName: "maya",
  vendorName: "Kimi Code",
  vendorId: "kimi",
  model: "kimi-k2",
  effort: "high",
};

function header(view: ViewState, identity: PaneIdentity = IDENTITY): string {
  return agentHeaderText(view, identity);
}

const lifecycle = (kind: "turn-started" | "turn-idle") =>
  ({
    kind,
    turnId: "t1",
    sequence: 1,
    occurredAt: "1970-01-01T00:00:00.000Z",
    raw: {},
  }) as const;

describe("the Agent UI header reports measured state", () => {
  test("turn is unknown until a lifecycle event says otherwise", () => {
    expect(initialView().turn).toBe("unknown");
    expect(header(initialView())).toContain("—");
    expect(header(initialView())).not.toContain("IDLE");
  });

  test("provider lifecycle states are distinct", () => {
    const working = applyProviderEvent(
      initialView(),
      lifecycle("turn-started"),
    );
    const done = applyProviderEvent(working, lifecycle("turn-idle"));

    expect(header(working)).toContain("Working");
    expect(header(done)).toContain("Done");
  });

  test("unreported, zero, and nonzero context are not confused", () => {
    const zero = applyProviderEvent(initialView(), {
      kind: "usage-updated",
      turnId: "t1",
      contextPercent: 0,
      inputTokens: null,
      outputTokens: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });
    const measured = applyProviderEvent(zero, {
      kind: "usage-updated",
      turnId: "t1",
      contextPercent: 41,
      inputTokens: null,
      outputTokens: null,
      sequence: 2,
      occurredAt: "1970-01-01T00:00:00.001Z",
      raw: {},
    });

    expect(header(initialView())).toContain("context —");
    expect(header(zero)).toContain("context 0%");
    expect(header(measured)).toContain("context 41%");
  });

  test("a usage event without occupancy preserves the last measurement", () => {
    const measured = applyProviderEvent(initialView(), {
      kind: "usage-updated",
      turnId: "t1",
      contextPercent: 28,
      inputTokens: null,
      outputTokens: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });
    const tokenOnly = applyProviderEvent(measured, {
      kind: "usage-updated",
      turnId: "t1",
      contextPercent: null,
      inputTokens: 138_921,
      outputTokens: null,
      sequence: 2,
      occurredAt: "1970-01-01T00:00:00.001Z",
      raw: {},
    });

    expect(header(tokenOnly)).toContain("context 28%");
  });

  test("runtime, turn, and mail remain separate facts", () => {
    const view: ViewState = {
      ...initialView(),
      runtime: "ready",
      turn: "unknown",
      mail: "waiting",
    };
    const text = header(view);

    expect(text).toContain("connected");
    expect(text).toContain("mail waiting");
    expect(text).toContain("—");
  });

  test("a researched absence is stated until a real reading arrives", () => {
    const identity: PaneIdentity = {
      ...IDENTITY,
      absences: {
        contextUsage: { reason: "Kimi does not report context" },
      },
    };
    const measured = applyProviderEvent(initialView(), {
      kind: "usage-updated",
      turnId: "t1",
      contextPercent: 37,
      inputTokens: null,
      outputTokens: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });

    expect(header(initialView(), identity)).toContain(
      "Kimi does not report context",
    );
    expect(header(measured, identity)).toContain("context 37%");
    expect(header(measured, identity)).not.toContain("does not report");
  });

  test("live model configuration wins over launch configuration", () => {
    const configured = applyProviderEvent(initialView(), {
      kind: "config-updated",
      model: "kimi-k2-turbo",
      effort: "max",
      mode: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });
    const unreported = applyProviderEvent(initialView(), {
      kind: "config-updated",
      model: null,
      effort: null,
      mode: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });

    expect(header(configured)).toContain("kimi-k2-turbo · max");
    expect(header(unreported)).toContain("kimi-k2 · high");
  });

  test("a config event that names only the model keeps the known effort", () => {
    const configured = applyProviderEvent(initialView(), {
      kind: "config-updated",
      model: "kimi-k2-turbo",
      effort: "max",
      mode: null,
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });
    const modelOnly = applyProviderEvent(configured, {
      kind: "config-updated",
      model: "kimi-k2",
      effort: null,
      mode: null,
      sequence: 2,
      occurredAt: "1970-01-01T00:00:00.001Z",
      raw: {},
    });

    expect(header(modelOnly)).toContain("kimi-k2 · max");
  });
});
