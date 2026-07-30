import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shellToken } from "../../../daemon/session-host/shell-session";

export const GRAPHIFY_HOOK_SCRIPT = "hive-graphify-hook.sh";

/**
 * The hook kinds the generated script knows, one per harness tool event Hive
 * wires. This is the vendor dispatch: the adapters pass one of these as `$1`,
 * and the script's `case` arms are generated from the record below, so a new
 * vendor's kind cannot be added without stating what its hook filters on.
 */
export type GraphifyHookKind =
  | "claude-search"
  | "claude-read"
  | "codex"
  | "grok"
  | "kimi"
  | "opencode";

/** Total over known hook kinds at compile time: `filter` is what the vendor's
 * hook fires on, `gate` is whether that vendor spends the one decline. The
 * generated hook stays fail-open everywhere else, because a nudge failure must
 * never block an agent tool call.
 *
 * Only the vendors measured at zero graph calls are gated. Codex already works
 * graph-first on its own and gets the advisory nudge it has always had. */
const GRAPHIFY_HOOK_FILTERS: Record<
  GraphifyHookKind,
  { filter: string; gate: boolean }
> = {
  "claude-search": {
    filter:
      '    case "$input" in *grep*|*ripgrep*|*"rg "*|*"find "*|*"fd "*|*"ack "*|*"ag "*) ;; *) exit 0 ;; esac',
    gate: true,
  },
  codex: {
    filter:
      '    case "$input" in *grep*|*ripgrep*|*"rg "*|*"find "*|*"fd "*|*"ack "*|*"ag "*) ;; *) exit 0 ;; esac',
    gate: false,
  },
  "claude-read": {
    filter: '    case "$input" in *graphify-out/*) exit 0 ;; esac',
    gate: true,
  },
  // Grok's hook carries no matcher, so this arm is the tool filter: its local
  // structural tools are `read_file`, `grep`, `search_tool`, `list_dir` and the
  // shell `run_terminal_command`. Everything else — writes, todos, MCP calls a
  // read-only agent lives on — falls straight through.
  grok: {
    filter: [
      '    case "$input" in *graphify-out/*) exit 0 ;; esac',
      '    case "$input" in *read_file*|*search_tool*|*list_dir*|*grep*|*ripgrep*|*"rg "*|*"find "*|*"fd "*) ;; *) exit 0 ;; esac',
    ].join("\n"),
    gate: true,
  },
  // Kimi's user-level hook carries no matcher either, so this arm filters on
  // the hook input's tool_name: Read, Grep and Glob are its structural tools,
  // and the lowercase binary names catch search shelled out through Bash.
  kimi: {
    filter: [
      '    case "$input" in *graphify-out/*) exit 0 ;; esac',
      `    case "$input" in *'"tool_name":"Read"'*|*'"tool_name":"Grep"'*|*'"tool_name":"Glob"'*|*grep*|*ripgrep*|*"rg "*|*"find "*|*"fd "*) ;; *) exit 0 ;; esac`,
    ].join("\n"),
    gate: true,
  },
  // opencode has no shell hook surface; its Hive-written plugin
  // (tool.execute.before) builds this input itself with opencode's lowercase
  // tool names and throws the decline reason back at the model.
  opencode: {
    filter: [
      '    case "$input" in *graphify-out/*) exit 0 ;; esac',
      `    case "$input" in *'"tool_name":"read"'*|*'"tool_name":"grep"'*|*'"tool_name":"glob"'*|*'"tool_name":"list"'*|*ripgrep*|*"rg "*|*"find "*|*"fd "*) ;; *) exit 0 ;; esac`,
    ].join("\n"),
    gate: true,
  },
};

/** Carried in a double-quoted shell assignment and then into JSON, so it holds
 * no quote, backslash or `$`. The two-step activation is here because Claude
 * defers MCP tools: transcripts show agents that loaded the graph tools by name
 * and searched anyway, so the decline has to say what calling them takes. */
