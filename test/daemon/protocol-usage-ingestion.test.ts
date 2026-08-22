/**
 * Milestone 4 acceptance: usage taken from the live protocol stream carries
 * every fact the artifact collectors persist, and replaying it leaves the same
 * attribution totals rather than counting the tokens twice.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeVendorNotification } from "../../src/adapters/providers/protocol/acp-normalize";
import type { NormalizedProviderEvent } from "../../src/adapters/providers/protocol/types";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  protocolTokenEvent,
  TokenUsageStore,
} from "../../src/usage-service/token-usage";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const at = "2026-08-02T12:00:00.000Z";

type UsageEvent = Extract<NormalizedProviderEvent, { kind: "usage-updated" }>;

function usage(fields: Partial<UsageEvent>): UsageEvent {
  // SAFETY: The test owns this value and its fields.
  return {
    kind: "usage-updated",
    turnId: "turn-1",
    contextPercent: null,
    inputTokens: null,
    outputTokens: null,
    observedAt: at,
    raw: null,
    ...fields,
  } as UsageEvent;
}

async function storeWithSubject(prefix: string) {
  const home = tempRoot(prefix);
  const repo = join(home, "repo");
  mkdirSync(repo);
  const store = new TokenUsageStore(new HiveDatabase(":memory:"));
  const session = await store.startSession(repo, at);
  const subject = store.startOrchestrator(session, "claude", repo, at);
  return { store, subject };
}

/** The live token-usage read, with no provider artifact scanner. */
async function counts(store: TokenUsageStore) {
  const reading = required(
    (await store.snapshot()).sessions[0]?.subjects[0],
  ).reading;
  return reading.state === "measured" ? reading.counts : null;
}

describe("protocol usage ingestion", () => {
  test("replaying a reconnect's readings counts the same tokens once", async () => {
    const { store, subject } = await storeWithSubject("hive-replay-");
    const events = [
      usage({
        inputTokens: 60,
        outputTokens: 4,
        cachedInputTokens: 30,
        cacheCreationInputTokens: 20,
        usageKey: "message:m1",
        source: "claude-stream-json",
      }),
      usage({
        inputTokens: 90,
        outputTokens: 7,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 10,
        usageKey: "message:m2",
        source: "claude-stream-json",
      }),
    ].map((event) => required(protocolTokenEvent(event)));

    store.recordProtocolUsage(subject, events);
    const first = await counts(store);
    expect(first).toEqual({
      inputTokens: 150,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 30,
      outputTokens: 11,
      reasoningTokens: null,
      totalTokens: 161,
    });

    // A reconnect replays what it already delivered.
    store.recordProtocolUsage(subject, events);
    store.recordProtocolUsage(subject, events);
    expect(await counts(store)).toEqual(required(first));

    // Positive control: the totals above are not simply frozen.
    store.recordProtocolUsage(subject, [
      required(
        protocolTokenEvent(
          usage({
            inputTokens: 5,
            outputTokens: 1,
            usageKey: "message:m3",
            source: "claude-stream-json",
          }),
        ),
      ),
    ]);
    expect(required(await counts(store)).totalTokens).toBe(167);
  });

  test("a replayed cumulative counter is the total, not another turn's worth", async () => {
    const { store, subject } = await storeWithSubject("hive-cumulative-");
    const reading = (input: number, output: number) =>
      required(
        protocolTokenEvent(
          usage({
            inputTokens: input,
            outputTokens: output,
            cachedInputTokens: 40,
            reasoningTokens: 3,
            usageKey: "cumulative",
            cumulative: true,
            source: "codex-app-server",
          }),
        ),
      );

    store.recordProtocolUsage(subject, [reading(100, 20)]);
    store.recordProtocolUsage(subject, [reading(100, 20)]);
    expect(required(await counts(store)).totalTokens).toBe(120);

    // Codex re-reports a running counter; the later reading replaces it.
    store.recordProtocolUsage(subject, [reading(150, 30)]);
    store.recordProtocolUsage(subject, [reading(150, 30)]);
    expect(await counts(store)).toEqual({
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationInputTokens: null,
      outputTokens: 30,
      reasoningTokens: 3,
      totalTokens: 180,
    });
  });

  test("a reading the vendor never named is shown but never attributed", async () => {
    const { store, subject } = await storeWithSubject("hive-unkeyed-");
    // Claude's per-turn result frame and its context refresh both report usage
    // that the per-message readings already cover.
    expect(
      protocolTokenEvent(usage({ inputTokens: 10, outputTokens: 2 })),
    ).toBe(null);
    expect(protocolTokenEvent(usage({ contextPercent: 42 }))).toBe(null);

    store.recordProtocolUsage(subject, []);
    expect(await counts(store)).toBe(null);

    // Positive control: the same store does attribute a named reading.
    store.recordProtocolUsage(subject, [
      required(
        protocolTokenEvent(
          usage({ inputTokens: 10, outputTokens: 2, usageKey: "message:m1" }),
        ),
      ),
    ]);
    expect(required(await counts(store)).totalTokens).toBe(12);
  });

  test("Grok's protocol frame carries the counts the deleted scanner used to hold", async () => {
    const update = {
      sessionUpdate: "turn_completed",
      prompt_id: "prompt-7",
      usage: {
        inputTokens: 1_200,
        outputTokens: 340,
        cachedReadTokens: 900,
        cacheCreationTokens: 64,
        reasoningTokens: 55,
      },
    };

    const events = normalizeVendorNotification(
      "_x.ai/session_notification",
      { update },
      "prompt-7",
    );
    const fromProtocol = required(
      protocolTokenEvent(
        // SAFETY: The test owns this value and its fields.
        required(
          events.find((event) => event.kind === "usage-updated"),
        ) as UsageEvent,
      ),
    );

    // The facts the Grok artifact collector used to persist, plus cache-creation
    // which that collector hard-coded null for.
    expect(fromProtocol.key).toBe("turn:prompt-7");
    expect(fromProtocol.counts).toEqual({
      inputTokens: 1_200,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 64,
      outputTokens: 340,
      reasoningTokens: 55,
    });
  });
});
