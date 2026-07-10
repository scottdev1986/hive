#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConformanceReport,
  EvidenceFact,
  NormalizedEvent,
  ScenarioResult,
} from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEPT_EVENTS = new Set([
  "session.started",
  "session.resumed",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "model.reported",
  "model.rejected",
  "model.substituted",
  "policy.reported",
  "approval.requested",
  "approval.responded",
  "user-input.requested",
  "user-input.responded",
  "steer.accepted",
  "cancel.receipt",
  "client.attached",
  "client.subscribed",
  "client.observed",
  "input.injected",
  "validation.started",
  "validation.rejected",
  "marker.observed",
]);

function keptEvent(event: NormalizedEvent): Record<string, unknown> {
  return {
    type: event.type,
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(event.tool === undefined ? {} : { tool: event.tool }),
    ...(event.decision === undefined ? {} : { decision: event.decision }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.receipt === undefined ? {} : { receipt: event.receipt }),
    ...(event.resumedFrom === undefined ? {} : { resumedViaDurableId: true }),
    ...(event.exists === undefined ? {} : { exists: event.exists }),
    ...(event.content === undefined ? {} : { content: event.content }),
    ...(event.validationOnly === undefined ? {} : { validationOnly: event.validationOnly }),
  };
}

function resultSummary(result: ScenarioResult): Record<string, unknown> {
  return {
    provider: result.provider,
    scenario: result.scenario,
    outcome: result.outcome,
    model: result.selectedModel,
    binding: {
      version: result.binding.version,
      sha256: result.binding.sha256,
    },
    fallbackConfigured: result.fallbackConfigured,
    realTaskStarted: result.realTaskStarted,
    assertions: result.assertions.map(({ id, pass }) => ({ id, pass })),
    events: result.events.filter((event) => KEPT_EVENTS.has(event.type)).map(keptEvent),
    cost: result.cost,
    diagnostics: result.diagnostics,
  };
}

function canonicalFact(fact: EvidenceFact): EvidenceFact {
  return {
    ...fact,
    observed: {
      ...fact.observed,
      provenance: [
        `evidence/driven-run-summary.json#${fact.provider}/${fact.scenario}`,
        ...fact.observed.provenance
          .filter((item) => item.startsWith("binding sha256:")),
      ],
    },
  };
}

function markdown(report: ConformanceReport, facts: EvidenceFact[]): string {
  const rows = facts.map((fact) => {
    const costNote = fact.billable.note === undefined ? "" : ` — ${fact.billable.note}`;
    return `| ${fact.provider} | ${fact.scenario} | ${fact.documented.status} | ${fact.observed.status} | ${fact.billable.status}${costNote} |`;
  }).join("\n");
  const claudeBinding = report.results.find((result) => result.provider === "claude")!.binding;
  const codexBinding = report.results.find((result) => result.provider === "codex")!.binding;
  const claudeSpend = report.results
    .filter((result) => result.provider === "claude")
    .reduce((total, result) => total + (result.cost.observedUsd ?? 0), 0);

  return `# Provider conformance evidence

This matrix separates three questions that are easy to blur: whether a provider publishes a contract, whether this exact executable generation produced the behavior, and whether obtaining the observation consumes provider capacity. The canonical driven run was \`${report.runId}\`, from ${report.startedAt} through ${report.completedAt}. All ${report.results.length} applicable provider/scenario facts passed their assertions.

The bindings were Claude Code \`${claudeBinding.version}\` at SHA-256 \`${claudeBinding.sha256}\`, pinned for real turns to \`${report.results.find((result) => result.provider === "claude")!.selectedModel}\`; and Codex \`${codexBinding.version}\` at SHA-256 \`${codexBinding.sha256}\`, pinned to \`${report.results.find((result) => result.provider === "codex")!.selectedModel}\`. Claude reported $${claudeSpend.toFixed(6)} across the complete run, including exactly $0 for invalid-model validation. Codex reported per-turn token usage but no currency amount; its invalid-model turn emitted no token-usage update, which is insufficient to claim a general zero-cost guarantee.

| Provider | Scenario | Documented | Observed | Billable |
|---|---|---:|---:|---|
${rows}

## What the compact table hides

Claude's public CLI reference documents \`--permission-prompt-tool\`, correcting the blueprint's former statement that the flag itself is undocumented. The low-level \`stdio\` target that makes raw stream-json approval control work is still absent from that reference; the pinned binary and driven frames prove it. The matrix therefore calls cancel and invalid-model documentation partial where receipt or cost semantics still depend on observation.

Codex needs-user is not available to an ordinary default turn merely because \`item/tool/requestUserInput\` appears in the server-request schema. The first drive produced the expected answer without any request—the model chose for the user. The passing drive initializes with \`experimentalApi\` and starts the turn in experimental \`collaborationMode: plan\`, whose binding-generated schema exposes the native request-user-input tool.

Codex read-only enforcement passed mechanically: \`thread/start\` reported the effective \`readOnly\` sandbox and the forbidden marker did not exist. This binding did not emit a rejected \`fileChange\` item on the JSON event stream; the rejection appeared only on stderr. Hive can trust the structured policy plus its own filesystem check, but should not promise a structured per-tool denial event for this generation.

Codex dual-client is a provider-specific extension rather than a fake Claude equivalent. One WebSocket app-server owns the thread; the interactive TUI resumes it through \`--remote\`, and a second JSON-RPC connection resumes the same durable ID. The gate requires a correlated steer receipt, accepted \`thread/inject_items\`, a verification response that depends on the injected history, and that response appearing in the attached TUI.

## Provenance

The committed [driven run summary](evidence/driven-run-summary.json) contains the binding hashes, assertions, normalized event kinds, and billing observations without account identity, absolute paths, prompts, or raw model output. Raw redacted JSONL remains local and gitignored because even a redacted protocol trace contains machine-specific paths and unnecessary transcript material.

Documentation provenance is attached to every fact in [the machine-readable matrix](evidence/evidence-matrix.json). The primary contracts are the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Claude CLI reference](https://code.claude.com/docs/en/cli-usage), [Claude streaming-input guide](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Claude approvals and user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input), and the repository's [driven cross-vendor review](../../research/cross-vendor-architecture-review.md).
`;
}

