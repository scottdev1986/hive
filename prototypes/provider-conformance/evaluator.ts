import type {
  AdapterRun,
  AssertionResult,
  EventType,
  NormalizedEvent,
  ScenarioResult,
} from "./types";

function has(events: NormalizedEvent[], type: EventType): boolean {
  return events.some((event) => event.type === type);
}

function find(events: NormalizedEvent[], type: EventType): NormalizedEvent | undefined {
  return events.find((event) => event.type === type);
}

function assertion(id: string, pass: boolean, detail: string): AssertionResult {
  return { id, pass, detail };
}

function lifecycleAssertions(run: AdapterRun): AssertionResult[] {
  return [
    assertion("session-started", has(run.events, "session.started"), "A structured session start was emitted."),
    assertion("model-reported", has(run.events, "model.reported"), "The provider reported the effective model."),
    assertion("turn-started", has(run.events, "turn.started"), "A structured turn start was emitted."),
    assertion("turn-completed", has(run.events, "turn.completed"), "A successful terminal turn event was emitted."),
  ];
}

export function evaluate(run: AdapterRun): ScenarioResult {
  const events = run.events;
  let assertions: AssertionResult[];

  switch (run.scenario) {
    case "lifecycle":
      assertions = lifecycleAssertions(run);
      break;
    case "approve": {
      const marker = find(events, "marker.observed");
      assertions = [
        assertion("approval-requested", has(events, "approval.requested"), "A correlated approval request was surfaced."),
        assertion(
          "approval-approved",
          events.some((event) => event.type === "approval.responded" && event.decision === "approve"),
          "The request received an explicit approve response.",
        ),
        assertion("approved-write-executed", marker?.exists === true && marker.content === "HIVE_APPROVED", "Only the approved marker contents exist."),
        assertion("turn-completed", has(events, "turn.completed"), "The turn reached a structured terminal state."),
      ];
      break;
    }
    case "deny": {
      const marker = find(events, "marker.observed");
      assertions = [
        assertion("approval-requested", has(events, "approval.requested"), "A correlated approval request was surfaced."),
        assertion(
          "approval-denied",
          events.some((event) => event.type === "approval.responded" && event.decision === "deny"),
          "The request received an explicit deny response.",
        ),
        assertion("denied-write-absent", marker?.exists === false, "The denied marker was not created."),
        assertion("denial-observed", has(events, "tool.denied"), "The provider reported the denied tool outcome."),
      ];
      break;
    }
    case "needs-user":
      assertions = [
        assertion("user-input-requested", has(events, "user-input.requested"), "A structured needs-user request was surfaced."),
        assertion("user-input-answered", has(events, "user-input.responded"), "The request was answered through the control channel."),
        assertion(
          "answer-observed",
          events.some((event) => event.type === "turn.completed" && event.text?.includes("HIVE_USER_CHOICE:Alpha") === true),
          "The completed response incorporated the supplied answer.",
        ),
      ];
      break;
    case "steer":
      assertions = [
        assertion("turn-started", has(events, "turn.started"), "The original turn was active."),
        assertion("steer-accepted", has(events, "steer.accepted"), "The provider acknowledged the steer for the active turn."),
        assertion(
          "steer-applied",
          events.some((event) => event.type === "turn.completed" && event.text?.includes("HIVE_STEERED_OK") === true),
          "The final result reflects the steered instruction.",
        ),
      ];
      break;
    case "cancel":
      assertions = [
        assertion(
          "cancel-receipt",
          events.some((event) => event.type === "cancel.receipt" && event.receipt === true),
          "The cancel command received a protocol acknowledgement.",
        ),
        assertion("cancel-terminal", has(events, "turn.cancelled"), "The same turn reached a structured cancelled/interrupted terminal state."),
        assertion(
          "no-false-completion",
          !events.some((event) => event.type === "turn.completed" && event.text?.includes("HIVE_CANCEL_FAILED") === true),
          "The cancelled turn did not report the forbidden success sentinel.",
        ),
      ];
      break;
    case "resume": {
      const resumed = find(events, "session.resumed");
      assertions = [
        assertion("durable-session-id", typeof resumed?.resumedFrom === "string" && resumed.resumedFrom.length > 0, "Resume used the provider's recorded durable session id."),
        assertion("resume-acknowledged", has(events, "session.resumed"), "The provider acknowledged native resume."),
        assertion(
          "resume-context",
          events.some((event) => event.type === "turn.completed" && event.text?.includes("HIVE_RESUME_OK:HIVE_RESUME_ANCHOR") === true),
          "The resumed turn retained prior conversation context.",
        ),
      ];
      break;
    }
    case "invalid-model": {
      const reported = events.filter((event) => event.type === "model.reported");
      assertions = [
        assertion("validation-only", has(events, "validation.started") && !run.realTaskStarted, "Only the validation sentinel was accepted; no real task started."),
        assertion("invalid-model-rejected", has(events, "validation.rejected") || has(events, "model.rejected"), "The invalid concrete pin failed closed."),
        assertion("no-fallback-configured", !run.fallbackConfigured, "No fallback model option was configured."),
        assertion("no-substitution", !has(events, "model.substituted") && reported.every((event) => event.model === run.invalidModel), "No different effective model was reported."),
      ];
      if (run.provider === "claude") {
        assertions.push(assertion("zero-observed-cost", run.cost.observedUsd === 0, "Claude reported total_cost_usd = 0 for the rejected validation turn."));
      }
      break;
    }
    case "read-only": {
      const marker = find(events, "marker.observed");
      assertions = [
        assertion(
          "read-only-policy",
          events.some((event) => event.type === "policy.reported" && event.status === "read-only"),
          "The provider structurally reported the effective read-only policy.",
        ),
        assertion("read-only-marker-absent", marker?.exists === false, "The read-only marker was not created."),
        assertion(
          "no-approval-escalation",
          !events.some((event) => event.type === "approval.responded" && event.decision === "approve"),
          "The read-only run never widened authority through approval.",
        ),
      ];
      break;
    }
    case "dual-client":
      assertions = [
        assertion(
          "tui-attached",
          events.some((event) => event.type === "client.attached" && event.status === "tui"),
          "The interactive Codex TUI attached to the app-server thread.",
        ),
        assertion(
          "second-client-subscribed",
          events.some((event) => event.type === "client.subscribed" && event.status === "protocol"),
          "A second JSON-RPC connection resumed the same durable thread.",
        ),
        assertion("steer-accepted", has(events, "steer.accepted"), "The second connection acknowledged the active-turn steer."),
        assertion(
          "history-injected",
          has(events, "input.injected"),
          "The second connection acknowledged model-visible history injection on the shared thread.",
        ),
        assertion(
          "shared-thread-result",
          events.some((event) =>
            event.type === "client.observed" &&
            event.status === "tui" &&
            event.text?.includes("HIVE_INJECT_SEEN") === true
          ),
          "The attached TUI observed the verification result that depended on injected shared history.",
        ),
      ];
      break;
  }

  return {
    ...run,
    assertions,
    outcome: assertions.every((item) => item.pass) ? "pass" : "fail",
  };
}
