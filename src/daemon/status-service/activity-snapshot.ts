import {
  type ActivitySnapshot,
  type ProviderEvent,
  ActivitySnapshotSchema,
} from "../../schemas/provider-communication";
import type { AgentRecord } from "../../schemas/agent";
import type { ProviderRun } from "../../schemas/provider-run";
import type { SessionInspection } from "../session-host/session-host-contract";
import type { FusedAgentStatus } from "./fusion";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  "g",
);
/** The one secret pattern in this repository. Every producer of RedactedText masks with this and nothing re-masks afterwards: a second, stronger pattern at a single call site is how the brand below came to vouch for less than it promised.

What it does NOT catch, so nobody reads the brand as "no secret can survive this": a value whose variable name is not on the same line, because the name is what identifies it; a variable name this pattern does not list — `HIVE_EMBEDDING_API_KEY`, `GITHUB_TOKEN` and `GH_TOKEN` are read elsewhere in this repository and are deliberately absent, because adding them widens what is masked rather than consolidating what already was; and the tail of a quoted value containing spaces, because `\S+` stops at the first one. */
const SECRET =
  /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|(?:HIVE_CAPABILITY_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|GROK_API_KEY)\s*=\s*\S+)/gi;

declare const redactedTextBrand: unique symbol;

/** Terminal text the redactor has vouched for: escapes stripped, secrets masked. The brand exists so a consumer of pane text can require redaction at the type level — a plain string will not typecheck where RedactedText is demanded, so clipping or quoting cannot accidentally run ahead of the redactor. */
export type RedactedText = string & { readonly [redactedTextBrand]: true };

export function redactTerminalEvidence(value: string): RedactedText {
  // The cast is the vouch the brand stands for: both replacements above are
  // what make the text safe to quote.
  return value
    .replaceAll(ANSI, "")
    .replaceAll(SECRET, "[REDACTED]") as RedactedText;
}

export interface ActivitySnapshotInput {
  agent: AgentRecord;
  run: ProviderRun | null;
  inspection: SessionInspection | null;
  gitPaths: readonly string[];
  events: readonly ProviderEvent[];
  providerEventThrough?: string | null;
  transcriptCompleteness?: "complete" | "gap" | "unknown";
  status: FusedAgentStatus | null;
  observedAt: string;
}

function providerState(
  input: ActivitySnapshotInput,
): ActivitySnapshot["providerState"] {
  if (input.run?.state === "exited") return "exited";
  if (input.agent.status === "control-paused") return "stopped";
  if (input.inspection === null) return "unknown";
  switch (input.inspection.foreground.state) {
    case "managed":
      return input.inspection.foreground.runId === input.run?.runId
        ? "running"
        : "unknown";
    case "shell-idle":
      return "shell-idle";
    case "unmanaged":
      return "unmanaged";
    case "unknown":
      return input.agent.status === "spawning" ? "starting" : "unknown";
  }
}

function turnState(
  status: FusedAgentStatus | null,
): ActivitySnapshot["turnState"] {
  return status?.turnState?.value ?? "unknown";
}

function phase(status: FusedAgentStatus | null): ActivitySnapshot["phase"] {
  switch (status?.report?.phase) {
    case "planning":
      return "planning";
    case "implementing":
      return "editing";
    case "testing":
    case "reviewing":
      return "testing";
    case "blocked":
      return "blocked";
    case "complete":
      return "complete";
    case undefined:
      return "unknown";
  }
}

export function buildActivitySnapshot(
  input: ActivitySnapshotInput,
): ActivitySnapshot {
  const report = input.status?.report;
  const latestEvent = [...input.events]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .at(-1);
  const evidence: ActivitySnapshot["evidence"] = [];
  if (input.run !== null) {
    evidence.push({
      kind: "process",
      ref: `provider-run:${input.run.runId}`,
      observedAt: input.observedAt,
    });
  }
  evidence.push({
    kind: "git",
    ref: `git:${input.agent.branch}:${input.gitPaths.length}`,
    observedAt: input.observedAt,
  });
  if (latestEvent !== undefined) {
    evidence.push({
      kind: "provider-event",
      ref: `provider-event:${latestEvent.eventId}`,
      observedAt: latestEvent.occurredAt,
    });
  }
  if (report !== null && report !== undefined) {
    evidence.push({
      kind: "agent-report",
      ref: `status:${report.source.id}`,
      observedAt: report.observedAt,
    });
  }

  return ActivitySnapshotSchema.parse({
    agentId: input.agent.id,
    providerRunId: input.run?.runId ?? null,
    observedAt: input.observedAt,
    terminalState:
      input.inspection === null
        ? "unknown"
        : input.inspection.presence === "present"
          ? "present"
          : input.inspection.presence === "lost"
            ? "lost"
            : "unknown",
    providerState: providerState(input),
    turnState: turnState(input.status),
    phase: phase(input.status),
    summary: report?.summary ?? null,
    evidence,
    providerEventThrough:
      input.providerEventThrough ?? latestEvent?.eventId ?? null,
    // An uninspectable terminal has written an unknown number of bytes, not zero. Reporting 0 made a session nobody could look at read exactly like one that had produced nothing, which is the difference between a stalled agent and a healthy one nobody happened to be able to see.
    outputThrough: input.inspection?.outputSeq ?? null,
    completeness:
      input.inspection === null
        ? "unknown"
        : !input.inspection.complete || input.transcriptCompleteness === "gap"
          ? "gap"
          : "complete",
  });
}
