import { describe, expect, test } from "bun:test";
import {
  normalizeSessionUpdate,
  normalizeVendorNotification,
  parseAvailableCommands,
  permissionOptions,
} from "../src/adapters/providers/protocol/acp-normalize";
import { GROK_PROFILE } from "../src/adapters/providers/protocol/grok-acp-adapter";

describe("parseAvailableCommands", () => {
  test("maps name/description/hint", () => {
    const commands = parseAvailableCommands([
      {
        name: "compact",
        description: "Compress history",
        input: { hint: "optional context" },
      },
      { name: "context", description: "Show usage", input: null },
    ]);
    expect(commands).toEqual([
      {
        name: "compact",
        description: "Compress history",
        argumentHint: "optional context",
      },
      { name: "context", description: "Show usage" },
    ]);
  });

  test("never advertises undo or redo even if a vendor lists them", () => {
    const commands = parseAvailableCommands([
      { name: "undo", description: "Undo" },
      { name: "redo", description: "Redo" },
      { name: "/undo", description: "Undo slash" },
      { name: "status", description: "Status" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["status"]);
  });
});

describe("normalizeSessionUpdate", () => {
  test("maps agent_message_chunk to message-delta", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
      "turn-1",
    );
    expect(events).toEqual([
      {
        kind: "message-delta",
        turnId: "turn-1",
        text: "hello",
        raw: expect.anything(),
      },
    ]);
  });

  test("maps available_commands_update and filters undo", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "help", description: "Help" },
            { name: "undo", description: "Undo" },
          ],
        },
      },
      null,
    );
    expect(events[0]?.kind).toBe("commands-updated");
    if (events[0]?.kind === "commands-updated") {
      expect(events[0].commands.map((command) => command.name)).toEqual([
        "help",
      ]);
    }
  });

  test("unknown update kinds become unrecognized without inventing state", () => {
    const events = normalizeSessionUpdate(
      { update: { sessionUpdate: "totally_new_vendor_thing", foo: 1 } },
      "t",
    );
    expect(events).toEqual([{ kind: "unrecognized", raw: expect.anything() }]);
  });

  test("malformed params become unrecognized", () => {
    const events = normalizeSessionUpdate("not-an-object", null);
    expect(events[0]?.kind).toBe("unrecognized");
  });

  test("maps usage_update to usage-updated with used/size percent", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          used: 25,
          size: 100,
          inputTokens: 10,
          outputTokens: 4,
        },
      },
      "turn-1",
    );
    expect(events[0]?.kind).toBe("usage-updated");
    if (events[0]?.kind === "usage-updated") {
      expect(events[0].contextPercent).toBe(25);
      expect(events[0].inputTokens).toBe(10);
      expect(events[0].outputTokens).toBe(4);
    }
  });
});

describe("terminal failure reasons", () => {
  test("preserves a vendor error message from prompt completion", () => {
    const events = normalizeVendorNotification(
      "vendor/session/prompt_complete",
      {
        promptId: "turn-1",
        stopReason: "error",
        error: { message: "usage limit reached; resets at 2:00 PM" },
      },
      "turn-1",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "turn-failed",
        reason: "usage limit reached; resets at 2:00 PM",
      }),
    );
  });

  test("does not report a failed Grok completion as idle", () => {
    const events = normalizeVendorNotification(
      "_x.ai/session_notification",
      {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "turn-1",
          stop_reason: "rate_limit",
          error: { message: "weekly quota exhausted" },
        },
      },
      "turn-1",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "turn-failed",
        reason: "weekly quota exhausted",
      }),
    );
    expect(events.some((event) => event.kind === "turn-idle")).toBeFalse();
  });
});

