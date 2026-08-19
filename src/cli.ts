#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { runAgentUi } from "./cli/agent-ui/run";
import {
  attachGrantCli,
  autonomyCli,
  deleteMemoryCli,
  killAgentCli,
  killOrigin,
  printQuotaStatus,
  printStatus,
  readMemoryCli,
  recordQuotaObservation,
  recoverAgentsCli,
  reindexMemoryCli,
  searchMemoryCli,
  stopHive,
  writeMemoryCli,
} from "./cli/control";
import { runCredentialHelper } from "./cli/credential";
import { runDaemon } from "./cli/daemon";
import {
  type HookEventOptions,
  readHookStdin,
  runHiveEvent,
} from "./cli/event-command";
import { runGraphifyStatus } from "./cli/graphify-command";
import { runInitCli } from "./cli/init";
import { memoryConsolidateCli } from "./cli/memory-consolidate";
import { printModelControlSnapshot } from "./cli/model-control";
import { printErrors } from "./cli/observability-command";
import { runWorkspaceOrchestrator } from "./cli/orchestrator-supervisor";
import { promoteDefaultModelControl } from "./cli/promote-default";
import { runQAControl } from "./cli/qa-control";
import { printRouting } from "./cli/routing";
import {
  exportRoutingPolicy,
  printRoutingPolicy,
  setModelEffort,
  setModelPolicy,
  setProviderPolicy,
  setRoute,
} from "./cli/routing-policy-command";
import { runUninstall } from "./cli/uninstall";
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
import {
  verifyDaemonInstance,
  verifyDaemonInstanceWhenReady,
} from "./daemon/lifecycle/daemon-lifecycle";
import {
  printInstances,
  selectInstanceFromArgv,
} from "./daemon/lifecycle/instances";
import { projectRootOrCwd } from "./daemon/project-identity-core/project-root";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "./schemas/capability";
import {
  type MemoryScope,
  type MemorySource,
  type MemoryVerificationStatus,
  MemoryVerificationStatusSchema,
  MemoryWriterSourceSchema,
} from "./schemas/memory";
import {
  SessionLocatorSchema,
  TerminalGeometrySchema,
} from "./schemas/session-protocol";
import { isDaemonPort } from "./shared/daemon-port";
import { errorMessage } from "./shared/error-message";
import { isRecord } from "./shared/is-record";
import { versionLine } from "./shared/version";

export interface EventCliOptions {
  agent?: string;
  port?: string;
  instanceId?: string;
  providerRunId?: string;
  payload?: string;
  description?: string;
  usageUnits?: string;
  usageSource?: "provider" | "gateway" | "estimated";
}

