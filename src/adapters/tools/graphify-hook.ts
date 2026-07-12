import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const GRAPHIFY_HOOK_SCRIPT = "hive-graphify-hook.sh";

/**
 * The hook kinds the generated script knows, one per harness tool event Hive
 * wires. This is the vendor dispatch: the adapters pass one of these as `$1`,
 * and the script's `case` arms are generated from the record below, so a new
 * vendor's kind cannot be added without stating what its hook filters on.
 */
export type GraphifyHookKind = "claude-search" | "claude-read" | "codex";

/**
 * What each kind filters on, as the shell line that decides whether to nudge.
 *
 * Codex normalizes its shell tool to the name "Bash" in hook input, so its
 * command JSON matches the same search filter Claude's Bash hook uses.
 *
 * The record is total over `GraphifyHookKind` — that totality is the guard. A
 * third vendor's kind is a compile error here, which is deliberately NOT what
 * the script does at runtime: the generated `*) exit 0` stays, because a hook
 * is not a place to fail loudly. A PreToolUse hook that errors can block the
 * agent's tool call outright, so a Hive-side wiring bug would be paid for by
 * the agent, mid-turn, on every Bash call. The loud failure belongs at the
 * compile step, where the person who can fix it is standing; the shell stays
 * fail-open, and the missing nudges show up as a zero in the graphify adoption
 * counter that tool-telemetry already keeps per vendor.
 */
const GRAPHIFY_HOOK_FILTERS: Record<GraphifyHookKind, string> = {
  "claude-search":
    '    case "$input" in *grep*|*ripgrep*|*\"rg\ "*|*\"find\ "*|*\"fd\ "*|*\"ack\ "*|*\"ag\ "*) ;; *) exit 0 ;; esac',
  codex:
    '    case "$input" in *grep*|*ripgrep*|*\"rg\ "*|*\"find\ "*|*\"fd\ "*|*\"ack\ "*|*\"ag\ "*) ;; *) exit 0 ;; esac',
  "claude-read": '    case "$input" in *graphify-out/*) exit 0 ;; esac',
};

export function graphifyHookPath(
  worktreePath: string,
  toolDirectory: ".claude" | ".codex",
): string {
  return join(worktreePath, toolDirectory, GRAPHIFY_HOOK_SCRIPT);
}

/** A fast, fail-open harness nudge. The daemon already proved the endpoint
 * before writing this hook; this bounded HTTP probe prevents a crashed or
 * unresponsive server from becoming an error or a stale instruction later. */
export async function writeGraphifyHook(
  path: string,
  serverUrl: string | undefined,
): Promise<void> {
  if (serverUrl === undefined) {
    await rm(path, { force: true });
    return;
  }
  // One output shape for both harnesses: Codex 0.144.1 parses a PreToolUse
  // {"systemMessage": …} without error and then silently drops it — measured
  // against a mock provider, the text never reaches the model — while the
  // Claude-style hookSpecificOutput.additionalContext is injected as a
  // developer message on both CLIs.
  const script = [
    "#!/bin/sh",
    'kind="$1"',
    'input="$(/bin/cat)"',
    'case "$kind" in',
    ...Object.entries(GRAPHIFY_HOOK_FILTERS).flatMap(([kind, filter]) => [
      `  ${kind})`,
      filter,
      "    ;;",
    ]),
    // Fail-open, on purpose: see GRAPHIFY_HOOK_FILTERS. A kind this script does
    // not know is a Hive wiring bug, and the compiler is where it is caught.
    "  *) exit 0 ;;",
    "esac",
    `response="$(/usr/bin/curl --silent --show-error --connect-timeout 0.02 --max-time 0.03 --header 'Accept: application/json, text/event-stream' ${shellToken(serverUrl)} 2>/dev/null)" || exit 0`,
    'case "$response" in *\"Missing session ID\"*) ;; *) exit 0 ;; esac',
    'message="Graphify is on: work graph-first. For where-does-X-happen questions call the hive MCP tool graph_locate; for structure walking use the graphify tools (get_neighbors for callers/imports, shortest_path between files, query_graph with token_budget: 16000 — the 2000 default drops every cited edge). Keep raw search for exact strings, unindexed files, or when graph_locate reports no strong leads — and verify graph answers in source."',
    'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\\n\' "$message"',
    "exit 0",
    "",
  ].join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
