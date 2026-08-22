import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hiveInstanceSuffix } from "../../hive-home/home";
import { isErrnoCode } from "../../shared/error-message";
import { isRecord, isString } from "../../shared/is-record";
import { shellQuote } from "../../shared/shell-quote";
import { withFileLock } from "../file-lock";
import { sanitizedGitEnv } from "../git-env";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./shared/capability-env";
import { graphifyHookPath, writeGraphifyHook } from "./shared/graphify-hook";
import { daemonMcpUrl } from "./shared/mcp-scope";
import { resolveProviderExecutable } from "./shared/provider-executable";
import type { JsonObject } from "../../shared/json";
import { unsafeCast } from "../../shared/unsafe-cast";

export interface GrokSpawnOptions {
  model: string;
  effort?: string;
  worktreePath: string;
  readOnly: boolean;
  executable?: string;
  sessionId?: string;
  rules?: string;
}

export interface GrokAgentConfigOptions {
  daemonPort: number;
  name?: string;
  providerRunId?: string;
  hiveCommand?: readonly string[];
  graphifyUrl?: string;
}

export type GrokProjectTrust = "trusted" | "untrusted" | "unknown";

export const GROK_READ_ONLY_PERMISSION_RULES = {
  deny: ["Bash", "Write", "Edit"],
  allow: ["MCPTool", "Read", "Grep"],
};

export const GROK_COMPATIBILITY_ENV = {
  GROK_CLAUDE_SKILLS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
} as const;

export interface GrokCliIdentity {
  version: string | null;
  buildHash: string | null;
  channel: string | null;
}

const GROK_VERSION_PATTERN = /^grok (\S+) \(([0-9a-f]+)\)(?: \[(\w+)])?$/;

export function parseGrokCliVersion(output: string): GrokCliIdentity | null {
  const match = GROK_VERSION_PATTERN.exec(output.trim());
  if (match === null) return null;
  const [, version, buildHash, channel] = match;
  if (version === undefined || buildHash === undefined) return null;
  return { version, buildHash, channel: channel ?? null };
}

export function probeGrokCliVersion(
  executable = "grok",
  timeoutMs = 5_000,
): GrokCliIdentity | null {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    return (
      parseGrokCliVersion(result.stdout.toString()) ?? {
        version: null,
        buildHash: null,
        channel: null,
      }
    );
  } catch {
    return null;
  }
}

export function resolveWorkingGrokExecutable() {
  return resolveProviderExecutable("grok", [
    ".local/bin/grok",
    ".grok/bin/grok",
    ".opencode/bin/grok",
  ]);
}

function grokPermissionArgs(readOnly: boolean): string[] {
  if (!readOnly) return ["--always-approve"];
  return [
    ...GROK_READ_ONLY_PERMISSION_RULES.deny.flatMap((rule) => ["--deny", rule]),
    ...GROK_READ_ONLY_PERMISSION_RULES.allow.flatMap((rule) => [
      "--allow",
      rule,
    ]),
  ];
}

function grokLaunchArgs(options: GrokSpawnOptions): string[] {
  // `--no-auto-update` is REQUIRED for automated launches and is not optional polish: xAI's own headless/scripting guide says to pass it "when using headless mode (-p) or ACP (grok agent stdio) in scripts, CI, or other automated environments" (docs.x.ai/build/cli/headless-scripting, read 2026-07-26 against grok 0.2.112). A Hive agent is exactly that — nobody is at the keyboard to answer an update prompt or wait out a background re-exec. The flag is HIDDEN from `grok --help`, so it cannot be discovered by probing the binary; it is accepted and exits 0. That is why this was missed: the vendor rule for this repo is to read the vendor's documentation, not to infer the surface from the CLI. Deliberately a launch flag rather than `auto_update = false` in ~/.grok/config.toml: that file is the user's, and Hive does not write vendor configuration to gain a capability.
  const argv = [
    options.executable ?? "grok",
    "--no-auto-update",
    "-m",
    options.model,
  ];
  if (options.effort !== undefined) {
    argv.push("--reasoning-effort", options.effort);
  }
  if (options.rules !== undefined) {
    argv.push("--rules", options.rules);
  }
  argv.push(...grokPermissionArgs(options.readOnly));
  return argv;
}

