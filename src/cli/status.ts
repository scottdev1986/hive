import { describeAgentName } from "../schemas";
import type { AgentRecord, QuotaStatus, QuotaWindowStatus } from "../schemas";

const TASK_WIDTH = 48;
const FAILURE_WIDTH = 40;

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function formatStatusTable(agents: AgentRecord[]): string {
  const rows = agents.map((agent) => [
    describeAgentName(agent),
    agent.tool,
    // The model it is *running*, not the one it was spawned with. A user who
    // types `/model` mid-session changes the first and not the second, and the
    // orchestrator reads this table to decide what to route where — so showing
    // the spawn-time intention here is how Hive came to report four agents as
    // running models none of them were.
    agent.liveModel ?? agent.model,
    agent.status,
    // Unknown renders as "—", never as a number and never as 0%. `Math.round(null)`
    // is 0, which is how an agent Hive cannot see came to look like an empty one.
    agent.contextPct === null ? "—" : `${Math.round(agent.contextPct)}%`,
    truncate(agent.taskDescription.replaceAll(/\s+/g, " ").trim(), TASK_WIDTH),
    truncate(
      (agent.failureReason ?? "").replaceAll(/\s+/g, " ").trim(),
      FAILURE_WIDTH,
    ),
  ]);
  const headers = [
    "NAME",
    "TOOL",
    "MODEL",
    "STATUS",
    "CONTEXT",
    "TASK",
    "FAILURE",
  ];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[index]?.length ?? 0),
    )
  );
  return [headers, ...rows]
    .map((row) =>
      row.map((cell, index) =>
        index === row.length - 1
          ? cell
          : cell.padEnd(widths[index] ?? cell.length)
      ).join("  ")
    )
    .join("\n");
}

/**
 * Render one window. A window Hive never measured prints the word `unknown`,
 * and Hive's own in-flight reservation is always marked as the estimate it is.
 * Nothing here can print a capacity number that no provider reported.
 */
function formatQuotaWindow(label: string, window: QuotaWindowStatus): string {
  const unit = window.unit === "percent" ? "%" : "";
  const reserved = `${window.reserved.toFixed(1)}${unit} reserved (est)`;
  const reset = window.resetsAt ?? "unknown";
  const capacity = window.remaining === null || window.allowance === null
    ? "unknown remaining"
    : `${window.remaining.toFixed(1)}${unit} of ${window.allowance.toFixed(1)}${unit} remaining`;
  return `  ${label}: ${capacity}, ${reserved}, reset ${reset} ` +
    `[${window.confidence} from ${window.source}]`;
}

export function formatQuotaStatus(statuses: QuotaStatus[]): string {
  if (statuses.length === 0) return "Quota tracking is disabled.";
  const lines: string[] = [];
  for (const status of statuses) {
    if ("configured" in status) {
      lines.push(
        `${status.provider}/default/${status.model}: LIMITS UNKNOWN — ${status.reason}`,
        `  hive-local estimate only: ${status.reserved.toFixed(1)} reserved, ` +
          `${status.fiveHourRecorded.toFixed(1)} spent by hive in 5h, ` +
          `${status.weeklyRecorded.toFixed(1)} spent by hive in week ` +
          "(not the account's usage)",
      );
      continue;
    }
    const origin = status.overridesDiscovered
      ? "manual override"
      : status.origin;
    const routing = status.routable ? "" : ", informational";
    lines.push(
      `${status.provider}/${status.account}/${status.pool}` +
        `${status.label === null ? "" : ` (${status.label})`} ` +
        `[${origin}${routing}, ${status.freshness}]`,
      formatQuotaWindow("5h", status.fiveHour),
      formatQuotaWindow("week", status.weekly),
    );
  }
  return lines.join("\n");
}