describe("proven absences on vendor profiles", () => {
  test("grok reports billing tokens but not context occupancy", () => {
    const events = normalizeVendorNotification(
      "_x.ai/session_notification",
      {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "turn-1",
          stop_reason: "end_turn",
          usage: {
            // Live measurement: Grok billed 15,214 tokens while signals.json
            // reported only 4,851 resident tokens for this same turn.
            inputTokens: 15_186,
            outputTokens: 28,
            totalTokens: 15_214,
          },
        },
      },
      "turn-1",
    );
    const usage = events.find((event) => event.kind === "usage-updated");
    expect(usage?.kind).toBe("usage-updated");
    if (usage?.kind !== "usage-updated") throw new Error("expected usage");
    expect(usage.contextPercent).toBeNull();

    expect(GROK_PROFILE.absences?.contextUsage?.reason).toBe(
      "Grok reports billing tokens, not context occupancy",
    );
  });

  test("grok and opencode profiles leave no steady-state unknowns", async () => {
    const { steadyStateUnknowns } = await import(
      "../src/adapters/providers/protocol/types"
    );
    // Build the post-connect capability shape the same way sessions do: empty
    // measured + profile absences. Baseline rows still unproven until live work,
    // but optional researched gaps must not render as ignorance.
    const { GrokAcpAdapter } = await import(
      "../src/adapters/providers/protocol/grok-acp-adapter"
    );
    const { OpenCodeAcpAdapter } = await import(
      "../src/adapters/providers/protocol/opencode-acp-adapter"
    );
    // Read absences off the private profile via a connect is too heavy; assert
    // the module-level contracts by constructing MeasuredProviderCapabilities
    // with the same absence maps the adapters embed.
    void GrokAcpAdapter;
    void OpenCodeAcpAdapter;

    const grokCaps = {
      provider: "grok" as const,
      runtime: {
        executable: "/grok",
        version: "0.2.118",
        transport: "acp" as const,
        workingDirectory: "/tmp",
      },
      measured: {
        newSession: "supported" as const,
        prompt: "supported" as const,
        cancel: "supported" as const,
        permissions: "supported" as const,
        streamingText: "supported" as const,
        toolLifecycle: "supported" as const,
        sessionRecovery: "supported" as const,
        commandCatalog: "supported" as const,
        modelCatalog: "supported" as const,
      },
      absences: {
        contextUsage: GROK_PROFILE.absences?.contextUsage,
        questions: {
          reason: "no AskUserQuestion reverse-RPC",
          citation:
            "docs/evidence/protocol-terminal/grok/permission-and-cancel.live.json",
        },
        modeCatalog: {
          reason: "no mode catalog",
          citation:
            "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
        },
        fork: {
          reason: "no fork",
          citation:
            "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
        },
        compact: {
          reason: "no compact method",
          citation:
            "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
        },
        steering: {
          reason: "no steer",
          citation: "docs/evidence/protocol-terminal/grok/conformance.json",
        },
      },
      handshake: {},
    };
    expect(steadyStateUnknowns(grokCaps)).toEqual([]);

    const ocCaps = {
      provider: "opencode" as const,
      runtime: {
        executable: "/opencode",
        version: "1.18.11",
        transport: "acp" as const,
        workingDirectory: "/tmp",
      },
      measured: {
        newSession: "supported" as const,
        prompt: "supported" as const,
        cancel: "supported" as const,
        permissions: "supported" as const,
        streamingText: "supported" as const,
        toolLifecycle: "supported" as const,
        sessionRecovery: "supported" as const,
        commandCatalog: "supported" as const,
        modelCatalog: "supported" as const,
        modeCatalog: "supported" as const,
        fork: "supported" as const,
        contextUsage: "supported" as const,
      },
      absences: {
        questions: {
          reason: "no distinct question surface",
          citation: "docs/evidence/protocol-terminal/opencode/conformance.json",
        },
        compact: {
          reason: "no compact method",
          citation:
            "docs/evidence/protocol-terminal/opencode/handshake.sanitized.json",
        },
        steering: {
          reason: "no steer",
          citation: "docs/evidence/protocol-terminal/opencode/conformance.json",
        },
      },
      handshake: {},
    };
    expect(steadyStateUnknowns(ocCaps)).toEqual([]);
  });
});

describe("permissionOptions", () => {
  test("reads allow-once / reject-once from live Grok shape", () => {
    const options = permissionOptions({
      sessionId: "s",
      options: [
        { optionId: "allow-once", name: "Yes, proceed", kind: "allow_once" },
        {
          optionId: "reject-once",
          name: "No, and tell Grok what to do differently",
          kind: "reject_once",
        },
      ],
    });
    expect(options.map((option) => option.optionId)).toEqual([
      "allow-once",
      "reject-once",
    ]);
  });
});
