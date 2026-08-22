import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AcpProviderSession } from "../src/adapters/providers/protocol/acp-session";
import { KimiAcpAdapter } from "../src/adapters/providers/protocol/kimi-acp-adapter";
import {
  capabilityFinding,
  capabilitySupport,
  type NormalizedProviderEvent,
} from "../src/adapters/providers/protocol/types";
import type { JsonObject } from "../src/shared/json";

const SERVER = join(import.meta.dir, "protocol-kimi-fake-server.ts");

function connect(): Promise<AcpProviderSession> {
  const adapter = new KimiAcpAdapter();
  // SAFETY: The test owns this value and its fields.
  return adapter.connect({
    provider: "kimi",
    executable: process.execPath,
    argv: [SERVER],
    cwd: import.meta.dir,
    env: {},
  }) as Promise<AcpProviderSession>;
}

class Collector {
  readonly events: NormalizedProviderEvent[] = [];
  private readonly reader: Promise<void>;

  constructor(session: AcpProviderSession) {
    this.reader = (async () => {
      for await (const event of session.events) this.events.push(event);
    })();
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }

  async waitFor(
    predicate: (events: NormalizedProviderEvent[]) => boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.events)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out; saw ${this.kinds().join(",")}`);
  }

  async stop(): Promise<void> {
    await Promise.race([this.reader, new Promise((r) => setTimeout(r, 300))]);
  }
}

describe("kimi acp adapter", () => {
  test("connect emits runtime-ready and records the handshake verbatim", async () => {
    const session = await connect();
    const seen = new Collector(session);
    await seen.waitFor((e) => e.some((x) => x.kind === "runtime-ready"));
    expect(session.capabilities.provider).toBe("kimi");
    expect(session.capabilities.runtime.transport).toBe("acp");
    expect(session.capabilities.runtime.version).toBe("0.31.1");
    // SAFETY: The test owns this value and its fields.
    const handshake = session.capabilities.handshake as {
      agentInfo?: { name?: string };
    };
    expect(handshake.agentInfo?.name).toBe("Kimi Code CLI");
    // Baseline rows start unmeasured: handshake alone proves nothing.
    expect(capabilitySupport(session.capabilities, "prompt")).toBe("unknown");
    expect(capabilityFinding(session.capabilities, "contextUsage")).toEqual({
      state: "not-reported",
      absence: {
        reason: "Kimi does not report context usage",
        citation:
          "docs/evidence/protocol-terminal/kimi/conformance.json — 517 events, no usage update kind; initialize agentCapabilities carry no usage surface",
      },
    });
    await session.close();
    await seen.stop();
  });

  test("newSession measures catalogs from configOptions and lists commands", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    expect(created.vendorSessionId).toBe(
      "session_00000000-0000-4000-8000-000000000001",
    );
    expect(created.replayedHistory).toBe(false);
    await seen.waitFor((e) => e.some((x) => x.kind === "commands-updated"));
    const commands = await session.listCommands();
    expect(commands.map((c) => c.name)).toContain("compact");
    expect(commands.map((c) => c.name)).toContain("usage");
    expect(capabilitySupport(session.capabilities, "newSession")).toBe(
      "supported",
    );
    expect(capabilitySupport(session.capabilities, "commandCatalog")).toBe(
      "supported",
    );
    expect(capabilitySupport(session.capabilities, "modelCatalog")).toBe(
      "supported",
    );
    expect(capabilitySupport(session.capabilities, "modeCatalog")).toBe(
      "supported",
    );
    expect(session.permissionModes).toEqual([
      "default",
      "plan",
      "auto",
      "yolo",
    ]);
    expect(
      seen.events.find(
        (event) => event.kind === "config-updated" && event.mode === "auto",
      ),
    ).toMatchObject({ kind: "config-updated", mode: "auto" });
    await session.close();
    await seen.stop();
  });

  test("submit streams thought and message deltas and ends idle", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    const receipt = await session.submit({
      session: created,
      clientInputId: "unit-prompt",
      text: "Reply with exactly: PONG",
    });
    expect(receipt.outcome).toBe("accepted");
    // The prompt resolves after the deltas stream; drain before asserting.
    await seen.waitFor((e) => e.some((x) => x.kind === "message-delta"));
    const kinds = seen.kinds();
    expect(kinds).toContain("thought-delta");
    expect(kinds).toContain("message-delta");
    expect(kinds).toContain("turn-idle");
    const delta = seen.events.find((e) => e.kind === "message-delta");
    expect(delta && "text" in delta ? delta.text : null).toBe("PONG");
    expect(capabilitySupport(session.capabilities, "prompt")).toBe("supported");
    expect(capabilitySupport(session.capabilities, "streamingText")).toBe(
      "supported",
    );
    await session.close();
    await seen.stop();
  });

  test("the first prompt carries newSession instruction; the second does not", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({
      cwd: import.meta.dir,
      instruction: [
        "## Identity and proof",
        "successionId: qsc_test_capsule",
        "targetGeneration: 3",
      ].join("\n"),
    });
    await session.submit({
      session: created,
      clientInputId: "capsule-kickoff",
      text: "repeat-prompt Follow your boot capsule.",
    });
    await seen.waitFor((e) => e.some((x) => x.kind === "message-delta"));
    const first = seen.events.find((e) => e.kind === "message-delta");
    const firstText = first && "text" in first ? first.text : "";
    expect(firstText).toContain("successionId: qsc_test_capsule");
    expect(firstText).toContain("targetGeneration: 3");
    expect(firstText).toContain("repeat-prompt Follow your boot capsule.");

    await session.submit({
      session: created,
      clientInputId: "later-turn",
      text: "repeat-prompt later",
    });
    await seen.waitFor(
      (e) => e.filter((x) => x.kind === "message-delta").length >= 2,
    );
    const second = seen.events.filter((e) => e.kind === "message-delta").at(-1);
    const secondText = second && "text" in second ? second.text : "";
    expect(secondText).toBe("repeat-prompt later");
    expect(secondText).not.toContain("qsc_test_capsule");
    await session.close();
    await seen.stop();
  });

  test("a failed ACP prompt surfaces the child vendor diagnostic safely", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    const receipt = await session.submit({
      session: created,
      clientInputId: "unit-stderr-failure",
      text: "trigger stderr-failure",
    });

    expect(receipt.outcome).toBe("rejected");
    expect(
      receipt.detail?.startsWith("HTTP 402: build balance exhausted"),
    ).toBe(true);
    expect(receipt.detail).toContain("token=[REDACTED]");
    expect(receipt.detail).toContain("credential=[REDACTED]");
    expect(receipt.detail).toContain("authorization: [REDACTED]");
    expect(receipt.detail).toContain("ACP error: synthetic RPC failure");
    expect(receipt.detail).not.toContain("vendor-secret-value");
    expect(receipt.detail).not.toContain("/Users/example");
    expect(receipt.detail).not.toContain("short-token");
    expect(receipt.detail).not.toContain(String.fromCharCode(27));
    await seen.waitFor((events) =>
      events.some(
        (event) =>
          event.kind === "turn-failed" && event.reason === receipt.detail,
      ),
    );

    await session.close();
    await seen.stop();
  });

  test("ACP stderr keeps only bounded recent lines and never stains the next turn", async () => {
    const session = await connect();
    const created = await session.newSession({ cwd: import.meta.dir });
    const chatty = await session.submit({
      session: created,
      clientInputId: "unit-chatty-stderr",
      text: "trigger chatty-stderr",
    });

    expect(chatty.outcome).toBe("rejected");
    expect(chatty.detail).not.toContain("vendor diagnostic 3");
    expect(chatty.detail).toContain("vendor diagnostic 4");
    expect(chatty.detail).toContain("vendor diagnostic 11");
    expect(chatty.detail).toContain("…\nACP error: chatty RPC failure");
    expect(chatty.detail?.split("\n")).toHaveLength(9);

    const empty = await session.submit({
      session: created,
      clientInputId: "unit-empty-stderr",
      text: "trigger empty-rpc-error",
    });
    expect(empty.outcome).toBe("rejected");
    expect(empty.detail).toBe("empty RPC failure");

    await session.close();
  });

  test("permission request settles allow through the reverse-RPC", async () => {
    const session = await connect();
    const seen = new Collector(session);
    // "default" is the only mode that asks, and the adapter no longer opens a
    // session in it, so the reverse-RPC path has to be asked for by name.
    const created = await session.newSession({
      cwd: import.meta.dir,
      mode: "default",
    });
    const submit = session.submit({
      session: created,
      clientInputId: "unit-perm",
      text: "run echo fixture",
    });
    await seen.waitFor((e) => e.some((x) => x.kind === "approval-waiting"));
    const waiting = seen.events.find((e) => e.kind === "approval-waiting");
    if (!waiting || !("requestId" in waiting)) throw new Error("no requestId");
    expect("toolName" in waiting ? waiting.toolName : null).toBe("Bash");
    // A question-shaped wait must not appear for a permission request.
    expect(seen.kinds()).not.toContain("question-waiting");
    await session.respondToPermission({
      requestId: waiting.requestId,
      outcome: "allow",
    });
    await session.respondToPermission({
      requestId: waiting.requestId,
      outcome: "allow",
    });
    const receipt = await submit;
    expect(receipt.outcome).toBe("accepted");
    const settled = seen.events.find((e) => e.kind === "elicitation-settled");
    expect(settled && "outcome" in settled ? settled.outcome : null).toBe(
      "allow",
    );
    expect(capabilitySupport(session.capabilities, "permissions")).toBe(
      "supported",
    );
    await session.close();
    await seen.stop();
  });

  test("a tool call raises no approval, because the session opens autonomous", async () => {
    const session = await connect();
    const seen = new Collector(session);
    // No mode named: this is exactly how a spawned agent opens its session.
    const created = await session.newSession({ cwd: import.meta.dir });
    const receipt = await session.submit({
      session: created,
      clientInputId: "unit-autonomous",
      text: "run echo fixture",
    });
    expect(receipt.outcome).toBe("accepted");
    await seen.waitFor((e) => e.some((x) => x.kind === "turn-idle"));
    expect(seen.kinds()).not.toContain("approval-waiting");
    // Nothing was answered on the user's behalf — nothing was ever asked.
    expect(seen.kinds()).not.toContain("elicitation-settled");
    expect(capabilitySupport(session.capabilities, "permissions")).toBe(
      "unknown",
    );
    await session.close();
    await seen.stop();
  });

  test("AskUserQuestion arrives as a question, answered as answered", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    const submit = session.submit({
      session: created,
      clientInputId: "unit-question",
      text: "Use AskUserQuestion to ask alpha or beta",
    });
    await seen.waitFor((e) => e.some((x) => x.kind === "question-waiting"));
    // Distinct from permissions even on the shared reverse-RPC primitive.
    expect(seen.kinds()).not.toContain("approval-waiting");
    const waiting = seen.events.find((e) => e.kind === "question-waiting");
    if (!waiting || !("requestId" in waiting)) throw new Error("no requestId");
    await session.respondToPermission({
      requestId: waiting.requestId,
      outcome: "allow",
      optionId: "q0_opt_1",
    });
    const receipt = await submit;
    expect(receipt.outcome).toBe("accepted");
    const settled = seen.events.find((e) => e.kind === "elicitation-settled");
    expect(settled && "outcome" in settled ? settled.outcome : null).toBe(
      "answered",
    );
    expect(capabilitySupport(session.capabilities, "questions")).toBe(
      "supported",
    );
    // Answering a question must not measure permissions.
    expect(capabilitySupport(session.capabilities, "permissions")).toBe(
      "unknown",
    );
    await session.close();
    await seen.stop();
  });

  test("cancel a running turn observes interrupted", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    const submit = session.submit({
      session: created,
      clientInputId: "unit-cancel",
      text: "write a long essay",
    });
    await seen.waitFor((e) => e.some((x) => x.kind === "turn-started"));
    await session.cancel("unit-cancel");
    const receipt = await submit;
    expect(receipt.outcome).toBe("accepted");
    expect(seen.kinds()).toContain("interrupted");
    expect(capabilitySupport(session.capabilities, "cancel")).toBe("supported");
    await session.close();
    await seen.stop();
  });

  test("load measures replay, resume measures none", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({ cwd: import.meta.dir });
    const loaded = await session.resumeSession({
      vendorSessionId: created.vendorSessionId,
      style: "load",
    });
    expect(loaded.replayedHistory).toBe(true);
    const resumed = await session.resumeSession({
      vendorSessionId: created.vendorSessionId,
      style: "resume",
    });
    expect(resumed.replayedHistory).toBe(false);
    expect(capabilitySupport(session.capabilities, "sessionRecovery")).toBe(
      "supported",
    );
    await session.close();
    await seen.stop();
  });

  test("setConfigOption round-trips through session/set_config_option", async () => {
    const session = await connect();
    const seen = new Collector(session);
    const created = await session.newSession({
      cwd: import.meta.dir,
      mode: "plan",
    });
    // SAFETY: The test owns this value and its fields.
    const result = (await session.setConfigOption(
      "model",
      "kimi-code/k3-256k",
    )) as {
      configOptions: Array<{ id: string; currentValue: string }>;
      recordedParams: JsonObject;
    };
    expect(result.recordedParams).toEqual({
      sessionId: created.vendorSessionId,
      configId: "model",
      value: "kimi-code/k3-256k",
    });
    expect(
      result.configOptions.find((option) => option.id === "model"),
    ).toMatchObject({ currentValue: "kimi-code/k3-256k" });
    await session.close();
    await seen.stop();
  });

  test("permission mode switching reports the mode Kimi applied", async () => {
    const session = await connect();
    const seen = new Collector(session);
    await session.newSession({ cwd: import.meta.dir });

    expect(await session.setPermissionMode("plan")).toBe("plan");
    await seen.waitFor((events) =>
      events.some(
        (event) => event.kind === "config-updated" && event.mode === "plan",
      ),
    );

    await session.close();
    await seen.stop();
  });

  test("close kills the vendor child process group", async () => {
    const session = await connect();
    const seen = new Collector(session);
    await session.newSession({ cwd: import.meta.dir });
    await session.close();
    await seen.waitFor((e) => e.some((x) => x.kind === "run-ended"));
    expect(seen.kinds()).toContain("runtime-disconnected");
    expect(seen.kinds()).toContain("run-ended");
    await seen.stop();
  });
});
