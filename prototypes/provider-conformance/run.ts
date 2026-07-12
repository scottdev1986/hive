#!/usr/bin/env bun
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinding } from "./binding";
import { prepareClaude } from "./claude";
import { prepareCodex } from "./codex";
import { evidenceForResults, plannedEvidence } from "./evidence";
import { evaluate } from "./evaluator";
import { expectedCost, INVALID_MODEL, PROMPTS } from "./prompts";
import {
  PROVIDERS,
  SCENARIOS,
  scenarioApplies,
  type ConformanceReport,
  type PreparedAdapter,
  type Provider,
  type Scenario,
} from "./types";

type Mode = "dry-run" | "probe" | "live";

interface Options {
  mode: Mode;
  providers: Provider[];
  scenarios: Scenario[];
  allowBillable: boolean;
  claudePath?: string;
  codexPath?: string;
  claudeModel?: string;
  codexModel?: string;
  outputDirectory: string;
  timeoutMs: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return `Hive provider-neutral conformance fixture

Usage:
  bun run prototypes/provider-conformance/run.ts [--dry-run]
  bun run prototypes/provider-conformance/run.ts --probe [options]
  bun run prototypes/provider-conformance/run.ts --live --allow-billable [options]

Modes:
  --dry-run          Print the exact scenario and billing plan; start no provider process (default).
  --probe            Run only documented non-billable binding, schema, and model-catalog probes.
  --live             Run the selected scenario set. Billable or cost-unknown work is refused unless
                     --allow-billable is also present.

Options:
  --provider <name>  all, claude, or codex (default: all)
  --scenario <name>  all or one of: ${SCENARIOS.join(", ")} (repeatable)
  --claude <path>    Absolute Claude executable binding. PATH is discovery only.
  --codex <path>     Absolute Codex executable binding. PATH is discovery only.
  --claude-model <id>  Concrete Claude pin. Default: resolved haiku entry from initialize.models[].
  --codex-model <id>   Concrete Codex pin. Default: model/list entry marked isDefault.
  --output <dir>     Run artifacts (default: prototypes/provider-conformance/runs)
  --timeout-ms <n>   Per protocol wait timeout (default: 90000)
  --allow-billable  Explicit authorization required for any billable or cost-unknown scenario.
  --help             Show this text without running a probe.

The fixture never invokes guessed subcommands. In particular it never runs 'claude models'.`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(args: string[]): Options {
  let mode: Mode = "dry-run";
  let providers: Provider[] = [...PROVIDERS];
  const scenarios: Scenario[] = [];
  let allowBillable = false;
  let claudePath: string | undefined;
  let codexPath: string | undefined;
  let claudeModel: string | undefined;
  let codexModel: string | undefined;
  let outputDirectory = join(HERE, "runs");
  let timeoutMs = 90_000;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "--probe") {
      mode = "probe";
    } else if (arg === "--live") {
      mode = "live";
    } else if (arg === "--allow-billable") {
      allowBillable = true;
    } else if (arg === "--provider") {
      const value = requireValue(args, index, arg);
      index += 1;
      if (value === "all") providers = [...PROVIDERS];
      else if (value === "claude" || value === "codex") providers = [value];
      else throw new Error(`Unknown provider: ${value}`);
    } else if (arg === "--scenario") {
      const value = requireValue(args, index, arg);
      index += 1;
      if (value === "all") scenarios.splice(0, scenarios.length, ...SCENARIOS);
      else if ((SCENARIOS as readonly string[]).includes(value)) scenarios.push(value as Scenario);
      else throw new Error(`Unknown scenario: ${value}`);
    } else if (arg === "--claude") {
      claudePath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--codex") {
      codexPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--claude-model") {
      claudeModel = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--codex-model") {
      codexModel = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      outputDirectory = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(requireValue(args, index, arg));
      index += 1;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
        throw new Error("--timeout-ms must be an integer of at least 1000");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    mode,
    providers,
    scenarios: scenarios.length === 0 ? [...SCENARIOS] : [...new Set(scenarios)],
    allowBillable,
    claudePath,
    codexPath,
    claudeModel,
    codexModel,
    outputDirectory,
    timeoutMs,
  };
}

export function requiresBillableAuthorization(options: Options): string[] {
  if (options.mode !== "live") return [];
  const gated: string[] = [];
  for (const provider of options.providers) {
    for (const scenario of options.scenarios) {
      if (!scenarioApplies(provider, scenario)) continue;
      const cost = expectedCost(provider, scenario);
      if (cost !== "non-billable") gated.push(`${provider}/${scenario}:${cost}`);
    }
  }
  return gated;
}

