import type {
  ActivitySnapshot,
  AgentRecord,
  ProviderEvent,
  ProviderRun,
} from "../schemas";
import { ActivitySnapshotSchema } from "../schemas";
import type { SessionInspection } from "./session-host/contract";
import type { SessiondOutputObservation } from "./session-host/sessiond-output-observer";
import type { FusedAgentStatus } from "./status-fusion";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  "g",
);
const SECRET =
  /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|HIVE_CAPABILITY_TOKEN=\S+)/gi;

export function redactTerminalEvidence(value: string): string {
  return value.replaceAll(ANSI, "").replaceAll(SECRET, "[REDACTED]");
}

export interface ActivitySnapshotInput {
  agent: AgentRecord;
  run: ProviderRun | null;
  inspection: SessionInspection | null;
  output: SessiondOutputObservation | null;
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
  events: readonly ProviderEvent[],
): ActivitySnapshot["turnState"] {
  const latest = [...events]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .at(-1);
  switch (latest?.kind) {
    case "turn-started":
    case "tool-started":
    case "tool-finished":
    case "compacted":
      return "working";
    case "approval-waiting":
      return "waiting";
    case "turn-idle":
    case "turn-failed":
    case "interrupted":
    case "run-ended":
      return "idle";
    case "run-started":
    case undefined:
      return "unknown";
  }
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
    case undefined:
      return "unknown";
  }
}

function terminalSummary(
  output: SessiondOutputObservation | null,
): string | null {
  const lines = (output?.text ?? "")
    .replaceAll(ANSI, "")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 && line !== all[index - 1]);
  const latest = lines.at(-1);
  if (latest === undefined) return null;
  return `inferred terminal: ${redactTerminalEvidence(latest).slice(0, 200)}`;
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
  if (input.output !== null) {
    evidence.push({
      kind: "terminal-output",
      ref: `terminal:${input.output.locator.sessionId}:${input.output.outputThrough}`,
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
    turnState: turnState(input.events),
    phase: phase(input.status),
    summary: report?.summary ?? terminalSummary(input.output),
    evidence,
    providerEventThrough:
      input.providerEventThrough ?? latestEvent?.eventId ?? null,
    outputThrough: input.output?.outputThrough ?? "0",
    completeness:
      input.inspection === null || input.output === null
        ? "unknown"
        : input.output.completeness === "gap" ||
            input.transcriptCompleteness === "gap"
          ? "gap"
          : "complete",
  });
}
