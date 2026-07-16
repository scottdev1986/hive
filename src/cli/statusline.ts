import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StatuslineReport } from "../schemas";
import { getHiveHome } from "../daemon/db";
import { agentFetch } from "./credential";

// Claude Code invokes the configured statusLine command on every render and
// pipes the session JSON to stdin. This command is that command
// (adapters/tools/claude.ts writes it into every agent's settings), which makes
// it the one place per render where Claude Code hands Hive a set of facts about
// a live session — and the only place several of them exist at all. So there is
// exactly ONE parse of this payload, here, and everything downstream travels
// the single route this parse feeds: POST /statusline -> the agent's row. Two
// parsers, or a second transport, is how the two halves drift apart and
// manufacture the next wrong join.
//
// Four facts ride in, and every one of them is measured rather than inferred:
//
//   rate_limits            the subscriber's five-hour/weekly usage, present
//                          only for Claude.ai accounts and only after the
//                          session's first API response.
//   context_window         `context_window_size` is the REAL window — 200000,
//                          or 1000000 where the account's plan upgrades it.
//                          Nothing else on this machine knows it: the
//                          transcript records tokens but never the window they
//                          fill, and the model id cannot imply it, because the
//                          1M upgrade is a property of the plan and not of the
//                          name. `used_percentage` is Claude Code's own
//                          occupancy figure; it measures, so we do not
//                          re-derive it.
//   model                  the model ACTUALLY serving the session. The agent
//                          row records the model requested at spawn, which goes
//                          stale the moment a session switches models, so any
//                          join on it (quota reservation included) is a join
//                          against a model nobody is running.
//   effort                 the current effective reasoning effort. The first
//                          observation freezes launch identity; later changes
//                          are drift because `/effort` can move it in-session.
//
// They are parsed independently and each is optional, deliberately: a payload
// with no `rate_limits` (an API-key account, or a session before its first
// response) must still yield the window and the model. Losing them alongside
// the quota block is how we would end up inferring again.
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

/**
 * The one parse: every fact this payload carries, from a single pass over it.
 *
 * Null only when the payload said nothing we can use — not merely when it had
 * no `rate_limits`. The four facts are independent, and the independence is
 * load-bearing: an API-key account, a third-party provider, and any session
 * before its first API response all have NO quota block, and gating the whole
 * report on one would throw away the window and the live model for exactly
 * those sessions — pushing the daemon straight back into inferring the things
 * this parse exists to stop it inferring.
 */
export function parseStatuslineReport(
  agent: string,
  payload: unknown,
  observedAt: string,
): StatuslineReport | null {
  if (!isRecord(payload)) return null;
  const limits = isRecord(payload.rate_limits) ? payload.rate_limits : {};
  const fiveHour = parseWindow(limits.five_hour);
  const sevenDay = parseWindow(limits.seven_day);
  const context = parseContextWindow(payload);
  const effort = parseEffort(payload.effort);

  const measuredNothing = fiveHour === undefined && sevenDay === undefined &&
    context.contextWindow === undefined && effort === undefined;
  if (measuredNothing) return null;

  return {
    agent,
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(effort === undefined ? {} : { effort }),
    ...context,
    observedAt,
  };
}

function parseEffort(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const level = value.level;
  return typeof level === "string" && /^[a-z0-9-]{1,64}$/.test(level)
    ? level
    : undefined;
}

// The live model is deliberately NOT taken from here, though this payload does
// carry `model.id`. The daemon reconciles it from the transcript instead
// (server.ts), because the transcript stamps every assistant turn with the model
// that produced it and is ALWAYS present — while this payload is absent entirely
// on an API-key account, and was for a long time discarded whenever the session
// had no `rate_limits` block. A source that cannot fail beats one that can, and
// one fact with two sources is two facts waiting to disagree.

/**
 * The real context window, in tokens, and Claude Code's own occupancy figure.
 *
 * Absent rather than defaulted when the payload carries no window. That is the
 * whole discipline: a window we were not told is a window we do not know, and
 * the daemon must say "unknown" rather than divide by a plausible-looking
 * 200000. Defaulting the denominator is what reported live agents at ~22% of a
 * 1M window as 100% full — and every decision downstream of that number, every
 * recycle and reuse and respawn, was then made against a fiction.
 *
 * `used_percentage` is Claude Code's own occupancy figure. It measures; we do
 * not re-derive it.
 */
function parseContextWindow(
  payload: Record<string, unknown>,
): { contextWindow?: number; contextUsedPct?: number } {
  const block = payload.context_window;
  if (!isRecord(block)) return {};

  const size = block.context_window_size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return {};
  }
  const used = block.used_percentage;
  return {
    contextWindow: size,
    ...(typeof used === "number" && Number.isFinite(used)
      ? { contextUsedPct: Math.min(100, Math.max(0, used)) }
      : {}),
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

/**
 * Where a swallowed status-line failure goes to be found.
 *
 * The catch below has to stay silent — this renders on every keystroke and an
 * exception here would land in the agent's terminal. But silent to the terminal
 * and silent everywhere are different things, and this function used to be the
 * latter: a hard ReferenceError in the parse presented, indistinguishably, as
 * "no observation this render". The transport was dead and nothing anywhere
 * said so.
 *
 * So the failure is recorded rather than merely dropped. The file is
 * OVERWRITTEN, never appended: a status line that fails once fails on every
 * keystroke, and an append here would be a disk-filling loop. A count and a
 * first/last timestamp say "this has been broken for two hours" without
 * growing.
 */
export const statuslineErrorPath = (): string =>
  join(getHiveHome(), "statusline-error.json");

function recordStatuslineFailure(agent: string, error: unknown): void {
  try {
    const path = statuslineErrorPath();
    const now = new Date().toISOString();
    let previous: { count?: number; firstAt?: string } = {};
    try {
      previous = JSON.parse(readFileSync(path, "utf8")) as typeof previous;
    } catch {
      // No prior failure recorded, or the file is unreadable. Either way this
      // is the first one we know about.
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${
        JSON.stringify({
          agent,
          error: error instanceof Error ? error.message : String(error),
          count: (previous.count ?? 0) + 1,
          firstAt: previous.firstAt ?? now,
          lastAt: now,
        })
      }\n`,
    );
  } catch {
    // A trace we cannot write is not a reason to break the render. This is the
    // one catch in this file that is genuinely allowed to lose information.
  }
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
    // Fires on ANY measured fact, not just the quota block. A session with no
    // rate_limits still carries the context window, and the window is the one
    // number the daemon cannot obtain anywhere else.
    if (report !== null) await postStatuslineReport(report, port, fetcher);
  } catch (error) {
    // Silent to the agent's terminal, which is right. Not silent to us.
    recordStatuslineFailure(agent, error);
  }
  return renderStatusLine(agent, report);
}