export function compactReport(report: ConformanceReport) {
  if (!report.live || !Array.isArray(report.providers) || !Array.isArray(report.scenarios)) {
    throw new Error("Promotion requires one complete live all-provider run");
  }
  const expectedCount = report.providers.reduce(
    (count, provider) => count + report.scenarios.filter((scenario) =>
      provider === "codex" || scenario !== "dual-client"
    ).length,
    0,
  );
  if (!Array.isArray(report.results) || report.results.length !== expectedCount) {
    throw new Error(`Promotion requires one complete live all-provider run (${expectedCount} results)`);
  }
  const failed = report.results.filter((result) => result.outcome !== "pass");
  if (failed.length > 0) {
    throw new Error(`Cannot promote a red run: ${failed.map((result) => `${result.provider}/${result.scenario}`).join(", ")}`);
  }
  return {
    schemaVersion: 1,
    runId: report.runId,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    live: report.live,
    billableExecutionAuthorized: report.billableExecutionAuthorized,
    providers: report.providers,
    scenarios: report.scenarios,
    results: report.results.map(resultSummary),
    notes: [
      "Claude permission control used the binding-observed stdio target; the public flag is documented but this low-level target is not.",
      "Codex needs-user required experimentalApi plus collaborationMode plan; default mode fabricated the expected answer without requesting input.",
      "Codex read-only returned a structured readOnly policy and left the marker absent, but emitted the rejected patch only on stderr, not as a fileChange item.",
      "Codex invalid-model cost remains unknown: the turn failed with unsupported-model and no token update, but app-server supplied no currency receipt or zero-cost contract.",
      "Codex dual-client is binding-specific: the TUI and a second JSON-RPC client must resume one durable thread, accept a steer and model-visible history injection, and render the history-dependent result in the TUI.",
    ],
  };
}

async function main(): Promise<void> {
  const reportPath = process.argv[2];
  if (reportPath === undefined) {
    throw new Error("Usage: bun run prototypes/provider-conformance/promote.ts <report.json>");
  }
  const report = JSON.parse(await Bun.file(reportPath).text()) as ConformanceReport;
  const evidenceDirectory = join(HERE, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const facts = report.evidence.map(canonicalFact);
  await Promise.all([
    Bun.write(join(evidenceDirectory, "driven-run-summary.json"), `${JSON.stringify(compactReport(report), null, 2)}\n`),
    Bun.write(join(evidenceDirectory, "evidence-matrix.json"), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: report.completedAt,
      runId: report.runId,
      facts,
    }, null, 2)}\n`),
    Bun.write(join(HERE, "EVIDENCE.md"), markdown(report, facts)),
  ]);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
