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

/** Total over known hook kinds at compile time. The generated hook remains
 * fail-open because a nudge failure must never block an agent tool call. */
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
  // Both harnesses inject hookSpecificOutput.additionalContext; Codex silently
  // drops the otherwise accepted systemMessage shape.
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
