import { expectedCost } from "./prompts";
import type {
  EvidenceFact,
  CommonScenario,
  Provider,
  ProvenanceAxis,
  Scenario,
  ScenarioResult,
} from "./types";

const CODEX_DOCS = "https://learn.chatgpt.com/docs/app-server";
const CLAUDE_CLI = "https://code.claude.com/docs/en/cli-usage";
const CLAUDE_STREAM = "https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode";
const CLAUDE_INPUT = "https://code.claude.com/docs/en/agent-sdk/user-input";
const CLAUDE_PERMISSIONS = "https://code.claude.com/docs/en/agent-sdk/permissions";
const REVIEW = "research/cross-vendor-architecture-review.md";

function documented(provider: Provider, scenario: Scenario): ProvenanceAxis {
  if (provider === "codex") {
    if (scenario === "invalid-model") {
      return {
        status: "partial",
        provenance: [CODEX_DOCS, "binding-generated JSON Schema"],
        note: "Model pinning and effective-model reporting are documented; fail-before-turn and validation cost are binding observations, not a general promise.",
      };
    }
    return {
      status: "yes",
      provenance: [CODEX_DOCS, "binding-generated JSON Schema"],
      ...(scenario === "needs-user"
        ? { note: "item/tool/requestUserInput is explicitly experimental and requires initialize.capabilities.experimentalApi." }
        : scenario === "dual-client"
        ? { note: "The public app-server guide documents WebSocket TUI attachment; cross-connection subscription and steering are verified per binding." }
        : {}),
    };
  }

  if (scenario === "dual-client") {
    throw new Error("dual-client evidence applies only to Codex app-server");
  }

  const byScenario: Record<CommonScenario, ProvenanceAxis> = {
    lifecycle: { status: "yes", provenance: [CLAUDE_STREAM, CLAUDE_CLI] },
    approve: { status: "yes", provenance: [CLAUDE_CLI, CLAUDE_INPUT] },
    deny: { status: "yes", provenance: [CLAUDE_CLI, CLAUDE_INPUT] },
    "needs-user": { status: "yes", provenance: [CLAUDE_INPUT] },
    steer: { status: "yes", provenance: [CLAUDE_STREAM, CLAUDE_INPUT] },
    cancel: {
      status: "partial",
      provenance: [CLAUDE_STREAM, REVIEW],
      note: "Interrupt is documented through the Agent SDK; the CLI control-frame receipt token is binding-observed rather than specified on the CLI page.",
    },
    resume: { status: "yes", provenance: [CLAUDE_CLI] },
    "invalid-model": {
      status: "partial",
      provenance: [CLAUDE_CLI, REVIEW],
      note: "Concrete pins and fallback configuration are documented; rejection timing and zero observed cost come from the driven binding repro.",
    },
    "read-only": { status: "yes", provenance: [CLAUDE_PERMISSIONS] },
  };
  return byScenario[scenario];
}

function observed(result: ScenarioResult): ProvenanceAxis {
  const failures = result.assertions.filter((item) => !item.pass).map((item) => item.id);
  return {
    status: result.outcome,
    provenance: [
      result.rawCapturePath ?? `${result.provider}/${result.scenario} normalized events`,
      `binding sha256:${result.binding.sha256}`,
    ],
    ...(failures.length === 0 ? {} : { note: `Failed assertions: ${failures.join(", ")}` }),
  };
}

function billable(result: ScenarioResult): ProvenanceAxis {
  const observed = result.cost.observedUsd;
  return {
    status: result.cost.classification,
    provenance: result.cost.provenance,
    note: observed === undefined
      ? "No provider currency amount was available."
      : `Provider-reported total_cost_usd: ${observed.toFixed(6)}.`,
  };
}

export function evidenceForResults(results: ScenarioResult[]): EvidenceFact[] {
  return results.map((result) => ({
    provider: result.provider,
    scenario: result.scenario,
    documented: documented(result.provider, result.scenario),
    observed: observed(result),
    billable: billable(result),
  }));
}

export function plannedEvidence(provider: Provider, scenario: Scenario): EvidenceFact {
  return {
    provider,
    scenario,
    documented: documented(provider, scenario),
    observed: {
      status: "not-run",
      provenance: [],
      note: "No live scenario result is attached to this plan.",
    },
    billable: {
      status: expectedCost(provider, scenario),
      provenance: ["prototypes/provider-conformance/prompts.ts"],
      note: scenario === "invalid-model" && provider === "codex"
        ? "The validation-only turn is cost-unknown until this binding proves otherwise."
        : undefined,
    },
  };
}