function discoveredExecutable(provider: Provider, explicit?: string): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error(`--${provider} must be an absolute path`);
    return explicit;
  }
  const discovered = Bun.which(provider);
  if (discovered === null) throw new Error(`Could not discover ${provider}; pass --${provider} /absolute/path`);
  return discovered;
}

function printPlan(options: Options): void {
  console.log(`mode: ${options.mode}`);
  console.log(`providers: ${options.providers.join(", ")}`);
  console.log(`scenarios: ${options.scenarios.join(", ")}`);
  console.log("scenario prompts and expected billing:");
  for (const provider of options.providers) {
    for (const scenario of options.scenarios) {
      if (!scenarioApplies(provider, scenario)) continue;
      console.log(`- ${provider}/${scenario}: ${expectedCost(provider, scenario)} — ${PROMPTS[scenario].purpose}`);
    }
  }
  console.log("no guessed provider subcommands are used; fallback flags are never configured");
}

async function prepareAdapters(options: Options, runDirectory: string): Promise<PreparedAdapter[]> {
  const adapters: PreparedAdapter[] = [];
  for (const provider of options.providers) {
    const requested = discoveredExecutable(
      provider,
      provider === "claude" ? options.claudePath : options.codexPath,
    );
    const binding = await resolveBinding(provider, requested);
    const preflightDirectory = join(runDirectory, provider, "preflight");
    const adapter = provider === "claude"
      ? await prepareClaude({
        binding,
        selectedModel: options.claudeModel,
        preflightDirectory,
        timeoutMs: options.timeoutMs,
      })
      : await prepareCodex({
        binding,
        selectedModel: options.codexModel,
        preflightDirectory,
        timeoutMs: options.timeoutMs,
      });
    adapters.push(adapter);
  }
  return adapters;
}

function runId(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  printPlan(options);
  if (options.mode === "dry-run") return;

  const gated = requiresBillableAuthorization(options);
  if (gated.length > 0 && !options.allowBillable) {
    throw new Error(
      `Refusing billable or cost-unknown provider turns without --allow-billable:\n${gated.map((item) => `  ${item}`).join("\n")}`,
    );
  }

  const id = runId();
  const outputRoot = isAbsolute(options.outputDirectory)
    ? options.outputDirectory
    : await realpath(options.outputDirectory).catch(() => join(process.cwd(), options.outputDirectory));
  const directory = join(outputRoot, id);
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const adapters = await prepareAdapters(options, directory);

  if (options.mode === "probe") {
    const preflight = adapters.map((adapter) => ({
      provider: adapter.provider,
      binding: adapter.binding,
      selectedModel: adapter.selectedModel,
      provenance: adapter.preflightProvenance,
      billable: "no",
    }));
    await Bun.write(join(directory, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);
    console.log(`non-billable preflight written to ${join(directory, "preflight.json")}`);
    return;
  }

  const results = [];
  for (const adapter of adapters) {
    for (const scenario of options.scenarios) {
      if (!scenarioApplies(adapter.provider, scenario)) continue;
      const scenarioDirectory = join(directory, adapter.provider, scenario);
      const run = await adapter.run(scenario, {
        runId: id,
        runDirectory: directory,
        scenarioDirectory,
        selectedModel: adapter.selectedModel,
        invalidModel: INVALID_MODEL,
        timeoutMs: options.timeoutMs,
      });
      const result = evaluate(run);
      results.push(result);
      console.log(`${result.outcome.toUpperCase()} ${adapter.provider}/${scenario}`);
      for (const item of result.assertions.filter((assertion) => !assertion.pass)) {
        console.log(`  FAIL ${item.id}: ${item.detail}`);
      }
    }
  }

  const report: ConformanceReport = {
    schemaVersion: 1,
    runId: id,
    startedAt,
    completedAt: new Date().toISOString(),
    live: true,
    billableExecutionAuthorized: options.allowBillable,
    scenarios: options.scenarios,
    providers: options.providers,
    results,
    evidence: evidenceForResults(results),
  };
  const reportPath = join(directory, "report.json");
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${reportPath}`);
  if (results.some((result) => result.outcome !== "pass")) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export function dryRunEvidence(options: Options) {
  return options.providers.flatMap((provider) =>
    options.scenarios
      .filter((scenario) => scenarioApplies(provider, scenario))
      .map((scenario) => plannedEvidence(provider, scenario))
  );
}