/** `--session-id` creates a session and must never enter the resume path. */
export function buildGrokSpawnCommand(options: GrokSpawnOptions): string[] {
  const argv = grokLaunchArgs(options);
  if (options.sessionId !== undefined) {
    argv.push("--session-id", options.sessionId);
  }
  return argv;
}

/** Grok can otherwise inherit the user's Claude/Cursor skills, rules, agents, MCPs, and hooks. These process-local switches disable those imports. They do not stop Grok ingesting repository-local Claude instructions or settings; Grok exposes no switch for those sources. */
export function wrapGrokSpawnWithCompatibilityEnv(command: string): string {
  const environment = Object.entries(GROK_COMPATIBILITY_ENV)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${environment} ${command}`;
}

const tomlString = (value: string): string => JSON.stringify(value);

const hook = (command: string) => [
  { hooks: [{ type: "command" as const, command }] },
];

export function ownsGrokHook(
  source: string,
  instanceId = hiveInstanceSuffix(),
): boolean {
  return (
    source.includes(" event ") &&
    source.includes(`--instance-id ${shellQuote(instanceId)}`) &&
    source.includes("--provider-run-id") &&
    [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "PostCompact",
      "SessionEnd",
    ].every((event) => source.includes(`"${event}"`))
  );
}

async function grokHookPath(
  directory: string,
  instanceId: string,
): Promise<string> {
  const preferred = join(directory, grokHookFilename(instanceId));
  const existing = await readFile(preferred, "utf8").catch(() => null);
  if (existing === null || ownsGrokHook(existing, instanceId)) return preferred;

  const suffix = createHash("sha256")
    .update(instanceId)
    .digest("hex")
    .slice(0, 12);
  for (let index = 0; ; index += 1) {
    const candidate = join(directory, `hive-${suffix}-${index + 1}.json`);
    const candidateSource = await readFile(candidate, "utf8").catch(() => null);
    if (candidateSource === null || ownsGrokHook(candidateSource, instanceId)) {
      return candidate;
    }
  }
}

export function grokHookFilename(instanceId = hiveInstanceSuffix()): string {
  const suffix = createHash("sha256")
    .update(instanceId)
    .digest("hex")
    .slice(0, 12);
  return `hive-${suffix}.json`;
}

/** The repository an agent worktree belongs to, or null when it cannot be determined. This exists for one sentence in one error message, and that sentence is the whole value of the message. Grok's folder trust inherits: a decision recorded for an ancestor covers every folder beneath it, worktrees included. Telling a user to trust the agent worktree would be advice they cannot act on, because that directory is minted per spawn and deleted after; telling them to trust the repository is one action that covers every agent they will ever run there. */
export function repositoryRootForWorktree(worktreePath: string): string | null {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      env: sanitizedGitEnv(),
    },
  );
  if (result.exitCode !== 0) return null;
  const gitDir = result.stdout.toString().trim();
  return gitDir.endsWith("/.git")
    ? gitDir.slice(0, -"/.git".length)
    : gitDir.length === 0
      ? null
      : dirname(gitDir);
}

/** Why a Grok spawn into an untrusted worktree is refused rather than launched. Grok does not start repo-local (project-scoped) MCP servers in an untrusted folder — its own `grok mcp doctor` says so verbatim — and Hive's MCP server is exactly that. An agent that cannot reach it can still paint a screen and hold a process, so every liveness signal Hive has reads healthy — and the launch is no longer stopped for it: a missed reachability check only warns, and the agent is left running and permanently mute, visible as `credentialReporting` in hive_status but only to whoever reads it. Refusing at spawn is what keeps that from happening at all. Hive does not write `~/.grok/trusted_folders.toml`. The trust contract is the user's, and this message hands them the one action that settles it for good. */
export function grokUntrustedWorktreeRefusal(
  name: string,
  worktreePath: string,
  repositoryRoot: string | null,
): string {
  const remedy =
    repositoryRoot === null
      ? "Trust the repository this worktree belongs to"
      : `Trust ${repositoryRoot}`;
  return (
    `Grok reports ${worktreePath} as untrusted, so it will not start Hive's ` +
    `MCP server there — grok does not start repo-local (project-scoped) MCP ` +
    `servers in untrusted folders. Without it ${name} could open, hold a ` +
    `terminal and look healthy while being unable to publish or poll mail or ` +
    `hive_land, so the spawn is refused now instead of failing in ~30s with a ` +
    `transport error that names none of this.\n` +
    `${remedy} — run \`grok\` there once and accept the trust prompt. Grok's ` +
    `trust inherits, so that one decision covers every agent worktree Hive ` +
    `mints beneath it. Hive does not write grok's trust store: the grant is ` +
    `yours to make.`
  );
}

