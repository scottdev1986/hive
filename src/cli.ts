#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { runCodexAppServerHost } from "./adapters/tools/codex-app-server";
import {
  autonomyCli,
  deleteMemoryCli,
  printQuotaStatus,
  printStatus,
  readMemoryCli,
  recordQuotaObservation,
  recoverAgentsCli,
  registerLayoutTerminal,
  reindexMemoryCli,
  searchMemoryCli,
  stopHive,
  watchAgent,
  writeMemoryCli,
} from "./cli/control";
import { runChannelBridge } from "./cli/channel-bridge";
import { runCredentialHelper } from "./cli/credential";
import { runDaemon } from "./cli/daemon";
import {
  readHookStdin,
  runHiveEvent,
  type HookEventOptions,
} from "./cli/event";
import { launchOrchestrator } from "./cli/orchestrator";
import {
  runGraphifyDisable,
  runGraphifyEnable,
  runGraphifyStatus,
} from "./cli/graphify";
import { runInitCli } from "./cli/init";
import { projectRootOrCwd } from "./cli/project-root";
import { printRouting } from "./cli/routing";
import { runStart } from "./cli/start";
import { runStatusline } from "./cli/statusline";
import {
  printUpdateStatus,
  runRollback,
  runUpdate,
  runUpdateCheck,
  runUpdateSkip,
} from "./cli/update";
import {
  wantsUpdateNotice,
  withTrailingUpdateNotice,
} from "./cli/update-notice";
import { runWorkspace } from "./cli/workspace";
import { runWorkspaceFeedCli } from "./cli/workspace-feed";
import { versionLine } from "./version";
import type {
  MemoryScope,
  MemorySource,
  MemoryVerificationStatus,
} from "./schemas";
import {
  MemoryWriterSourceSchema,
  MemoryVerificationStatusSchema,
} from "./schemas";

export interface EventCliOptions {
  agent?: string;
  port?: string;
  payload?: string;
  description?: string;
  usageUnits?: string;
  usageSource?: "provider" | "gateway" | "estimated";
}

interface QuotaReconcileOptions {
  provider: "claude" | "codex";
  account: string;
  pool: string;
  fiveHourUsed: string;
  weeklyUsed: string;
  observedAt?: string;
  fiveHourResetAt?: string;
  weeklyResetAt?: string;
}

interface CodexAppServerHostCliOptions {
  socket: string;
  worktree: string;
  port: string;
  agent: string;
}

function parseNonnegative(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a nonnegative number`);
  }
  return number;
}

function parseMemoryScope(value: string): MemoryScope {
  if (value !== "repo" && value !== "global") {
    throw new Error(`Invalid memory scope "${value}": expected repo or global`);
  }
  return value;
}

function parseMemorySource(value: string): Exclude<MemorySource, "legacy"> {
  const parsed = MemoryWriterSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid memory source "${value}": expected init, agent, orchestrator, or human`,
    );
  }
  return parsed.data;
}

function parseMemoryStatus(value: string): MemoryVerificationStatus {
  const parsed = MemoryVerificationStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid memory status "${value}": expected verified, unverified, stale, or conflicted`,
    );
  }
  return parsed.data;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid event port: ${value ?? "missing"}`);
  }
  return port;
}

