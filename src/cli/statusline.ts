import type { StatuslineReport } from "../schemas";
import { agentFetch } from "./credential";

// Claude Code invokes the configured statusLine command on every render and
// pipes the session JSON to stdin. For Claude.ai subscribers, and only after
// the session's first API response, that JSON carries `rate_limits` with a
// used percentage and reset time per rolling window. Hive forwards it to the
// daemon as a semi-official ("reported") quota observation.
//
// Rejected alternative: the undocumented api.anthropic.com/api/oauth/usage
// endpoint the CLI itself calls. It is not a published contract, it needs the
// OAuth token, and building routing on it would make hive break silently when
// Anthropic changes it. statusLine is a documented input to a documented hook.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseWindow(
  value: unknown,
): { usedPct: number; resetsAt: string | null } | undefined {
  if (!isRecord(value)) return undefined;
  const usedPct = value.used_percentage;
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) {
    return undefined;
  }
  const resetsAt = value.resets_at;
  return {
    usedPct: Math.min(100, Math.max(0, usedPct)),
    resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt)
      ? new Date(resetsAt * 1_000).toISOString()
      : null,
  };
}

/** Extract the subscriber rate-limit block, or null when this session has
 * none (API-key account, third-party provider, or before the first response). */
export function parseStatuslineReport(
  agent: string,
  payload: unknown,
  observedAt: string,
): StatuslineReport | null {
  if (!isRecord(payload)) return null;
  const limits = payload.rate_limits;
  if (!isRecord(limits)) return null;
  const fiveHour = parseWindow(limits.five_hour);
  const sevenDay = parseWindow(limits.seven_day);
  if (fiveHour === undefined && sevenDay === undefined) return null;
  return {
    agent,
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    observedAt,
  };
}

/** Render the status line the user sees in the agent's window. */
export function renderStatusLine(
  agent: string,
  report: StatuslineReport | null,
): string {
  const parts = [`🐝 ${agent}`];
  if (report?.fiveHour !== undefined) {
    parts.push(`5h ${report.fiveHour.usedPct.toFixed(0)}%`);
  }
  if (report?.sevenDay !== undefined) {
    parts.push(`7d ${report.sevenDay.usedPct.toFixed(0)}%`);
  }
  return parts.join(" · ");
}

export type StatuslineFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function postStatuslineReport(
  report: StatuslineReport,
  port: number,
  fetcher: StatuslineFetcher = fetch,
): Promise<void> {
  await fetcher(`http://127.0.0.1:${port}/statusline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(1_000),
  });
}

export async function runStatusline(
  agent: string,
  port: number,
  stdin: string,
  fetcher: StatuslineFetcher = agentFetch(agent),
): Promise<string> {
  let report: StatuslineReport | null = null;
  try {
    report = parseStatuslineReport(
      agent,
      JSON.parse(stdin),
      new Date().toISOString(),
    );
    if (report !== null) await postStatuslineReport(report, port, fetcher);
  } catch {
    // The status line renders on every keystroke; it must never throw into
    // the agent's terminal, and a missed observation is simply a stale one.
  }
  return renderStatusLine(agent, report);
}
