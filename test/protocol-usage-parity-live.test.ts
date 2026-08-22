import { isString } from "../src/shared/is-record";
import type { JsonObject } from "../src/shared/json";
/**
 * Live protocol usage smoke: drive a real vendor, attribute the readings
 * through `recordProtocolUsage`, and require a reconnect replay to leave the
 * totals unchanged. Milestone 4 already proved protocol == artifact; the
 * collectors are deleted, so this only re-checks the protocol path.
 *
 * Gated on HIVE_USAGE_PARITY_LIVE=1: it spends real tokens.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { which } from "bun";
import { CodexAppServerAdapter } from "../src/adapters/providers/codex-app-server/runtime-adapter";
import { ClaudeStreamJsonAdapter } from "../src/adapters/providers/protocol/claude-runtime-adapter";
import {
  GrokAcpAdapter,
  grokAcpSpawn,
} from "../src/adapters/providers/protocol/grok-acp-adapter";
import type {
  NormalizedProviderEvent,
  ProviderSession,
} from "../src/adapters/providers/protocol/types";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import {
  protocolTokenEvent,
  TokenUsageStore,
} from "../src/usage-service/token-usage";
import { writeEvidenceFile } from "./evidence-write";
import {
  requireExecutable,
  requireStagedLiveFile,
  requireSuccessfulTurn,
} from "./live-prerequisites";

const LIVE = process.env.HIVE_USAGE_PARITY_LIVE === "1";
const EVIDENCE = "docs/evidence/protocol-terminal/wave2/usage-parity";
const PROMPT = "Reply with exactly PONG and nothing else. Do not use tools.";

type UsageEvent = Extract<NormalizedProviderEvent, { kind: "usage-updated" }>;

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      isString(entry[1]),
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one real turn and return every event it produced. */
async function runTurn(
  session: ProviderSession,
  cwd: string,
  prompt: string,
  model?: string,
): Promise<{ events: NormalizedProviderEvent[]; vendorSessionId: string }> {
  const events: NormalizedProviderEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  const created = await session.newSession(
    model === undefined ? { cwd } : { cwd, model },
  );
  const receipt = await session.submit({
    session: created,
    clientInputId: "usage-parity",
    text: prompt,
  });
  if (receipt.outcome !== "accepted" || receipt.turnId === null) {
    throw new Error(
      `prompt was ${receipt.outcome}: ${receipt.detail ?? "no detail"}`,
    );
  }
  const deadline = Date.now() + 120_000;
  let settled = false;
  while (Date.now() < deadline) {
    if (
      events.some(
        (event) =>
          (event.kind === "turn-idle" ||
            event.kind === "turn-failed" ||
            event.kind === "interrupted") &&
          event.turnId === receipt.turnId,
      )
    ) {
      settled = true;
      break;
    }
    await sleep(200);
  }
  if (!settled) throw new Error("live usage turn timed out before settling");
  requireSuccessfulTurn("live usage turn", receipt, events);
  // Usage can trail the terminal event by a frame.
  await sleep(1_500);
  void reader;
  return { events, vendorSessionId: created.vendorSessionId };
}

async function reading(store: TokenUsageStore, repoRoot: string) {
  return (await store.snapshot(repoRoot)).sessions[0]?.subjects[0]?.reading;
}

async function totals(store: TokenUsageStore, repoRoot: string) {
  const current = await reading(store, repoRoot);
  return current?.state === "measured" ? current.counts : null;
}

async function provenance(
  store: TokenUsageStore,
  repoRoot: string,
): Promise<{
  source: string | null;
  observedAt: string | null;
}> {
  const current = await reading(store, repoRoot);
  return current?.state === "measured"
    ? { source: current.source, observedAt: current.observedAt }
    : { source: null, observedAt: null };
}

async function protocolTotals(
  provider: string,
  cwd: string,
  usage: UsageEvent[],
) {
  const store = new TokenUsageStore(new HiveDatabase(":memory:"));
  const at = new Date().toISOString();
  const session = await store.startSession(cwd, at);
  const subject = store.startOrchestrator(session, provider, cwd, at);
  const events = usage.flatMap((event) => {
    const mapped = protocolTokenEvent(event);
    return mapped === null ? [] : [mapped];
  });
  store.recordProtocolUsage(subject, events);
  const once = await totals(store, cwd);
  const provenanceOnce = await provenance(store, cwd);
  // A reconnect redelivers what it already sent.
  store.recordProtocolUsage(subject, events);
  store.recordProtocolUsage(subject, events);
  return {
    attributed: events,
    once,
    provenance: provenanceOnce,
    replayed: await totals(store, cwd),
    replayedProvenance: await provenance(store, cwd),
  };
}

