#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { ensureStarted } from "./daemon/lifecycle";
import {
  printQuotaStatus,
  printStatus,
  recordQuotaObservation,
  stopHive,
  watchAgent,
} from "./cli/control";
import { runDaemon } from "./cli/daemon";
import { runHiveEvent, type HookEventOptions } from "./cli/event";
import { launchOrchestrator } from "./cli/orchestrator";

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

function parseNonnegative(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a nonnegative number`);
  }
  return number;
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

  program
    .command("watch <name>")
    .description("Open a viewer for a named agent")
    .action(watchAgent);

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
        await runHiveEvent(
          kind,
          parsePort(options.port),
          buildEventOptions(options),
        );
      } catch {
        // Commander option parsing and hook delivery must not break agent turns.
      }
    });

  program
    .command("daemon")
    .description("Run the Hive daemon in the foreground")
    .action(runDaemon);

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