export function inspectGrokProjectTrust(
  worktreePath: string,
  executable = "grok",
): GrokProjectTrust {
  try {
    const result = Bun.spawnSync([executable, "inspect"], {
      cwd: worktreePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return "unknown";
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    const trust = /Project trusted:\s*(yes|no)\b/.exec(output)?.[1];
    return trust === "yes"
      ? "trusted"
      : trust === "no"
        ? "untrusted"
        : "unknown";
  } catch {
    return "unknown";
  }
}

function stripHiveMcpTables(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      skipping =
        header === "mcp_servers.hive" ||
        header.startsWith("mcp_servers.hive.") ||
        header === "mcp_servers.graphify" ||
        header.startsWith("mcp_servers.graphify.");
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

export async function writeGrokAgentConfig(
  worktreePath: string,
  options: GrokAgentConfigOptions,
): Promise<void> {
  const directory = join(worktreePath, ".grok");
  const hooksDirectory = join(directory, "hooks");
  const path = join(directory, "config.toml");
  await mkdir(directory, { recursive: true });
  const existing = await readFile(path, "utf8").catch((error) => {
    if (isErrnoCode(error, "ENOENT")) return "";
    throw error;
  });
  const prefix = stripHiveMcpTables(existing);
  const owned = [
    "[mcp_servers.hive]",
    `url = ${tomlString(daemonMcpUrl(options.daemonPort))}`,
    "enabled = true",
    "",
    "[mcp_servers.hive.headers]",
    `Authorization = ${tomlString(`Bearer \${${HIVE_CAPABILITY_TOKEN_ENV}}`)}`,
    ...(options.graphifyUrl === undefined
      ? []
      : [
          "",
          "[mcp_servers.graphify]",
          `url = ${tomlString(options.graphifyUrl)}`,
          "enabled = true",
        ]),
  ].join("\n");
  const graphifyHook = graphifyHookPath(worktreePath, ".grok");
  const writes = [
    writeFile(path, `${prefix.length === 0 ? "" : `${prefix}\n\n`}${owned}\n`, {
      mode: 0o600,
    }),
    writeGraphifyHook(graphifyHook, options.graphifyUrl),
  ];
  const name = options.name;
  const providerRunId = options.providerRunId;
  if (name !== undefined && providerRunId !== undefined) {
    const hiveCommand = options.hiveCommand ?? ["hive"];
    if (hiveCommand[0] === undefined) {
      throw new Error("Hive command must contain an executable");
    }
    const instanceId = hiveInstanceSuffix();
    const invocation = hiveCommand.map(shellQuote).join(" ");
    const eventCommand = (kind: string): string =>
      [
        invocation,
        "event",
        kind,
        "--agent",
        shellQuote(name),
        "--port",
        String(options.daemonPort),
        "--instance-id",
        shellQuote(instanceId),
        "--provider-run-id",
        shellQuote(providerRunId),
      ].join(" ");
    const hooks = {
      hooks: {
        SessionStart: hook(eventCommand("session-start")),
        UserPromptSubmit: hook(eventCommand("turn-start")),
        PreToolUse: [
          ...hook(eventCommand("tool-start")),
          ...(options.graphifyUrl === undefined
            ? []
            : hook(`${shellQuote(graphifyHook)} grok`)),
        ],
        PostToolUse: hook(eventCommand("tool-boundary")),
        PostToolUseFailure: hook(eventCommand("tool-boundary")),
        Stop: hook(eventCommand("turn-end")),
        StopFailure: hook(eventCommand("turn-failure")),
        PostCompact: hook(eventCommand("compacted")),
        SessionEnd: hook(eventCommand("session-end")),
      },
    };
    await mkdir(hooksDirectory, { recursive: true });
    const hookPath = await grokHookPath(hooksDirectory, instanceId);
    writes.push(
      writeFile(hookPath, `${JSON.stringify(hooks, null, 2)}\n`, {
        mode: 0o600,
      }),
    );
  }
  await Promise.all(writes);
}

async function removeOwnedGrokHooks(worktreePath: string): Promise<boolean> {
  const directory = join(worktreePath, ".grok", "hooks");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  let removed = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null || !ownsGrokHook(source)) continue;
    await rm(path, { force: true });
    removed = true;
  }
  return removed;
}

export async function removeGrokAgentConfig(
  worktreePath: string,
): Promise<boolean> {
  const hooksRemoved = await removeOwnedGrokHooks(worktreePath);
  const path = join(worktreePath, ".grok", "config.toml");
  const existing = await readFile(path, "utf8").catch((error) => {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing === null) return hooksRemoved;
  let parsed: {
    mcp_servers?: { hive?: { url?: unknown } };
  };
  try {
    // SAFETY: The surrounding code already established this contract.
    parsed = Bun.TOML.parse(existing) as typeof parsed;
  } catch {
    return hooksRemoved;
  }
  const hiveUrl = parsed.mcp_servers?.hive?.url;
  if (!isString(hiveUrl) || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(hiveUrl))
    return hooksRemoved;
  const remaining = stripHiveMcpTables(existing);
  if (remaining.trim().length === 0) await rm(path, { force: true });
  else await writeFile(path, `${remaining}\n`, { mode: 0o600 });
  return true;
}

export function grokHome(): string {
  return Bun.env.GROK_HOME ?? join(homedir(), ".grok");
}

export function grokSessionsDirectory(home = grokHome()): string {
  return join(home, "sessions");
}

function renderTrustedFolders(folders: Record<string, JsonObject>): string {
  return `${Object.entries(folders)
    .map(([path, entry]) => {
      const body = Object.entries(entry)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n");
      return `[folders.${JSON.stringify(path)}]\n${body}`;
    })
    .join("\n\n")}\n`;
}

interface GrokTrustedFoldersFile {
  folders?: Record<string, JsonObject>;
}

/** Record, in grok's own trust store, the decision the user already made by opening Hive on this repository. Grok will not start repo-local MCP servers — Hive's included — in an untrusted folder, and Hive's own config write is what makes a fresh agent worktree untrusted. Without this a Grok agent can look healthy until it dies on the MCP reporting deadline. The grant is the REPOSITORY, not the worktree, and that is not a choice: grok ignores a trust entry keyed to a nested git root, so an entry for the agent worktree has no effect. The narrowest grant that works is the repository the user pointed Hive at, and it is therefore also broader than Hive's own worktrees: the user's own manual `grok` runs in that repository become trusted too. That is the cost of the assumption "opening Hive here is the trust decision", and it is stated here so it is never a surprise. An entry the user already decided is left exactly as it is, including a deliberate `trusted = false` — this seeds a missing decision, it never overturns one. */
export async function seedGrokRepositoryTrust(
  repositoryRoot: string,
  home = grokHome(),
): Promise<"seeded" | "already-decided" | "unwritable"> {
  const key = await realpath(repositoryRoot).catch(() =>
    resolve(repositoryRoot),
  );
  const path = join(home, "trusted_folders.toml");
  try {
    // Hive's own lock, NOT grok's `trusted_folders.toml.lock`. Hive's is create-exclusive and grok keeps its lock file present permanently, so reusing the vendor's path blocks until the timeout, every time — which is exactly how the first version of this silently seeded nothing and left the spawn to refuse a repository Hive had just decided to trust. Two writers cannot be serialized across two different mutex disciplines anyway; this one keeps concurrent HIVE spawns off each other.
    return await withFileLock(`${path}.hive.lock`, async () => {
      const source = await readFile(path, "utf8").catch(() => "");
      const parsed =
        source.trim().length === 0
          ? {}
          : unsafeCast<GrokTrustedFoldersFile>(Bun.TOML.parse(source));
      const folders = parsed.folders ?? {};
      if (folders[key] !== undefined) return "already-decided";
      const next = {
        ...folders,
        [key]: { trusted: true, decided_at: Math.floor(Date.now() / 1000) },
      };
      await mkdir(home, { recursive: true });
      const temporary = `${path}.hive-${process.pid}.tmp`;
      await writeFile(temporary, renderTrustedFolders(next), { mode: 0o600 });
      await rename(temporary, path);
      return "seeded";
    });
  } catch {
    // A store Hive cannot write is not fatal: the spawn path still inspects trust afterwards and refuses with the manual remedy. Never let a failed convenience become a failed launch on its own.
    return "unwritable";
  }
}

interface GrokSummaryLocation {
  id: string;
  model: string | null;
  mtimeMs: number;
  createdAt: unknown;
  path: string;
  directory: string;
}

async function findLatestGrokSummary(
  worktreePath: string,
  home?: string,
  sessionId?: string,
): Promise<GrokSummaryLocation | null> {
  const summaries = await findGrokSummaries(worktreePath, home, sessionId);
  let newest: GrokSummaryLocation | null = null;
  for (const summary of summaries) {
    if (newest === null || summary.mtimeMs > newest.mtimeMs) newest = summary;
  }
  return newest;
}

async function findGrokSummaries(
  worktreePath: string,
  home?: string,
  sessionId?: string,
): Promise<GrokSummaryLocation[]> {
  const target = resolve(worktreePath);
  const root = grokSessionsDirectory(home);
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: GrokSummaryLocation[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let recordedCwd: string | null;
    try {
      recordedCwd = (await readFile(join(projectPath, ".cwd"), "utf8")).trim();
    } catch {
      recordedCwd = null;
    }
    if (project.name !== encodeURIComponent(target) && recordedCwd !== target) {
      continue;
    }
    let sessions: Dirent[];
    try {
      sessions = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const summaryPath = join(projectPath, session.name, "summary.json");
      let parsed: unknown;
      let mtimeMs: number;
      try {
        parsed = JSON.parse(await readFile(summaryPath, "utf8"));
        mtimeMs = (await stat(summaryPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!isRecord(parsed) || !isRecord(parsed.info)) {
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      const info = parsed.info;
      if (!isString(info.id) || !isString(info.cwd)) {
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      if (
        info.cwd !== target ||
        (sessionId !== undefined && info.id !== sessionId)
      )
        continue;
      if (
        parsed.current_model_id !== undefined &&
        !isString(parsed.current_model_id)
      ) {
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      const model = isString(parsed.current_model_id)
        ? parsed.current_model_id
        : null;
      summaries.push({
        id: info.id,
        model,
        mtimeMs,
        createdAt: parsed.created_at,
        path: summaryPath,
        directory: join(projectPath, session.name),
      });
    }
  }
  return summaries;
}

/** Resolve only a session whose own summary records this exact worktree cwd. */
export async function findLatestGrokSessionId(
  worktreePath: string,
  home?: string,
): Promise<string | null> {
  return (await findLatestGrokSummary(worktreePath, home))?.id ?? null;
}

/** The session directory whose summary records this exact worktree cwd — where `updates.jsonl` (the turn and tool-call stream) and `signals.json` (the context reading) live. Pass `sessionId` whenever the row has one: without it this resolves the newest session for the cwd, and a reused worktree still holds every dead predecessor's session. */
export async function findLatestGrokSessionDirectory(
  worktreePath: string,
  sessionId?: string,
  home?: string,
): Promise<string | null> {
  return (
    (await findLatestGrokSummary(worktreePath, home, sessionId))?.directory ??
    null
  );
}