function writeEvidence<T>(vendor: string, payload: T): void {
  writeEvidenceFile(
    join(EVIDENCE, `${vendor}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

async function proveProtocol(
  vendor: string,
  provider: string,
  cwd: string,
  open: () => Promise<ProviderSession>,
  model?: string,
  prompt: string = PROMPT,
): Promise<void> {
  const session = await open();
  let turn: Awaited<ReturnType<typeof runTurn>>;
  try {
    turn = await runTurn(session, cwd, prompt, model);
  } finally {
    await session.close?.();
  }
  const usage = turn.events.filter(
    (event): event is UsageEvent => event.kind === "usage-updated",
  );
  const protocol = await protocolTotals(provider, cwd, usage);

  writeEvidence(vendor, {
    vendor,
    capturedAt: new Date().toISOString(),
    vendorSessionId: turn.vendorSessionId,
    prompt,
    rawUsageFrames: usage.map((event) => event.raw),
    normalizedUsageEvents: usage.map(
      // SAFETY: The test owns this value and its fields.
      ({ raw: _raw, ...event }) => event as JsonObject,
    ),
    toolCalls: turn.events.flatMap((event) =>
      event.kind === "tool-started" ? [event.toolName] : [],
    ),
    assistantMessages: turn.events.filter(
      (event) => event.kind === "message-delta",
    ).length,
    liveModel: turn.events.flatMap((event) =>
      event.kind === "config-updated" ? [event.model] : [],
    ),
    contextWindow: usage.flatMap((event) =>
      event.contextWindow == null ? [] : [event.contextWindow],
    ),
    attributedEvents: protocol.attributed,
    protocolTotals: protocol.once,
    protocolTotalsAfterReplay: protocol.replayed,
    verdict: protocol.once === null ? "no protocol reading" : "protocol-ok",
  });

  expect(protocol.once).not.toBe(null);
  expect(protocol.replayed).toEqual(protocol.once);
  expect(protocol.replayedProvenance).toEqual(protocol.provenance);
  expect(protocol.provenance.source).not.toBe(null);
  expect(protocol.provenance.observedAt).not.toBe(null);
}

test.skipIf(!LIVE)(
  "codex usage reaches attribution losslessly",
  async () => {
    const executable = requireExecutable("Codex", which("codex"));
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_AUTH_FILE",
      join(process.env.CODEX_HOME ?? "", "auth.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_CONFIG_FILE",
      join(process.env.CODEX_HOME ?? "", "config.toml"),
    );
    const adapter = new CodexAppServerAdapter();
    await proveProtocol("codex", "codex", process.cwd(), () =>
      adapter.connect({
        provider: "codex",
        executable,
        argv: [],
        cwd: process.cwd(),
        env: environment(),
      }),
    );
  },
  300_000,
);

test.skipIf(!LIVE)(
  "claude usage reaches attribution losslessly",
  async () => {
    const executable = requireExecutable("Claude", which("claude"));
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CREDENTIAL_FILE",
      join(process.env.HOME ?? "", ".claude", ".credentials.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CONFIG_FILE",
      join(process.env.HOME ?? "", ".claude.json"),
    );
    const adapter = new ClaudeStreamJsonAdapter({});
    await proveProtocol(
      "claude",
      "claude",
      process.cwd(),
      () =>
        adapter.connect({
          provider: "claude",
          executable,
          argv: ["--model", "haiku", "--permission-mode", "default"],
          cwd: process.cwd(),
          env: environment(),
        }),
      "haiku",
    );
  },
  300_000,
);

/**
 * A turn that calls a tool produces several assistant messages, and the
 * transcript bills each one separately while the protocol reports one settled
 * total for the turn. Milestone 5 deletes the transcript scanner, so the two
 * have to agree on a tool loop and not just on a single reply.
 */
test.skipIf(!LIVE)(
  "claude usage stays lossless across a multi-message tool turn",
  async () => {
    const executable = requireExecutable("Claude", which("claude"));
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CREDENTIAL_FILE",
      join(process.env.HOME ?? "", ".claude", ".credentials.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CONFIG_FILE",
      join(process.env.HOME ?? "", ".claude.json"),
    );
    const adapter = new ClaudeStreamJsonAdapter({});
    await proveProtocol(
      "claude-tool-loop",
      "claude",
      process.cwd(),
      () =>
        adapter.connect({
          provider: "claude",
          executable,
          argv: [
            "--model",
            "haiku",
            "--permission-mode",
            "default",
            "--allowedTools",
            "Glob",
          ],
          cwd: process.cwd(),
          env: environment(),
        }),
      "haiku",
      "Use the Glob tool to list *.json files in this directory, then reply DONE.",
    );
  },
  300_000,
);

test.skipIf(!LIVE)(
  "grok usage reaches attribution losslessly",
  async () => {
    const executable = requireExecutable("Grok", which("grok"));
    requireStagedLiveFile(
      "HIVE_LIVE_GROK_AUTH_FILE",
      join(process.env.GROK_HOME ?? "", "auth.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_GROK_CONFIG_FILE",
      join(process.env.GROK_HOME ?? "", "config.toml"),
    );
    const adapter = new GrokAcpAdapter();
    await proveProtocol("grok", "grok", process.cwd(), () =>
      adapter.connect(grokAcpSpawn(executable, process.cwd())),
    );
  },
  300_000,
);
