import { describe, expect, test } from "bun:test";
import { parseArgs, requiresBillableAuthorization } from "./run";
import { evaluate } from "./evaluator";
import { expectedCost, INVALID_MODEL, PROMPTS } from "./prompts";
import { redact } from "./transport";
import { compactReport } from "./promote";
import { scenarioApplies, type AdapterRun, type EventType, type NormalizedEvent, type Scenario } from "./types";

let sequence = 0;
function event(type: EventType, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { sequence: ++sequence, at: "2026-07-10T00:00:00.000Z", type, ...extra };
}

function run(scenario: Scenario, events: NormalizedEvent[]): AdapterRun {
  const provider = scenario === "dual-client" ? "codex" : "claude";
  return {
    provider,
    scenario,
    binding: {
      provider,
      requestedPath: "/bin/claude",
      executablePath: "/bin/claude",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      version: "2.1.206",
      probedAt: "2026-07-10T00:00:00.000Z",
      probe: { argv: ["/bin/claude", "--version"], billable: "no", provenance: "docs" },
    },
    selectedModel: "claude-haiku",
    ...(scenario === "invalid-model" ? { invalidModel: INVALID_MODEL } : {}),
    events,
    cost: {
      classification: expectedCost(provider, scenario),
      ...(scenario === "invalid-model" ? { observedUsd: 0 } : {}),
      provenance: ["fixture"],
    },
    fallbackConfigured: false,
    realTaskStarted: scenario !== "invalid-model",
    diagnostics: [],
  };
}

describe("provider-neutral assertions", () => {
  test("passes the structured lifecycle contract", () => {
    const result = evaluate(run("lifecycle", [
      event("session.started"),
      event("model.reported", { model: "claude-haiku" }),
      event("turn.started"),
      event("turn.completed", { text: "HIVE_LIFECYCLE_OK" }),
    ]));
    expect(result.outcome).toBe("pass");
  });

  test("keeps approve and deny mechanically distinct", () => {
    expect(evaluate(run("approve", [
      event("approval.requested"),
      event("approval.responded", { decision: "approve" }),
      event("marker.observed", { exists: true, content: "HIVE_APPROVED" }),
      event("turn.completed"),
    ])).outcome).toBe("pass");
    expect(evaluate(run("deny", [
      event("approval.requested"),
      event("approval.responded", { decision: "deny" }),
      event("tool.denied"),
      event("marker.observed", { exists: false }),
    ])).outcome).toBe("pass");
  });

  test("requires an acknowledged cancel and terminal interrupted state", () => {
    const missingReceipt = evaluate(run("cancel", [event("turn.cancelled") ]));
    expect(missingReceipt.outcome).toBe("fail");
    expect(missingReceipt.assertions.find((item) => item.id === "cancel-receipt")?.pass).toBe(false);
    expect(evaluate(run("cancel", [
      event("cancel.receipt", { receipt: true }),
      event("turn.cancelled"),
    ])).outcome).toBe("pass");
  });

  test("requires native durable resume context", () => {
    expect(evaluate(run("resume", [
      event("session.resumed", { resumedFrom: "session-1" }),
      event("turn.completed", { text: "HIVE_RESUME_OK:HIVE_RESUME_ANCHOR" }),
    ])).outcome).toBe("pass");
  });

  test("requires invalid pin rejection before a real task with zero observed Claude cost", () => {
    expect(evaluate(run("invalid-model", [
      event("validation.started", { model: INVALID_MODEL, validationOnly: true }),
      event("model.reported", { model: INVALID_MODEL }),
      event("model.rejected", { model: INVALID_MODEL }),
      event("validation.rejected", { model: INVALID_MODEL, validationOnly: true }),
    ])).outcome).toBe("pass");
  });

  test("requires a denial and absent marker for read-only", () => {
    expect(evaluate(run("read-only", [
      event("policy.reported", { status: "read-only" }),
      event("tool.denied"),
      event("marker.observed", { exists: false }),
    ])).outcome).toBe("pass");
  });

  test("requires the attached TUI to observe history injected by the second client", () => {
    const result = evaluate({
      ...run("dual-client", [
        event("client.attached", { status: "tui" }),
        event("client.subscribed", { status: "protocol" }),
        event("steer.accepted"),
        event("input.injected"),
        event("client.observed", { status: "tui", text: "HIVE_INJECT_SEEN" }),
      ]),
      provider: "codex",
      cost: { classification: "billable", provenance: ["fixture"] },
    });
    expect(result.outcome).toBe("pass");
    expect(evaluate({
      ...result,
      events: result.events.filter((entry) => entry.type !== "client.observed"),
    }).outcome).toBe("fail");
  });
});

describe("billing and probe safety", () => {
  test("classifies every real scenario as billable and does not generalize Claude invalid cost to Codex", () => {
    for (const scenario of Object.keys(PROMPTS) as Scenario[]) {
      if (scenario !== "invalid-model") {
        for (const provider of ["claude", "codex"] as const) {
          if (scenarioApplies(provider, scenario)) {
            expect(expectedCost(provider, scenario)).toBe("billable");
          }
        }
      }
    }
    expect(expectedCost("claude", "invalid-model")).toBe("non-billable");
    expect(expectedCost("codex", "invalid-model")).toBe("unknown");
  });

  test("refuses live billable and cost-unknown scenarios without the explicit flag", () => {
    const options = parseArgs(["--live", "--provider", "codex", "--scenario", "invalid-model"]);
    expect(requiresBillableAuthorization(options)).toEqual(["codex/invalid-model:unknown"]);
    expect(parseArgs(["--dry-run"]).mode).toBe("dry-run");
  });

  test("redacts credentials and account identity recursively", () => {
    expect(redact({
      account: { email: "person@example.com", organization: "Acme" },
      authorization: "Bearer secret",
      safe: "visible",
    })).toEqual({
      account: { email: "[REDACTED]", organization: "[REDACTED]" },
      authorization: "[REDACTED]",
      safe: "visible",
    });
  });

  test("refuses to promote a partial or red live report", () => {
    expect(() => compactReport({ live: true, results: [] } as any)).toThrow(
      "Promotion requires one complete live all-provider run",
    );
  });
});