function parseEventPayload(value: string | undefined): HookEventOptions {
  if (value === undefined) {
    return {};
  }
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("Event payload must be a JSON object");
  }

  const payload: HookEventOptions = {};
  const agent = parsed.agent ?? parsed.agentName;
  if (agent !== undefined) {
    if (typeof agent !== "string") {
      throw new Error("Event payload agent must be a string");
    }
    payload.agent = agent;
  }
  if (parsed.description !== undefined) {
    if (typeof parsed.description !== "string") {
      throw new Error("Event payload description must be a string");
    }
    payload.description = parsed.description;
  }
  const usageUnits = parsed.usageUnits ?? parsed.usage_units;
  if (usageUnits !== undefined) {
    if (typeof usageUnits !== "number" || usageUnits < 0) {
      throw new Error("Event payload usageUnits must be a nonnegative number");
    }
    payload.usageUnits = usageUnits;
  }
  const usageSource = parsed.usageSource ?? parsed.usage_source;
  if (usageSource !== undefined) {
    if (usageSource !== "provider" && usageSource !== "gateway" &&
      usageSource !== "estimated") {
      throw new Error("Event payload usageSource is invalid");
    }
    payload.usageSource = usageSource;
  }
  // Codex's notify payload names the conversation "thread-id"; it is the
  // session id `codex resume` accepts, so crash recovery records it.
  const toolSessionId = parsed["thread-id"] ?? parsed.threadId ??
    parsed["session-id"] ?? parsed.sessionId ?? parsed.session_id;
  if (toolSessionId !== undefined) {
    if (typeof toolSessionId !== "string" || toolSessionId.length === 0) {
      throw new Error("Event payload session id must be a non-empty string");
    }
    payload.toolSessionId = toolSessionId;
  }
  return payload;
}

