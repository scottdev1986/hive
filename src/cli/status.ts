import type { AgentRecord } from "../schemas";

const TASK_WIDTH = 48;

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
  ]);
  const headers = ["NAME", "TOOL", "MODEL", "STATUS", "CONTEXT", "TASK"];
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
