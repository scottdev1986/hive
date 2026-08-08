import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./shared/capability-env";
import { graphifyHookPath, writeGraphifyHook } from "./shared/graphify-hook";
import { daemonMcpUrl } from "./shared/mcp-scope";
import { ORCHESTRATOR_OPENCODE_PERMISSION } from "./shared/orchestrator-role";
import { isRecord, readProjectConfig } from "./shared/project-config";
import { resolveProviderExecutable } from "./shared/provider-executable";

/** The agent Hive writes into the worktree's opencode.json: it carries the launch brief as its {file:} system prompt and the read-only barrier as its permission set. */
export const OPENCODE_HIVE_AGENT = "hive";

export interface OpencodeSpawnOptions {
  /** Null launches without `-m`: opencode applies the user's own config default itself, exactly as a bare `opencode` in a terminal would. Worker spawns always pass the routed model; only the root, whose model is the user's own choice, may have nothing to pass. */
  model: string | null;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
  /** Launch with this configured agent; Hive passes OPENCODE_HIVE_AGENT whenever the worktree config carries the launch brief. */
  agent?: string;
}

export interface OpencodeAgentConfigOptions {
  daemonPort: number;
  graphifyUrl?: string;
  /** The 0600 launch-prompt file, referenced from the hive agent's prompt as `{file:<path>}`. Absent (crash recovery with no prompt on disk) leaves the agent already on disk untouched. */
  instructionPath?: string;
  readOnly?: boolean;
  dangerous?: boolean;
  orchestrator?: boolean;
  skillPaths?: readonly string[];
}

export interface OpencodeTurnPluginOptions {
  name: string;
  daemonPort: number;
  instanceId: string;
  providerRunId: string;
  hiveCommand?: readonly string[];
}

export function resolveWorkingOpencodeExecutable() {
  return resolveProviderExecutable("opencode", [".opencode/bin/opencode"]);
}

/** Hive's (readOnly, dangerous) posture mapped to opencode's surfaces: - readOnly is the reader barrier, expressed on the hive agent in the worktree config — `edit` (which covers write/edit/patch) and `bash` denied, everything else (read/grep/glob, MCP tools) at opencode's permissive default. This mirrors grok's deny Bash/Write/Edit barrier; opencode has no read-only flag. - !readOnly maps to opencode's defaults: most tools allow, `doom_loop` and `external_directory` still ask, and `.env` reads ask. - dangerous maps to `--auto` on the interactive CLI. Native ACP has no corresponding flag, so its hive agent allows those built-in asks in config. */
function opencodeLaunchArgs(options: OpencodeSpawnOptions): string[] {
  const argv = [
    options.executable ?? "opencode",
    ...(options.model === null ? [] : ["-m", options.model]),
  ];
  if (options.agent !== undefined) {
    argv.push("--agent", options.agent);
  }
  if (options.dangerous) argv.push("--auto");
  return argv;
}

export function buildOpencodeSpawnCommand(
  options: OpencodeSpawnOptions,
): string[] {
  return opencodeLaunchArgs(options);
}

/** Where the plugin lands, relative to the worktree. Exported because worktree reconciliation has to discount it: a file Hive writes into every opencode worktree is not the agent's work, and counting it as such made every such worktree look permanently dirty and therefore unsweepable. */
export const OPENCODE_TURN_PLUGIN_PATH = join(
  ".opencode",
  "plugins",
  "hive-turn-events.ts",
);

/** The graphify gate plugin, Hive-written like the turn plugin above and excluded from stranded-work checks the same way. */
export const OPENCODE_GRAPHIFY_PLUGIN_PATH = join(
  ".opencode",
  "plugins",
  "hive-graphify-gate.ts",
);

