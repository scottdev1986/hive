import type { AgentRecord, QuotaStatus } from "../schemas";

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
    agent.name,
    agent.tool,
    agent.model,
    agent.status,
    `${Math.round(agent.contextPct)}%`,
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

export function formatQuotaStatus(statuses: QuotaStatus[]): string {
  if (statuses.length === 0) return "Quota tracking is disabled.";
  const lines: string[] = [];
  for (const status of statuses) {
    if ("configured" in status) {
      lines.push(
        `${status.provider}/default/${status.model}: UNCONFIGURED — ${status.reason}; ` +
          `${status.reserved.toFixed(1)} reserved, ` +
          `${status.fiveHourRecorded.toFixed(1)} recorded in 5h, ` +
          `${status.weeklyRecorded.toFixed(1)} recorded in week`,
      );
      continue;
    }
    const fiveReset = status.fiveHour.resetsAt ?? "unknown";
    const weekReset = status.weekly.resetsAt ?? "unknown";
    lines.push(
      `${status.provider}/${status.account}/${status.pool} ` +
        `[${status.confidence}, ${status.freshness}, ${status.source}]`,
      `  5h: ${status.fiveHour.remaining.toFixed(1)}/${status.fiveHour.allowance.toFixed(1)} remaining, ` +
        `${status.fiveHour.reserved.toFixed(1)} reserved, reset ${fiveReset}`,
      `  week: ${status.weekly.remaining.toFixed(1)}/${status.weekly.allowance.toFixed(1)} remaining, ` +
        `${status.weekly.reserved.toFixed(1)} reserved, reset ${weekReset}`,
    );
  }
  return lines.join("\n");
}