const DECLINE_MESSAGE =
  "Graphify gate (once per session): this search is declined so the graph gets " +
  "first look. Call the hive MCP tool graph_locate with your question instead — " +
  "if your harness defers MCP tools, activate them in two steps: ToolSearch with " +
  "select:mcp__hive__graph_locate,mcp__graphify__get_neighbors,mcp__graphify__query_graph,mcp__graphify__shortest_path, " +
  "then invoke the tool reference it returns. If the graph genuinely cannot " +
  "answer — an exact string or error message, a file it does not index (docs, " +
  "config, generated code), or graph_locate reporting no strong leads — repeat " +
  "this exact call and it will run: the gate is already spent, and every later " +
  "search passes through.";

export function graphifyHookPath(
  worktreePath: string,
  toolDirectory: ".claude" | ".codex" | ".grok" | ".kimi-code" | ".opencode",
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
  // Every spawn rewrites this hook, so clearing the marker is what makes the
  // decline once per session rather than once ever.
  await rm(`${path}.gate`, { force: true });
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
    'spent="$0.gate"',
    // Any graph call spends the gate, whichever arm sees it: an agent already
    // working graph-first must never be declined for its follow-up read. The
    // third pattern is opencode's naming: its MCP tools are `<server>_<tool>`
    // with a single underscore, which the double-underscore pattern misses.
    `case "$input" in *graph_locate*|*graphify__*|*'"tool_name":"graphify_'*) /usr/bin/touch "$spent" 2>/dev/null; exit 0 ;; esac`,
    'case "$kind" in',
    ...Object.entries(GRAPHIFY_HOOK_FILTERS).flatMap(
      ([kind, { filter, gate }]) => [
        `  ${kind})`,
        filter,
        ...(gate ? ["    enforce=1"] : []),
        "    ;;",
      ],
    ),
    // Fail-open, on purpose: see GRAPHIFY_HOOK_FILTERS. A kind this script does
    // not know is a Hive wiring bug, and the compiler is where it is caught.
    "  *) exit 0 ;;",
    "esac",
    `response="$(/usr/bin/curl --silent --show-error --connect-timeout 0.02 --max-time 0.03 --header 'Accept: application/json, text/event-stream' ${shellToken(serverUrl)} 2>/dev/null)" || exit 0`,
    'case "$response" in *"Missing session ID"*) ;; *) exit 0 ;; esac',
    // The decline is what the nudge could not be. Advisory context arrives
    // after the model has already chosen a search tool, and 92 of them in one
    // session changed nothing; a declined call is a boundary the model has to
    // answer. It is spent before it is emitted — a marker this hook cannot
    // write is a decline it must not issue, or the agent loops on it forever.
    `decline="${DECLINE_MESSAGE}"`,
    'if [ "${enforce:-0}" = 1 ] && [ ! -e "$spent" ] && /usr/bin/touch "$spent" 2>/dev/null; then',
    // Grok's hook output contract is undocumented, so the same text ships as
    // both the deny reason and plain context: a harness that ignores the
    // decision still tells the agent what to do.
    '  printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s","additionalContext":"%s"}}\\n\' "$decline" "$decline"',
    "  exit 0",
    "fi",
    'message="Graphify is on: work graph-first. For where-does-X-happen questions call the hive MCP tool graph_locate; for structure walking use the graphify tools (get_neighbors for callers/imports, shortest_path between files, query_graph with token_budget: 16000 — the 2000 default drops every cited edge). Keep raw search for exact strings, unindexed files, or when graph_locate reports no strong leads — and verify graph answers in source."',
    'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\\n\' "$message"',
    "exit 0",
    "",
  ].join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script, { mode: 0o755 });
  // writeFile's mode only applies at creation, and this hook is rewritten at
  // every spawn — including over a copy an earlier Hive left non-executable.
  await chmod(path, 0o755);
}
