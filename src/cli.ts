#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { runCodexAppServerHost } from "./adapters/tools/codex-app-server";
import { ensureStarted } from "./daemon/lifecycle";
import {
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
import { runStart } from "./cli/start";
import { runStatusline } from "./cli/statusline";
import {
  printUpdateStatus,
  runRollback,
  runUpdate,
  runUpdateCheck,
  runUpdateSkip,
} from "./cli/update";
import { launchWorkspace } from "./cli/workspace";
import { versionLine } from "./version";
import type { MemoryScope } from "./schemas";

export interface EventCliOptions {
  agent?: string;
  port?: string;
  payload?: string;
  contextPct?: string;
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

function parseContextPct(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const contextPct = Number(value);
  if (!Number.isFinite(contextPct) || contextPct < 0 || contextPct > 100) {
    throw new Error(`Invalid context percentage: ${value}`);
  }
  return contextPct;
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
  if (parsed.contextPct !== undefined) {
    if (typeof parsed.contextPct !== "number") {
      throw new Error("Event payload contextPct must be a number");
    }
    payload.contextPct = parseContextPct(String(parsed.contextPct));
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
  const cliContextPct = parseContextPct(options.contextPct);
  return {
    ...payload,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(cliContextPct === undefined ? {} : { contextPct: cliContextPct }),
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

  // Bare `hive` opens the installed release Workspace. Never a dev build.
  program.action(async () => {
    await launchWorkspace();
  });

  program
    .command("start")
    .description(
      "Check for updates and bring this project's Hive daemon up",
    )
    .action(async () => {
      await runStart();
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
    .description("Start a read-only Claude orchestrator")
    .action(async () => {
      const port = await ensureStarted();
      process.exitCode = await launchOrchestrator("claude", port);
    });

  program
    .command("codex")
    .description("Start a read-only Codex orchestrator")
    .action(async () => {
      const port = await ensureStarted();
      process.exitCode = await launchOrchestrator("codex", port);
    });

  program
    .command("status")
    .description("Show Hive agent status")
    .action(printStatus);

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

  const memory = program
    .command("memory")
    .description(
      "Search, read, write, delete, and reindex durable Hive memory facts",
    );

  memory.command("search <query>")
    .description("Full-text search memory facts")
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
    .description("Create or update a memory fact")
    .requiredOption("--scope <scope>", "repo or global")
    .requiredOption("--body <text>", "fact body (Markdown)")
    .option("--id <id>", "existing fact id to overwrite")
    .option("--tags <tags>", "comma-separated tags")
    .option("--date <yyyy-mm-dd>", "fact date (defaults to today)")
    .action(async (title: string, options: {
      scope: string;
      body: string;
      id?: string;
      tags?: string;
      date?: string;
    }) => {
      await writeMemoryCli({
        scope: parseMemoryScope(options.scope),
        title,
        body: options.body,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.tags === undefined ? {} : {
          tags: options.tags.split(",").map((tag) => tag.trim()).filter((
            tag,
          ) => tag.length > 0),
        }),
        ...(options.date === undefined ? {} : { date: options.date }),
      });
    });

  memory.command("read <scope> <id>")
    .description("Print one full memory fact")
    .action(async (scope: string, id: string) => {
      await readMemoryCli(parseMemoryScope(scope), id);
    });

  memory.command("delete <scope> <id>")
    .description("Delete one memory fact")
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
    .option("--context-pct <number>", "agent context utilization")
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
    await createProgram().parseAsync(argv);
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