/** opencode has no shell hook surface, but its plugins' `tool.execute.before` runs before every tool call — built-in and MCP alike — and a throw there fails the call with the thrown message as the tool error the model reads. That is a PreToolUse-equivalent, so this plugin adapts it to the shared gate script: it feeds the call as hook-input JSON, and relays only an explicit deny. Everything else — no script, dead graphify, advisory-only output, malformed output — passes the call through untouched, because a nudge failure must never block an agent tool call. */
async function writeOpencodeGraphifyGatePlugin(
  worktreePath: string,
  hookScriptPath: string,
): Promise<void> {
  const path = join(worktreePath, OPENCODE_GRAPHIFY_PLUGIN_PATH);
  const source = `// Written by Hive. Declines the session's first structural search until the
export const HiveGraphifyGate = async () => ({
  "tool.execute.before": async (
    input: { tool: string },
    output: { args?: unknown },
  ) => {
    let decline: string | undefined;
    try {
      const child = Bun.spawn(${JSON.stringify([hookScriptPath, "opencode"])}, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      child.stdin.write(
        JSON.stringify({ tool_name: input.tool, tool_input: output.args ?? {} }),
      );
      child.stdin.end();
      const raw = await new Response(child.stdout).text();
      await child.exited;
      const hook = JSON.parse(raw).hookSpecificOutput;
      if (
        hook.permissionDecision === "deny" &&
        typeof hook.permissionDecisionReason === "string"
      ) {
        decline = hook.permissionDecisionReason;
      }
    } catch {}
    if (decline !== undefined) throw new Error(decline);
  },
});
`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeOpencodeTurnPlugin(
  worktreePath: string,
  options: OpencodeTurnPluginOptions,
): Promise<void> {
  const hiveCommand = options.hiveCommand ?? ["hive"];
  if (hiveCommand.length === 0 || hiveCommand[0] === undefined) {
    throw new Error("Hive command must contain an executable");
  }
  const path = join(worktreePath, OPENCODE_TURN_PLUGIN_PATH);
  const directory = dirname(path);
  const args = [
    ...hiveCommand,
    "event",
    "turn-end",
    "--agent",
    options.name,
    "--port",
    String(options.daemonPort),
    "--instance-id",
    options.instanceId,
    "--provider-run-id",
    options.providerRunId,
  ];
  const source = `// Written by Hive. OpenCode's session.idle event is the only completion signal.\nexport const HiveTurnEvents = async () => ({\n  event: async ({ event }: { event: { type: string; properties?: { sessionID?: string } } }) => {\n    if (event.type !== "session.idle") return;\n    const sessionID = event.properties?.sessionID;\n    const args = ${JSON.stringify(args)};\n    if (sessionID !== undefined) args.push("--payload", JSON.stringify({ sessionId: sessionID }));\n    const child = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\n    void child.exited;\n  },\n});\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Write the worktree's `opencode.json` — opencode's project config, the analog of claude's `.mcp.json` plus settings. Unrelated keys, servers, and agents are preserved; the `hive` MCP entry and the `hive` agent are Hive-owned and replaced wholesale. The Authorization header names the environment variable holding the bearer rather than the bearer itself, and a missing graphify URL removes a stale endpoint. `oauth: false` stops opencode's OAuth auto-detection from intercepting the static bearer. */
export async function writeOpencodeAgentConfig(
  worktreePath: string,
  options: OpencodeAgentConfigOptions,
): Promise<void> {
  const path = join(worktreePath, "opencode.json");
  await mkdir(worktreePath, { recursive: true });
  const existing = await readProjectConfig(path);
  const mcp = isRecord(existing.mcp) ? existing.mcp : {};
  mcp.hive = {
    type: "remote",
    url: daemonMcpUrl(options.daemonPort),
    enabled: true,
    oauth: false,
    headers: { Authorization: `Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}` },
  };
  if (options.graphifyUrl === undefined) delete mcp.graphify;
  else {
    mcp.graphify = {
      type: "remote",
      url: options.graphifyUrl,
      enabled: true,
    };
  }
  existing.mcp = mcp;
  // The hive agent's own permission block does not bind a subagent spawned through the `task` tool: that subagent runs as a different agent and falls back to the global block. opencode merges global with agent rules and lets agent rules win, so a global barrier contains every agent in this worktree without loosening the queen's scoped grants. Read-only has to hold for the whole worktree, not just the primary agent. Keys the project already set are preserved.
  if (options.readOnly === true && options.orchestrator !== true) {
    const permission = isRecord(existing.permission) ? existing.permission : {};
    permission.edit = "deny";
    permission.bash = "deny";
    existing.permission = permission;
  }
  if (options.skillPaths !== undefined && options.skillPaths.length > 0) {
    const skills = isRecord(existing.skills) ? existing.skills : {};
    skills.paths = [...options.skillPaths];
    existing.skills = skills;
  }
  if (options.instructionPath !== undefined) {
    const agents = isRecord(existing.agent) ? existing.agent : {};
    const workerPermission = {
      ...(options.dangerous === true
        ? {
            doom_loop: "allow" as const,
            external_directory: "allow" as const,
            read: { "*.env": "allow" as const, "*.env.*": "allow" as const },
          }
        : {}),
      ...(options.readOnly === true
        ? { edit: "deny" as const, bash: "deny" as const }
        : {}),
    };
    agents[OPENCODE_HIVE_AGENT] = {
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      // {file:} is resolved by opencode itself; absolute paths are honored (verified against opencode 1.18.3), so the brief never leaves the 0600 launch-prompt file.
      prompt: `{file:${options.instructionPath}}`,
      ...(options.orchestrator === true
        ? { permission: ORCHESTRATOR_OPENCODE_PERMISSION }
        : Object.keys(workerPermission).length > 0
          ? { permission: workerPermission }
          : {}),
    };
    existing.agent = agents;
    existing.default_agent = OPENCODE_HIVE_AGENT;
  }
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  // The decline-once gate rides a project plugin (opencode's PreToolUse surface); a missing URL removes both halves rather than leaving a plugin that shells out to a deleted script.
  const hookScript = graphifyHookPath(worktreePath, ".opencode");
  await writeGraphifyHook(hookScript, options.graphifyUrl);
  if (options.graphifyUrl === undefined) {
    await rm(join(worktreePath, OPENCODE_GRAPHIFY_PLUGIN_PATH), {
      force: true,
    });
  } else {
    await writeOpencodeGraphifyGatePlugin(worktreePath, hookScript);
  }
}
