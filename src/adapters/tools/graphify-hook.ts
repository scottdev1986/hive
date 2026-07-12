import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const GRAPHIFY_HOOK_SCRIPT = "hive-graphify-hook.sh";

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
  const script = [
    "#!/bin/sh",
    'kind="$1"',
    'input="$(/bin/cat)"',
    'case "$kind" in',
    "  claude-search)",
    '    case "$input" in *grep*|*ripgrep*|*\"rg\ "*|*\"find\ "*|*\"fd\ "*|*\"ack\ "*|*\"ag\ "*) ;; *) exit 0 ;; esac',
    "    ;;",
    "  claude-read)",
    '    case "$input" in *graphify-out/*) exit 0 ;; esac',
    "    ;;",
    "  codex) ;;",
    "  *) exit 0 ;;",
    "esac",
    `response="$(/usr/bin/curl --silent --show-error --connect-timeout 0.02 --max-time 0.03 --header 'Accept: application/json, text/event-stream' ${shellToken(serverUrl)} 2>/dev/null)" || exit 0`,
    'case "$response" in *\"Missing session ID\"*) ;; *) exit 0 ;; esac',
    'message="Graphify is healthy. Before raw code search or reading, call the graphify MCP tool query_graph once; use its answer only as orientation and verify against source."',
    'case "$kind" in',
    '  codex) printf \'{"systemMessage":"%s"}\\n\' "$message" ;;',
    '  *) printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\\n\' "$message" ;;',
    "esac",
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