interface QuotaReconcileOptions {
  provider: CapabilityProvider;
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

function parseMemoryScope(value: string): MemoryScope {
  if (value !== "repo" && value !== "global") {
    throw new Error(`Invalid memory scope "${value}": expected repo or global`);
  }
  return value;
}

function parseMemorySource(value: string): Exclude<MemorySource, "legacy"> {
  const parsed = MemoryWriterSourceSchema.safeParse(
    value === "human" ? "user" : value,
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid memory source "${value}": expected init, agent, orchestrator, or user`,
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

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!isDaemonPort(port)) {
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
    if (
      usageSource !== "provider" &&
      usageSource !== "gateway" &&
      usageSource !== "estimated"
    ) {
      throw new Error("Event payload usageSource is invalid");
    }
    payload.usageSource = usageSource;
  }
  const toolSessionId =
    parsed["thread-id"] ??
    parsed.threadId ??
    parsed["session-id"] ??
    parsed.sessionId ??
    parsed.session_id;
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
    ...(options.providerRunId === undefined
      ? {}
      : { providerRunId: options.providerRunId }),
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
    .description(
      "Coordinate named Claude Code, Codex, Grok, Kimi Code, and OpenCode agents",
    )
    .option("--instance <name>", "use a named isolated Hive instance")
    .showHelpAfterError()
    .exitOverride();

  program.version(versionLine(), "-v, --version", "Print the Hive version");

  // Bare `hive` opens the project the shell is in: resolve the repo root, run the shared session boundary, and hand the app the project and daemon port. Outside a git repo it launches the app standalone (placeholder window) — the project-neutral home a Dock click gets. Never a dev Workspace build.
  program.action(async () => {
    process.exitCode = await runWorkspace();
  });

  program
    .command("instances")
    .description("List the default and named Hive instances")
    .action(printInstances);

  program
    .command("init")
    .description(
      "Scaffold this repo's agent conventions and seed its memory without starting Hive",
    )
    .option(
      "--scaffold-agents",
      "offer to scaffold an AGENTS.md when none exists",
    )
    .option(
      "--seed-facts <path>",
      "JSON file of narrative facts to seed (source: init)",
    )
    .option(
      "--force",
      "replace a Hive skill you have edited with the version Hive ships",
    )
    .action(
      async (options: {
        scaffoldAgents?: boolean;
        seedFacts?: string;
        force?: boolean;
      }) => {
        const root = projectRootOrCwd();
        await runInitCli({
          cwd: root,
          ...(options.scaffoldAgents === undefined
            ? {}
            : { scaffoldAgents: options.scaffoldAgents }),
          ...(options.seedFacts === undefined
            ? {}
            : { seedFacts: options.seedFacts }),
          ...(options.force === undefined ? {} : { force: options.force }),
        });
      },
    );

  program
    .command("uninstall")
    .description(
      "Completely remove Hive from this machine; --repo removes it from the current repo instead",
    )
    .option(
      "--repo",
      "remove only what Hive installed into (and derived for) this repo",
    )
    .option(
      "--yes",
      "skip the confirmation prompt (required when not on a terminal)",
    )
    .option(
      "--purge",
      "retain nothing, overriding this variant's configured retention",
    )
    .action(
      async (options: { repo?: boolean; yes?: boolean; purge?: boolean }) => {
        process.exitCode = await runUninstall(projectRootOrCwd(), {
          ...(options.repo === undefined ? {} : { repo: options.repo }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.purge === undefined ? {} : { purge: options.purge }),
        });
      },
    );

  const update = program
    .command("update [version]")
    .description(
      "Update the installed Hive to the latest (or an exact) release",
    )
    .action(async (version?: string) => {
      await runUpdate(version);
    });

  update
    .command("check")
    .description("Check for a newer release; exit 10 when one is available")
    .action(async () => {
      process.exitCode = await runUpdateCheck();
    });

  update
    .command("status")
    .description(
      "Show version, install method, retained versions, and last check",
    )
    .action(printUpdateStatus);

  update
    .command("rollback")
    .description("Reactivate the retained previous version")
    .action(runRollback);

  update
    .command("skip")
    .description("Silence update notices for the currently offered version")
    .action(runUpdateSkip);

  program
    .command("status")
    .description("Show Hive agent status")
    .action(printStatus);

  program
    .command("errors")
    .description("Audit daemon-recorded Hive failures and warnings")
    .option("--since <iso>", "only events at or after this ISO timestamp")
    .option("--until <iso>", "only events at or before this ISO timestamp")
    .option("--severity <level>", "error or warning")
    .option(
      "--source <source>",
      "mcp-tool, mcp-transport, provider, session, background, or daemon",
    )
    .option("--subject <name>", "agent or orchestrator subject")
    .option("--session <id>", "provider run id or vendor session id")
    .option("--tool <name>", "MCP tool name")
    .option("--limit <number>", "maximum events", "100")
    .option("--json", "print canonical events as JSON")
    .option("--port <number>", "daemon port")
    .action(
      (options: {
        since?: string;
        until?: string;
        severity?: string;
        source?: string;
        subject?: string;
        session?: string;
        tool?: string;
        limit?: string;
        json?: boolean;
        port?: string;
      }) => {
        const { port, ...filters } = options;
        return printErrors({
          ...filters,
          ...(port === undefined ? {} : { port: parsePort(port) }),
        });
      },
    );

  const routing = program
    .command("routing")
    .description(
      "Show routing policy beside live model, billing, and discovery facts",
    )
    .action(printRouting);
  routing
    .command("policy")
    .description(
      "Print the routing policy document (the Model Control Center's read surface). " +
        "Absent entries mean NOT CONFIGURED, never enabled.",
    )
    .option("--port <number>", "daemon port")
    .action((options: { port?: string }) =>
      printRoutingPolicy(
        options.port === undefined ? undefined : parsePort(options.port),
      ),
    );
  routing
    .command("export")
    .description(
      "Deterministic, diff-stable dump of the routing policy (same document, canonical order)",
    )
    .option("--port <number>", "daemon port")
    .action((options: { port?: string }) =>
      exportRoutingPolicy(
        options.port === undefined ? undefined : parsePort(options.port),
      ),
    );
  routing
    .command("promote-default")
    .description(
      "Replace the machine default's Model Control policy with this instance's (discarding its existing policy)",
    )
    .action(async () => {
      const result = await promoteDefaultModelControl();
      console.log(
        `Promoted Model Control revision ${result.sourceRevision} to machine default revision ${result.targetRevision}.`,
      );
    });
  routing
    .command("set-provider <provider> <state>")
    .description(
      "Set a provider's master switch. Enabling is consenting to spend on that vendor; " +
        "disabled overrides every model row under it; unset returns it to unconfigured.",
    )
    .requiredOption(
      "--expect-revision <revision>",
      "the policy revision you read (compare-and-set; stale writes are rejected)",
    )
    .option("--port <number>", "daemon port")
    .action(
      (
        provider: string,
        state: string,
        options: { expectRevision: string; port?: string },
      ) =>
        setProviderPolicy(
          provider,
          state,
          options.expectRevision,
          options.port === undefined ? undefined : parsePort(options.port),
        ),
    );
  routing
    .command("set-model <provider> <model> <state>")
    .description(
      "Set one model's enablement. Enabling IS the consent to spend on it; " +
        "unset leaves the model unconfigured even when its provider is enabled.",
    )
    .requiredOption(
      "--expect-revision <revision>",
      "the policy revision you read (compare-and-set; stale writes are rejected)",
    )
    .option("--port <number>", "daemon port")
    .action(
      (
        provider: string,
        model: string,
        state: string,
        options: { expectRevision: string; port?: string },
      ) =>
        setModelPolicy(
          provider,
          model,
          state,
          options.expectRevision,
          options.port === undefined ? undefined : parsePort(options.port),
        ),
    );
  routing
    .command("set-effort <provider> <model> <effort>")
    .description(
      "Set explicit effort intent: hive-decides, never-configured, exact:LEVEL, " +
        "none, provider-controlled, or unset. Never changes enablement.",
    )
    .requiredOption(
      "--expect-revision <revision>",
      "the policy revision you read (compare-and-set; stale writes are rejected)",
    )
    .option("--port <number>", "daemon port")
    .action(
      (
        provider: string,
        model: string,
        effort: string,
        options: { expectRevision: string; port?: string },
      ) =>
        setModelEffort(
          provider,
          model,
          effort,
          options.expectRevision,
          options.port === undefined ? undefined : parsePort(options.port),
        ),
    );
  routing
    .command("set-route <scope> <mode> [candidates...]")
    .description(
      "Replace one scope's route (a category or `global`; zero candidates " +
        "clears it). Mode is user-weighted or hive-equal. Every candidate " +
        "names a specific model: provider/model[@LEVEL|@none][=WEIGHT], " +
        "weight an integer 1-100 (default 1).",
    )
    .requiredOption(
      "--expect-revision <revision>",
      "the policy revision you read (compare-and-set; stale writes are rejected)",
    )
    .option("--port <number>", "daemon port")
    .action(
      (
        scope: string,
        mode: string,
        candidates: string[],
        options: { expectRevision: string; port?: string },
      ) =>
        setRoute(
          scope,
          mode,
          candidates,
          options.expectRevision,
          options.port === undefined ? undefined : parsePort(options.port),
        ),
    );

  program
    .command("kill <agent>")
    .description(
      "Close an agent immediately and reap everything it started (vendor CLI, " +
        "Codex host, MCP children). Unlanded work is preserved as a git ref, " +
        "never discarded",
    )
    .option("--port <number>", "daemon port")
    .option("--session-locator <json>", "exact pane session locator")
    .action(
      async (
        agent: string,
        options: { port?: string; sessionLocator?: string },
      ) => {
        const locator =
          options.sessionLocator === undefined
            ? undefined
            : SessionLocatorSchema.parse(JSON.parse(options.sessionLocator));
        await killAgentCli(
          agent,
          options.port === undefined ? undefined : parsePort(options.port),
          locator,
          killOrigin("kill"),
        );
      },
    );

  program
    .command("workspace-attach <agent>")
    .description(
      "Request a one-use viewer attach grant for the pane's exact sessiond " +
        "session and print it as JSON (Workspace renderer plumbing)",
    )
    .requiredOption("--session-locator <json>", "exact pane session locator")
    .requiredOption("--viewer-id <id>", "renderer viewer identity")
    .requiredOption("--geometry <json>", "terminal geometry for the grant")
    .option("--port <number>", "daemon port")
    .action(
      async (
        agent: string,
        options: {
          port?: string;
          sessionLocator: string;
          viewerId: string;
          geometry: string;
        },
      ) => {
        const locator = SessionLocatorSchema.parse(
          JSON.parse(options.sessionLocator),
        );
        const geometry = TerminalGeometrySchema.parse(
          JSON.parse(options.geometry),
        );
        await attachGrantCli(
          agent,
          locator,
          options.viewerId,
          geometry,
          options.port === undefined ? undefined : parsePort(options.port),
        );
      },
    );

  program
    .command("autonomy [mode]")
    .description(
      "Show or set agent autonomy: sandboxed (approvals queue) or " +
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

  quota
    .command("reconcile")
    .description("Record a manual provider dashboard observation")
    .requiredOption(
      "--provider <provider>",
      "claude, codex, grok, kimi, or opencode",
    )
    .option("--account <account>", "account scope", "default")
    .requiredOption("--pool <pool>", "configured quota pool")
    .requiredOption("--five-hour-used <units>", "used 5-hour units")
    .requiredOption("--weekly-used <units>", "used weekly units")
    .option("--observed-at <iso>", "observation time")
    .option("--five-hour-reset-at <iso>", "known 5-hour reset time")
    .option("--weekly-reset-at <iso>", "known weekly reset time")
    .action(async (options: QuotaReconcileOptions) => {
      const provider = CapabilityProviderSchema.safeParse(options.provider);
      if (!provider.success)
        throw new Error(
          "provider must be claude, codex, grok, kimi, or opencode",
        );
      await recordQuotaObservation({
        provider: provider.data,
        account: options.account,
        pool: options.pool,
        fiveHourUsed: parseNonnegative(options.fiveHourUsed, "five-hour-used"),
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
      "Inspect Hive's required local code knowledge graph (docs/graphify/integration.md)",
    );

  graphify
    .command("status")
    .description("Show pin, install state, and graph freshness for this repo")
    .action(async () => {
      process.exitCode = await runGraphifyStatus(projectRootOrCwd());
    });

  const memory = program
    .command("memory")
    .description(
      "Search, read, write, delete, and reindex durable Hive memory articles",
    );

  memory
    .command("search <query>")
    .description("Full-text search compiled memory articles")
    .option("--scope <scope>", "repo or global")
    .option("--limit <n>", "max results")
    .action(
      async (query: string, options: { scope?: string; limit?: string }) => {
        await searchMemoryCli(query, {
          ...(options.scope === undefined
            ? {}
            : { scope: parseMemoryScope(options.scope) }),
          ...(options.limit === undefined
            ? {}
            : { limit: parseNonnegative(options.limit, "limit") }),
        });
      },
    );

  memory
    .command("write <title>")
    .description(
      "Record an observation and create or update its compiled article",
    )
    .requiredOption("--scope <scope>", "repo or global")
    .requiredOption("--topic <topic>", "lowercase kebab-case topic")
    .requiredOption("--body <text>", "fact body (Markdown)")
    .requiredOption("--source <source>", "init, agent, orchestrator, or user")
    .requiredOption(
      "--evidence <text>",
      "what was measured or supplied, and where",
    )
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
    .action(
      async (
        title: string,
        options: {
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
        },
      ) => {
        await writeMemoryCli({
          scope: parseMemoryScope(options.scope),
          topic: options.topic,
          title,
          body: options.body,
          source: parseMemorySource(options.source),
          evidence: options.evidence,
          status: parseMemoryStatus(options.status),
          supersedes: options.supersedes
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
          ...(options.id === undefined ? {} : { id: options.id }),
          ...(options.tags === undefined
            ? {}
            : {
                tags: options.tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter((tag) => tag.length > 0),
              }),
          ...(options.date === undefined ? {} : { date: options.date }),
          ...(options.verified === undefined
            ? {}
            : { verified: options.verified }),
        });
      },
    );

  memory
    .command("read <scope> <id>")
    .description("Print one compiled memory article")
    .action(async (scope: string, id: string) => {
      await readMemoryCli(parseMemoryScope(scope), id);
    });

  memory
    .command("delete <scope> <id>")
    .description("Delete one compiled memory article")
    .action(async (scope: string, id: string) => {
      await deleteMemoryCli(parseMemoryScope(scope), id);
    });

  memory
    .command("reindex")
    .description(
      "Rebuild the memory search index from the Markdown files on disk",
    )
    .action(reindexMemoryCli);

  memory
    .command("consolidate")
    .description(
      "Consolidation dedup (report first): pairwise cosine over the memory " +
        "vector store; --apply uses the live daemon when present and " +
        "supersedes only >=0.95 identical pairs",
    )
    .option(
      "--apply",
      "supersede identical-bucket pairs (older into newer); the similar " +
        "bucket is never auto-applied",
    )
    .action(async (options: { apply?: boolean }) => {
      process.exitCode = await memoryConsolidateCli(options);
    });

  program
    .command("stop")
    .description("Stop live agents and the Hive daemon")
    .option(
      "--force",
      "stop even when agents hold unlanded work (skips the confirmation)",
    )
    .action((options: { force?: boolean }) =>
      stopHive({ force: options.force === true, invokedViaCli: true }),
    );

  program
    .command("event <kind>")
    .description("Post an agent hook event")
    .option("--agent <name>", "agent name")
    .option("--port <number>", "daemon port")
    .requiredOption("--instance-id <id>", "expected Hive instance identity")
    .option("--provider-run-id <id>", "expected active provider run")
    .option("--payload <json>", "tool hook JSON payload")
    .option("--description <text>", "approval description")
    .option("--usage-units <number>", "provider or gateway usage units")
    .option("--usage-source <source>", "provider, gateway, or estimated")
    .action(async (kind: string, options: EventCliOptions) => {
      try {
        if (options.instanceId === undefined) {
          throw new Error("--instance-id is required");
        }
        await verifyDaemonInstance(parsePort(options.port), options.instanceId);
        const captured = await readHookStdin();
        await runHiveEvent(kind, parsePort(options.port), {
          ...captured,
          ...buildEventOptions(options),
        });
      } catch {
        // Commander option parsing and hook delivery must not break agent turns.
      }
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
    .command("recover [name]")
    .description(
      "Report-only: check which crashed agents' terminal sessions are confirmed dead (all recoverable agents, or one by name)",
    )
    .action(async (name?: string) => {
      await recoverAgentsCli(name);
    });

  program
    .command("daemon")
    .description("Run the Hive daemon in the foreground")
    .action(runDaemon);

  // The Workspace app's Model Control Center read surface: one JSON document of capability catalogs, billing guard state, and quota statuses. Hidden because only the app spawns it.
  program
    .command("model-control-snapshot", { hidden: true })
    .option("--port <number>", "daemon port")
    .action((options: { port?: string }) =>
      printModelControlSnapshot(
        options.port === undefined ? undefined : parsePort(options.port),
      ),
    );

  // The protocol terminal frontend. It owns the pane's alternate screen and speaks to the vendor over pipes, so the only process reading terminal input is this one. Hidden because sessiond spawns it, not a person.
  program
    .command("agent-ui", { hidden: true })
    .requiredOption("--subject <agent>", "agent this pane belongs to")
    .requiredOption("--provider <vendor>", "installed vendor runtime")
    .option("--executable <path>", "resolved installed binary")
    .requiredOption(
      "--port <number>",
      "daemon port for mail-ready, protocol session facts, and runtime reports",
    )
    .requiredOption("--provider-run-id <id>", "provider run identity")
    .option("--model <model>", "selected provider model")
    .option("--effort <effort>", "selected provider effort")
    .option("--read-only", "use the provider's reduced-authority posture")
    .option("--instruction <path>", "system instruction file")
    .option("--provider-argv <json>", "provider protocol argv")
    .option("--kickoff <text>", "initial protocol submission")
    .requiredOption("--worktree <path>", "agent worktree")
    .requiredOption("--journal <path>", "durable outbound journal")
    .action(
      async (options: {
        subject: string;
        provider: string;
        executable?: string;
        port: string;
        providerRunId: string;
        model?: string;
        effort?: string;
        readOnly?: boolean;
        instruction?: string;
        providerArgv?: string;
        kickoff?: string;
        worktree: string;
        journal: string;
      }) => {
        process.exitCode = await runAgentUi({
          subject: options.subject,
          provider: options.provider,
          ...(options.executable === undefined
            ? {}
            : { executable: options.executable }),
          daemonPort: parsePort(options.port),
          providerRunId: options.providerRunId,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          readOnly: options.readOnly === true,
          ...(options.instruction === undefined
            ? {}
            : { instructionPath: options.instruction }),
          ...(options.providerArgv === undefined
            ? {}
            : { providerArgv: JSON.parse(options.providerArgv) as string[] }),
          ...(options.kickoff === undefined
            ? {}
            : { kickoff: options.kickoff }),
          worktreePath: options.worktree,
          journalPath: options.journal,
        });
      },
    );

  // The Workspace app's status wire: NDJSON agent snapshots on stdout plus the daemon-side viewer lease. Hidden because only the app spawns it.
  program
    .command("qa-control", { hidden: true })
    .argument("<verb>", "enumerate or invoke")
    .argument("[identifier]", "live control identifier")
    .option("--input <value>", "native control input")
    .action(
      async (
        verb: string,
        identifier: string | undefined,
        options: { input?: string },
      ) => {
        if (verb !== "enumerate" && verb !== "invoke") {
          process.stderr.write("NO MEASUREMENT: unknown qa-control verb\n");
          process.exitCode = 2;
          return;
        }
        process.exitCode = await runQAControl(verb, identifier, options.input);
      },
    );

  program
    .command("workspace-feed", { hidden: true })
    .requiredOption("--port <number>", "daemon port")
    .requiredOption("--instance-id <id>", "expected Hive instance identity")
    .requiredOption("--workspace-session-id <id>", "Workspace launch identity")
    .action(
      async (options: {
        port: string;
        instanceId: string;
        workspaceSessionId: string;
      }) => {
        process.exitCode = await runWorkspaceFeedCli(
          parsePort(options.port),
          options.workspaceSessionId,
          options.instanceId,
        );
      },
    );

  // The Workspace starts this private process boundary. Public `hive` launches the app; this command must never be a user-facing launch verb or the app would recursively open another Workspace.
  program
    .command("workspace-orchestrator", { hidden: true })
    .requiredOption("--tool <tool>", "claude, codex, grok, kimi, or opencode")
    .requiredOption("--port <number>", "daemon port")
    .requiredOption("--instance-id <id>", "expected Hive instance identity")
    .action(
      async (options: { tool: string; port: string; instanceId: string }) => {
        await verifyDaemonInstanceWhenReady(
          parsePort(options.port),
          options.instanceId,
        );
        const tool = CapabilityProviderSchema.safeParse(options.tool);
        if (!tool.success) {
          throw new Error(`unsupported orchestrator tool: ${options.tool}`);
        }
        process.exitCode = await runWorkspaceOrchestrator(
          tool.data,
          parsePort(options.port),
        );
      },
    );

  return program;
}

export async function main(argv = process.argv): Promise<number> {
  try {
    selectInstanceFromArgv(argv);
    // The passive update notice trails user-facing commands (npm/gh shape): the check runs alongside the command, the line prints after it, and a failed or slow check is silence, never an error or a stall.
    await withTrailingUpdateNotice(wantsUpdateNotice(argv), () =>
      createProgram().parseAsync(argv),
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
