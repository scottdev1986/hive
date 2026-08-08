/**
 * Wave-2 milestone 9: protocol session facts are the only source for live
 * model and context after statusline/transcript scrapers are deleted.
 */
import { describe, expect, test } from "bun:test";
import type { NormalizedProviderEvent } from "../../src/adapters/providers/protocol/types";
import {
  agentFactsFromProtocolEvent,
  tokenEventsFromProtocol,
} from "../../src/usage-service/protocol-session-facts";
import { protocolTokenEvent } from "../../src/usage-service/token-usage";

const base = {
  sequence: 1,
  occurredAt: "2026-08-02T12:00:00.000Z",
  raw: null,
} as const;

function mergeAgentFactPatches(
  ...patches: readonly ReturnType<typeof agentFactsFromProtocolEvent>[]
) {
  const merged: ReturnType<typeof agentFactsFromProtocolEvent> = {};
  for (const patch of patches) {
    if (patch.liveModel !== undefined) merged.liveModel = patch.liveModel;
    if (patch.contextWindow !== undefined) {
      merged.contextWindow = patch.contextWindow;
    }
    if (patch.contextPct !== undefined) merged.contextPct = patch.contextPct;
    if (patch.effort !== undefined) merged.effort = patch.effort;
  }
  return merged;
}

function config(
  fields: Partial<Extract<NormalizedProviderEvent, { kind: "config-updated" }>>,
): NormalizedProviderEvent {
  return {
    kind: "config-updated",
    model: null,
    effort: null,
    mode: null,
    ...base,
    ...fields,
  } as NormalizedProviderEvent;
}

function usage(
  fields: Partial<Extract<NormalizedProviderEvent, { kind: "usage-updated" }>>,
): NormalizedProviderEvent {
  return {
    kind: "usage-updated",
    turnId: "turn-1",
    contextPercent: null,
    inputTokens: null,
    outputTokens: null,
    ...base,
    ...fields,
  } as NormalizedProviderEvent;
}

describe("protocol session facts (w2-m9 statusline deletion)", () => {
  test("config-updated lands live model and effort; empty model is not written", () => {
    expect(
      agentFactsFromProtocolEvent(
        config({ model: "gpt-5.6-sol", effort: "xhigh" }),
      ),
    ).toEqual({ liveModel: "gpt-5.6-sol", effort: "xhigh" });
    expect(agentFactsFromProtocolEvent(config({ model: null }))).toEqual({});
    expect(agentFactsFromProtocolEvent(config({ model: "" }))).toEqual({});
  });

  test("usage-updated lands positive window and occupancy only", () => {
    expect(
      agentFactsFromProtocolEvent(
        usage({
          contextWindow: 258_400,
          contextPercent: 12.5,
          inputTokens: 10,
          outputTokens: 2,
        }),
      ),
      // Occupancy is stored as whole percent, the same clamp the Grok probe
      // writes through: the column has two writers and one meaning.
    ).toEqual({ contextWindow: 258_400, contextPct: 13 });
  });

  test("Grok occupancy absence: null percent writes nothing; window still lands", () => {
    // Grok ACP states the window (totalContextTokens) but not occupancy.
    // Null occupancy is absence — never invent zero percent.
    expect(
      agentFactsFromProtocolEvent(
        usage({
          contextWindow: 500_000,
          contextPercent: null,
          inputTokens: 40,
          outputTokens: 8,
        }),
      ),
    ).toEqual({ contextWindow: 500_000 });
    expect(
      agentFactsFromProtocolEvent(
        usage({
          contextWindow: null,
          contextPercent: null,
          inputTokens: 40,
          outputTokens: 8,
        }),
      ),
    ).toEqual({});
    expect(
      agentFactsFromProtocolEvent(
        usage({
          contextWindow: 0,
          contextPercent: 0,
          inputTokens: 1,
          outputTokens: 1,
        }),
      ),
    ).toEqual({ contextPct: 0 });
  });

  test("non-session events do not invent agent facts", () => {
    expect(
      agentFactsFromProtocolEvent({
        kind: "turn-idle",
        turnId: "t1",
        ...base,
      } as NormalizedProviderEvent),
    ).toEqual({});
  });

  test("merge keeps the latest measured field and never backfills absence", () => {
    expect(
      mergeAgentFactPatches(
        agentFactsFromProtocolEvent(
          config({ model: "claude-haiku-4-5-20251001" }),
        ),
        agentFactsFromProtocolEvent(
          usage({ contextWindow: 200_000, contextPercent: 40 }),
        ),
        agentFactsFromProtocolEvent(config({ model: "claude-opus-5" })),
        agentFactsFromProtocolEvent(
          usage({ contextWindow: null, contextPercent: null }),
        ),
      ),
    ).toEqual({
      liveModel: "claude-opus-5",
      contextWindow: 200_000,
      contextPct: 40,
    });
  });

  test("token attribution only when usageKey is present", () => {
    const attributed = usage({
      inputTokens: 60,
      outputTokens: 4,
      usageKey: "message:m1",
      source: "claude-stream-json",
      observedAt: base.occurredAt,
    });
    const displayOnly = usage({
      contextPercent: 42,
      contextWindow: 200_000,
      inputTokens: null,
      outputTokens: null,
    });
    expect(protocolTokenEvent(attributed as never)).not.toBeNull();
    expect(protocolTokenEvent(displayOnly as never)).toBeNull();
    expect(tokenEventsFromProtocol([attributed, displayOnly])).toHaveLength(1);
    expect(tokenEventsFromProtocol([attributed, displayOnly])[0]?.key).toBe(
      "message:m1",
    );
  });
});