export function buildEventOptions(options: EventCliOptions): HookEventOptions {
  const payload = parseEventPayload(options.payload);
  return {
    ...payload,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.usageUnits === undefined
      ? {}
      : { usageUnits: parseNonnegative(options.usageUnits, "usage-units") }),
    ...(options.usageSource === undefined
      ? {}
      : { usageSource: options.usageSource }),
  };
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("hive")
    .description("Coordinate named Claude and Codex agents")
    .showHelpAfterError()
    .exitOverride();

  // `hive --version` prints one line because that is what every peer does and
  // what bug reports need. The richer facts belong to `hive update status`.
  program.version(versionLine(), "-v, --version", "Print the Hive version");

  // Bare `hive` opens the project the shell is in: resolve the repo root, run
  // the shared session boundary, and hand the app the project and daemon port.
  // Outside a git repo it launches the app standalone (placeholder window) —
  // the project-neutral home a Dock click gets. Never a dev Workspace build.
  program.action(async () => {
    process.exitCode = await runWorkspace();
  });

  program
    .command("init")
    .description(
      "Scaffold this repo's agent conventions and seed its memory, then bring its Hive daemon up",
    )
    .option("--refresh", "force a re-scan of the repo profile; never required")
    .option("--scaffold-agents", "offer to scaffold an AGENTS.md when none exists")
    .option("--seed-facts <path>", "JSON file of narrative facts to seed (source: init)")
    .option(
      "--force",
      "replace a Hive skill you have edited with the version Hive ships",
    )
    .action(async (options: {
      refresh?: boolean;
      scaffoldAgents?: boolean;
      seedFacts?: string;
      force?: boolean;
    }) => {
      const root = projectRootOrCwd();
      await runInitCli({
        cwd: root,
        ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
        ...(options.scaffoldAgents === undefined
          ? {}
          : { scaffoldAgents: options.scaffoldAgents }),
        ...(options.seedFacts === undefined
          ? {}
          : { seedFacts: options.seedFacts }),
        ...(options.force === undefined ? {} : { force: options.force }),
      });
      if (options.refresh !== true) await runStart({ cwd: root });
    });

  const update = program
    .command("update [version]")
    .description("Update the installed Hive to the latest (or an exact) release")
    .action(async (version?: string) => {
      await runUpdate(version);
    });

  update.command("check")
    .description("Check for a newer release; exit 10 when one is available")
    .action(async () => {
      process.exitCode = await runUpdateCheck();
    });

  update.command("status")
    .description("Show version, install method, retained versions, and last check")
    .action(printUpdateStatus);

  update.command("rollback")
    .description("Reactivate the retained previous version")
    .action(runRollback);

  update.command("skip")
    .description("Silence update notices for the currently offered version")
    .action(runUpdateSkip);

  program
    .command("claude")
    .description("Open Workspace with a read-only Claude orchestrator")
    .action(async () => {
      process.exitCode = await runWorkspace({ orchestrator: "claude" });
    });

  program
    .command("codex")
    .description("Open Workspace with a read-only Codex orchestrator")
    .action(async () => {
      process.exitCode = await runWorkspace({ orchestrator: "codex" });
    });

  program
    .command("status")
    .description("Show Hive agent status")
    .action(printStatus);

  program
    .command("routing")
    .description(
      "Show the derived routing table with per-cell provenance (inert: does not route)",
    )
    .action(printRouting);

  program
    .command("autonomy [mode]")
    .description(
      "Show or set writer-agent autonomy: sandboxed (approvals queue) or " +
        "dangerous (no permission prompts)",
    )
    .option("--port <number>", "daemon port")
    .action(async (mode: string | undefined, options: { port?: string }) => {
      await autonomyCli(
        mode,
        ...(options.port === undefined ? [] : [parsePort(options.port)]),
      );
    });

  const quota = program
    .command("quota")
    .description("Show quota capacity, reservations, telemetry, and resets")
    .action(printQuotaStatus);

  quota.command("reconcile")
    .description("Record a manual provider dashboard observation")
    .requiredOption("--provider <provider>", "claude or codex")
    .option("--account <account>", "account scope", "default")
    .requiredOption("--pool <pool>", "configured quota pool")
    .requiredOption("--five-hour-used <units>", "used 5-hour units")
    .requiredOption("--weekly-used <units>", "used weekly units")
    .option("--observed-at <iso>", "observation time")
    .option("--five-hour-reset-at <iso>", "known 5-hour reset time")
    .option("--weekly-reset-at <iso>", "known weekly reset time")
    .action(async (options: QuotaReconcileOptions) => {
      if (options.provider !== "claude" && options.provider !== "codex") {
        throw new Error("provider must be claude or codex");
      }
      await recordQuotaObservation({
        provider: options.provider,
        account: options.account,
        pool: options.pool,
        fiveHourUsed: parseNonnegative(
          options.fiveHourUsed,
          "five-hour-used",
        ),
        weeklyUsed: parseNonnegative(options.weeklyUsed, "weekly-used"),
        observedAt: options.observedAt ?? new Date().toISOString(),
        fiveHourResetAt: options.fiveHourResetAt ?? null,
        weeklyResetAt: options.weeklyResetAt ?? null,
        source: "manual",
        confidence: "reported",
      });
    });

  const graphify = program
    .command("graphify")
    .description(
      "Opt-in local code knowledge graph for agents (docs/architecture/graphify-integration.md)",
    );

  graphify.command("enable")
    .description(
      "Consent to graphify: hash-verified install into ~/.hive/tools, then a code-only local graph build",
    )
    .action(async () => {
      process.exitCode = await runGraphifyEnable(projectRootOrCwd());
    });

  graphify.command("disable")
    .description("Turn graphify off for this repo; --purge also removes the tool and graphify-out/")
    .option("--purge", "delete the installed tool and this repo's graphify-out/")
    .action(async (options: { purge?: boolean }) => {
      process.exitCode = await runGraphifyDisable(projectRootOrCwd(), {
        ...(options.purge === undefined ? {} : { purge: options.purge }),
      });
    });

  graphify.command("status")
    .description("Show pin, install state, and graph freshness for this repo")
    .action(async () => {
      process.exitCode = await runGraphifyStatus(projectRootOrCwd());
    });

  const memory = program
    .command("memory")
    .description(
      "Search, read, write, delete, and reindex durable Hive memory articles",
    );

  memory.command("search <query>")
    .description("Full-text search compiled memory articles")
    .option("--scope <scope>", "repo or global")
    .option("--limit <n>", "max results")
    .action(async (
      query: string,
      options: { scope?: string; limit?: string },
    ) => {
      await searchMemoryCli(query, {
        ...(options.scope === undefined
          ? {}
          : { scope: parseMemoryScope(options.scope) }),
        ...(options.limit === undefined
          ? {}
          : { limit: parseNonnegative(options.limit, "limit") }),
      });
    });

  memory.command("write <title>")
    .description("Record an observation and create or update its compiled article")
    .requiredOption("--scope <scope>", "repo or global")
    .requiredOption("--topic <topic>", "lowercase kebab-case topic")
    .requiredOption("--body <text>", "fact body (Markdown)")
    .requiredOption("--source <source>", "init, agent, orchestrator, or human")
    .requiredOption("--evidence <text>", "what was measured or supplied, and where")
    .requiredOption(
      "--status <status>",
      "verified, unverified, stale, or conflicted",
    )
    .requiredOption(
      "--supersedes <ids>",
      "comma-separated article ids; use an empty string when none",
    )
    .option("--id <id>", "existing fact id to overwrite")
    .option("--tags <tags>", "comma-separated tags")
    .option("--date <yyyy-mm-dd>", "fact date (defaults to today)")
    .option(
      "--verified <yyyy-mm-dd>",
      "date the fact was last confirmed true against the repo",
    )
    .action(async (title: string, options: {
      scope: string;
      topic: string;
      body: string;
      source: string;
      evidence: string;
      status: string;
      supersedes: string;
      id?: string;
      tags?: string;
      date?: string;
      verified?: string;
    }) => {
      await writeMemoryCli({
        scope: parseMemoryScope(options.scope),
        topic: options.topic,
        title,
        body: options.body,
        source: parseMemorySource(options.source),
        evidence: options.evidence,
        status: parseMemoryStatus(options.status),
        supersedes: options.supersedes.split(",").map((id) => id.trim()).filter(Boolean),
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.tags === undefined ? {} : {
          tags: options.tags.split(",").map((tag) => tag.trim()).filter((
            tag,
          ) => tag.length > 0),
        }),
        ...(options.date === undefined ? {} : { date: options.date }),
        ...(options.verified === undefined ? {} : { verified: options.verified }),
      });
    });

  memory.command("read <scope> <id>")
    .description("Print one compiled memory article")
    .action(async (scope: string, id: string) => {
      await readMemoryCli(parseMemoryScope(scope), id);
    });

  memory.command("delete <scope> <id>")
    .description("Delete one compiled memory article")
    .action(async (scope: string, id: string) => {
      await deleteMemoryCli(parseMemoryScope(scope), id);
    });

  memory.command("reindex")
    .description(
      "Rebuild the memory search index from the Markdown files on disk",
    )
    .action(reindexMemoryCli);

  program
    .command("watch <name>")
    .description("Open a viewer for a named agent")
    .action(watchAgent);

  const layout = program
    .command("layout")
    .description("Manage terminal window layout participation");

  layout.command("register")
    .description("Register the running orchestrator's attached terminal")
    .option("--terminal <app>", "auto, terminal, or iterm2", "auto")
    .action(async (options: { terminal: string }) => {
      await registerLayoutTerminal(options.terminal);
    });

  program
    .command("stop")
    .description("Stop live agents and the Hive daemon")
    .action(stopHive);

  program
    .command("event <kind>")
    .description("Post an agent hook event")
    .option("--agent <name>", "agent name")
    .option("--port <number>", "daemon port")
    .option("--payload <json>", "tool hook JSON payload")
    .option("--description <text>", "approval description")
    .option("--usage-units <number>", "provider or gateway usage units")
    .option(
      "--usage-source <source>",
      "provider, gateway, or estimated",
    )
    .action(async (kind: string, options: EventCliOptions) => {
      try {
        // Claude hooks deliver session identity on stdin; explicit CLI and
        // payload options always win over the captured value.
        const captured = await readHookStdin();
        await runHiveEvent(
          kind,
          parsePort(options.port),
          { ...captured, ...buildEventOptions(options) },
        );
      } catch {
        // Commander option parsing and hook delivery must not break agent turns.
      }
    });

  program
    .command("statusline")
    .description("Render an agent status line and forward subscriber quota")
    .requiredOption("--agent <name>", "agent name")
    .requiredOption("--port <number>", "daemon port")
    .action(async (options: { agent: string; port: string }) => {
      const stdin = await Bun.stdin.text().catch(() => "");
      process.stdout.write(
        await runStatusline(options.agent, parsePort(options.port), stdin),
      );
    });

  program
    .command("credential")
    .description(
      "Print the Authorization header for one Hive subject as JSON. Claude Code " +
        "runs this as an MCP headersHelper at connect time, so no capability " +
        "token is ever placed in an agent's environment.",
    )
    .requiredOption("--agent <name>", "subject name")
    .action((options: { agent: string }) => {
      process.exitCode = runCredentialHelper(options.agent);
    });

  program
    .command("channel-bridge")
    .description(
      "Run the stdio MCP bridge that pushes Hive messages into a Claude session",
    )
    .requiredOption("--agent <name>", "agent name")
    .requiredOption("--port <number>", "daemon port")
    .action(async (options: { agent: string; port: string }) => {
      await runChannelBridge(options.agent, parsePort(options.port));
    });

  program
    .command("recover [name]")
    .description(
      "Resume crashed agent sessions (all recoverable agents, or one by name)",
    )
    .action(async (name?: string) => {
      await recoverAgentsCli(name);
    });

  program
    .command("daemon")
    .description("Run the Hive daemon in the foreground")
    .action(runDaemon);

  // The Workspace app's status wire: NDJSON agent snapshots on stdout plus the
  // daemon-side viewer lease. Hidden because only the app spawns it.
  program
    .command("workspace-feed", { hidden: true })
    .requiredOption("--port <number>", "daemon port")
    .action(async (options: { port: string }) => {
      process.exitCode = await runWorkspaceFeedCli(parsePort(options.port));
    });

  // The Workspace master pane calls this private process boundary. Public
  // `hive claude|codex` launch the app; they must never be invoked from the
  // pane itself or the app would recursively open another Workspace.
  program
    .command("workspace-orchestrator", { hidden: true })
    .requiredOption("--tool <tool>", "claude or codex")
    .requiredOption("--port <number>", "daemon port")
    .action(async (options: { tool: string; port: string }) => {
      if (options.tool !== "claude" && options.tool !== "codex") {
        throw new Error(`unsupported orchestrator tool: ${options.tool}`);
      }
      process.exitCode = await launchOrchestrator(
        options.tool,
        parsePort(options.port),
      );
    });

  program
    .command("codex-app-server-host", { hidden: true })
    .requiredOption("--socket <path>")
    .requiredOption("--worktree <path>")
    .requiredOption("--port <number>")
    .requiredOption("--agent <name>")
    .action(async (options: CodexAppServerHostCliOptions) => {
      process.exitCode = await runCodexAppServerHost({
        socket: options.socket,
        worktree: options.worktree,
        daemonPort: parsePort(options.port),
        agentName: options.agent,
      });
    });

  return program;
}

export async function main(argv = process.argv): Promise<number> {
  try {
    // The passive update notice trails user-facing commands (npm/gh shape):
    // the check runs alongside the command, the line prints after it, and a
    // failed or slow check is silence, never an error or a stall.
    await withTrailingUpdateNotice(
      wantsUpdateNotice(argv),
      () => createProgram().parseAsync(argv),
    );
    const exitCode = process.exitCode;
    return typeof exitCode === "number" ? exitCode : Number(exitCode ?? 0);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || argv[2] === "event") {
        return 0;
      }
      return error.exitCode;
    }
    console.error(`hive: ${errorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
