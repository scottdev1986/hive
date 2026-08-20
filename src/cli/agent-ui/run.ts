import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CliRenderer,
  type CliRendererConfig,
  createCliRenderer,
} from "@opentui/core";
import onetime from "onetime";
import {
  openProviderSession,
  type ResumeDecision,
} from "../../adapters/providers/protocol/durable-session";
import { FakeProviderAdapter } from "../../adapters/providers/protocol/fake-driver";
import { kimiSessionMode } from "../../adapters/providers/protocol/kimi-acp-adapter";
import type {
  NormalizedProviderEvent,
  ProviderRuntimeAdapter,
  ProviderSession,
  ProviderSpawn,
  SessionStart,
  VendorSessionRef,
} from "../../adapters/providers/protocol/types";
import { getProviderRuntimeAdapter } from "../../adapters/providers/provider-registry";
import { macProcessIdentity } from "../../daemon/lifecycle/daemon-lifecycle";
import {
  type ProviderStatusForwarder,
  providerStatusForwarder,
} from "../../daemon/status-service/status-service";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../../schemas/capability";
import type {
  FrontendWakeReport,
  MailReadyNotice,
} from "../../schemas/mail-wake";
import { errorMessage } from "../../shared/error-message";
import { agentFetch } from "../credential";
import {
  AgentUi,
  type PaneIdentity,
  type UiDiagnosticReport,
} from "./agent-ui";
import { MailLeaseHeartbeat } from "./mail-lease-heartbeat";
import { MailReadyClient } from "./mail-ready-client";
import { MailWakeReporter } from "./mail-wake-reporter";
import { PaneObservabilityReporter } from "./observability-reporter";
import { OutboundJournal } from "./outbound-journal";
import { PaneDaemonClient } from "./pane-daemon-client";
import {
  ProviderPermissionClient,
  type ProviderPermissionSettlementOutcome,
} from "./provider-permission-client";
import { fetchQueenCompactReload } from "./queen-compact-reload-client";
import { QuotaWarningClient } from "./quota-warning";
import { observeAdapterChild, providerRuntimeReporter } from "./runtime-report";

interface AgentUiSessionOptions {
  readonly subject: string;
  readonly provider: string;
  readonly executable?: string;
  readonly worktreePath: string;
  readonly journalPath: string;
  readonly model?: string;
  readonly effort?: string;
  readonly readOnly?: boolean;
  readonly instructionPath?: string;
  readonly providerArgv?: readonly string[];
  readonly kickoff?: string;
}

type AgentUiControlPlaneOptions =
  | {
      readonly daemonPort: number;
      readonly providerRunId: string;
    }
  | {
      readonly daemonPort?: undefined;
      readonly providerRunId?: undefined;
    };

export type AgentUiOptions = AgentUiSessionOptions & AgentUiControlPlaneOptions;

const MAIL_POLL_INTERVAL_MS = 2_000;
const QUOTA_POLL_INTERVAL_MS = 30_000;

export const AGENT_UI_CONSOLE_OPTIONS = {
  consoleMode: "console-overlay",
  openConsoleOnError: false,
} as const satisfies Pick<
  CliRendererConfig,
  "consoleMode" | "openConsoleOnError"
>;

const VENDOR_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi Code",
  opencode: "OpenCode",
  fake: "Fake Provider",
};

/** The installed vendor's own protocol adapter, or the fake driver for tests. A provider with no adapter is refused by name: there is deliberately no branch that falls back to launching that vendor's own TUI. */
function adapterFor(provider: string): ProviderRuntimeAdapter {
  if (provider === "fake") return new FakeProviderAdapter();
  const known = CapabilityProviderSchema.safeParse(provider);
  if (!known.success) {
    throw new Error(
      `no protocol adapter is enabled for ${provider}; Hive does not fall back to a native TUI`,
    );
  }
  return getProviderRuntimeAdapter(known.data);
}

export function agentUiSessionStart(
  options: Pick<
    AgentUiSessionOptions,
    "provider" | "model" | "effort" | "readOnly"
  >,
  instruction?: string,
): Omit<SessionStart, "cwd"> {
  const mode =
    options.provider === "kimi"
      ? kimiSessionMode(options.readOnly === true)
      : undefined;
  return {
    ...(options.model === undefined || options.model === "default"
      ? {}
      : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(mode === undefined ? {} : { mode }),
    ...(instruction === undefined ? {} : { instruction }),
  };
}

/** Root subjects always open a fresh vendor conversation. Workers may resume a durable session ref beside the journal. The queen boot capsule is the only trusted continuity source for a root; a stored vendor session is never authority for her. */
export function isAgentUiRootSubject(subject: string): boolean {
  return subject === "queen" || subject === "orchestrator";
}

export type AgentUiSessionDecision =
  { readonly outcome: "fresh" } | ResumeDecision;

export async function openAgentUiProviderSession(input: {
  readonly subject: string;
  readonly adapter: ProviderRuntimeAdapter;
  readonly spawn: ProviderSpawn;
  readonly journalPath: string;
  readonly sessionStart: Omit<SessionStart, "cwd">;
}): Promise<{
  readonly session: ProviderSession;
  readonly vendorSession: VendorSessionRef;
  readonly decision: AgentUiSessionDecision;
}> {
  if (isAgentUiRootSubject(input.subject)) {
    const fresh = await input.adapter.connect(input.spawn);
    const vendorSession = await fresh.newSession({
      cwd: input.spawn.cwd,
      ...input.sessionStart,
    });
    return {
      session: fresh,
      vendorSession,
      decision: { outcome: "fresh" },
    };
  }
  return openProviderSession(
    input.adapter,
    input.spawn,
    sessionRefPath(input.journalPath),
    undefined,
    input.sessionStart,
  );
}

export async function runAgentUi(options: AgentUiOptions): Promise<number> {
  const adapter = adapterFor(options.provider);
  // "fake" is not a vendor, so it has no CapabilityProvider of its own; tests drive it and never read this field.
  const provider = CapabilityProviderSchema.safeParse(options.provider);
  const spawn: ProviderSpawn = {
    provider: provider.success ? provider.data : "claude",
    executable: options.executable ?? options.provider,
    argv: options.providerArgv ?? [],
    cwd: options.worktreePath,
    env: { ...process.env } as Record<string, string>,
  };

  await mkdir(dirname(options.journalPath), { recursive: true });
  const journal = await OutboundJournal.open(options.journalPath);
  await journal.recoverInterrupted();
  const instruction =
    options.instructionPath === undefined
      ? undefined
      : await readFile(options.instructionPath, "utf8");
  let session: ProviderSession | null = null;
  let renderer: CliRenderer | null = null;
  let ui: AgentUi | null = null;
  let statusReporter: ProviderStatusForwarder | null = null;
  let diagnosticReporter: PaneObservabilityReporter | null = null;
  let leaseHeartbeat: MailLeaseHeartbeat | null = null;
  const teardown = onetime(async (): Promise<void> => {
    try {
      ui?.detach();
      await ui?.settleInput();
      await diagnosticReporter?.flush();
    } finally {
      try {
        await session?.close();
      } finally {
        try {
          await statusReporter?.flush();
        } finally {
          try {
            await journal.close();
          } finally {
            renderer?.destroy();
          }
        }
      }
    }
  });
  const exitAfterTeardown = () => {
    void teardown().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, exitAfterTeardown);
  }
  let mail: { stop: () => void } | null = null;
  let quotaWarnings: { stop: () => void } | null = null;
  let permissions: ReturnType<typeof providerPermissionWatcher> = null;
  try {
    const opened = await openAgentUiProviderSession({
      subject: options.subject,
      adapter,
      spawn,
      journalPath: options.journalPath,
      sessionStart: agentUiSessionStart(options, instruction),
    });
    session = opened.session;
    if ("reason" in opened.decision) {
      // Said before the alternate screen takes over, so it stays in the scrollback a person can go back to: this pane is a new conversation, and why.
      process.stderr.write(
        `hive: refusing to resume the stored session — ${opened.decision.reason}\n`,
      );
    }
    // The adapter either knows which process it spawned or it does not. An unknown child is never filled in from whatever the terminal is running.
    const child = session.adapterChild;
    if (child === null) {
      throw new Error(
        `${options.provider} adapter did not report a child process`,
      );
    }
    const reporter =
      options.daemonPort === undefined
        ? null
        : providerRuntimeReporter(
            options.subject,
            options.providerRunId,
            options.daemonPort,
          );
    if (reporter !== null) {
      await reporter.reportChild(
        observeAdapterChild(child, macProcessIdentity),
      );
    }
    // What the pane was launched with, held until the vendor reports what it is actually running. "default" is the daemon deferring to the vendor's own choice rather than a model name, so it is shown as unknown — the same em dash a pane launched without a model gets.
    const identity: PaneIdentity = {
      agentName: options.subject,
      vendorName: VENDOR_NAMES[options.provider] ?? options.provider,
      vendorId: options.provider,
      workspacePath: options.worktreePath,
      model:
        options.model === undefined || options.model === "default"
          ? "—"
          : options.model,
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    };
    renderer = await createCliRenderer({
      stdin: process.stdin,
      stdout: process.stdout,
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      screenMode: "alternate-screen",
      useMouse: true,
      useKittyKeyboard: { disambiguate: true },
      ...AGENT_UI_CONSOLE_OPTIONS,
    });
    const reportWake = wakeReporter(options);
    const paneDaemon =
      options.daemonPort === undefined
        ? null
        : new PaneDaemonClient({
            port: options.daemonPort,
            subject: options.subject,
            fetch: agentFetch(options.subject),
          });
    diagnosticReporter =
      paneDaemon === null || options.providerRunId === undefined
        ? null
        : new PaneObservabilityReporter({
            client: paneDaemon,
            subject: options.subject,
            provider: provider.success ? provider.data : null,
            providerRunId: options.providerRunId,
            vendorSessionId: opened.vendorSession.vendorSessionId,
          });
    const reportDiagnostic = (fact: UiDiagnosticReport): void => {
      if (diagnosticReporter === null) {
        ui?.renderDiagnostic({ severity: fact.severity, reason: fact.reason });
        return;
      }
      void diagnosticReporter
        .report(fact)
        .then((event) => ui?.renderDiagnostic(event))
        .catch((error: unknown) =>
          ui?.renderDiagnostic({
            severity: fact.severity,
            reason: `${fact.reason}\nAudit delivery failed — ${errorMessage(error)}`,
          }),
        );
    };
    ui = new AgentUi({
      renderer,
      identity,
      session,
      journal,
      vendorSessionId: opened.vendorSession.vendorSessionId,
      ...(options.daemonPort === undefined
        ? {}
        : { daemonPort: options.daemonPort }),
      ...(reporter === null ? {} : { reportReceipt: reporter.reportReceipt }),
      ...(reportWake === undefined ? {} : { reportWake }),
      reportDiagnostic,
      ...(paneDaemon === null || !isAgentUiRootSubject(options.subject)
        ? {}
        : {
            loadCompactReload: () => fetchQueenCompactReload(paneDaemon),
          }),
    });
    const activeUi = ui;
    activeUi.replaceCommandCatalog(await session.listCommands());
    mail = mailReadyWatcher(options, activeUi);
    quotaWarnings = provider.success
      ? await quotaWarningWatcher(options, activeUi, provider.data)
      : null;
    permissions = providerPermissionWatcher(options, activeUi);
    const watcher = permissions;
    // The pane owns how it reaches the daemon; the forwarder owns what it sends and in what order. Reports supersede each other, so a stalled retry would delay the next projection rather than rescue this one.
    const statusDaemon =
      options.daemonPort === undefined
        ? null
        : new PaneDaemonClient({
            port: options.daemonPort,
            subject: options.subject,
            fetch: agentFetch(options.subject),
            retries: 0,
          });
    statusReporter = providerStatusForwarder({
      subject: options.subject,
      providerRunId: options.providerRunId,
      vendorSessionId: opened.vendorSession.vendorSessionId,
      post:
        statusDaemon === null
          ? null
          : (path, init) => statusDaemon.request(path, init),
      onError: (error) =>
        activeUi.reportError(`agent status delayed — ${errorMessage(error)}`),
    });
    if (statusDaemon !== null) {
      leaseHeartbeat = new MailLeaseHeartbeat({
        client: statusDaemon,
        onError: (error) =>
          activeUi.reportError(
            `mail lease heartbeat failed — ${errorMessage(error)}`,
          ),
      });
    }
    await renderSession(
      activeUi,
      session,
      options.kickoff === undefined
        ? null
        : { session: opened.vendorSession, text: options.kickoff },
      (requestId, summary) => {
        void watcher
          ?.report(requestId, summary)
          .catch((error) =>
            activeUi.reportError(
              `provider permission report failed — ${errorMessage(error)}`,
            ),
          );
      },
      (event) => {
        leaseHeartbeat?.observe(event);
        statusReporter?.(event);
        void diagnosticReporter
          ?.observeProviderEvent(event)
          .then((failure) => {
            if (failure !== null) ui?.renderDiagnostic(failure);
          })
          .catch((error: unknown) =>
            ui?.renderDiagnostic({
              severity: "error",
              reason: `Audit delivery failed — ${errorMessage(error)}`,
            }),
          );
      },
      (requestId, outcome) => {
        void watcher
          ?.settle(requestId, outcome)
          .catch((error) =>
            activeUi.reportError(
              `provider permission settlement failed — ${errorMessage(error)}`,
            ),
          );
      },
    );
  } finally {
    leaseHeartbeat?.stop();
    mail?.stop();
    quotaWarnings?.stop();
    permissions?.stop();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.removeListener(signal, exitAfterTeardown);
    }
    await teardown();
  }
  return 0;
}

/** Shows measured headroom for the pane's active vendor without asking the model to spend a turn checking it. Unknown and unmetered windows produce no number. */
async function quotaWarningWatcher(
  options: AgentUiOptions,
  ui: AgentUi,
  provider: CapabilityProvider,
): Promise<{ stop: () => void } | null> {
  if (options.daemonPort === undefined) return null;
  const client = new QuotaWarningClient({
    port: options.daemonPort,
    subject: options.subject,
    provider,
    vendorName: VENDOR_NAMES[provider] ?? provider,
  });
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const notice of await client.poll(ui.quotaModel())) {
        ui.reportWarning(notice.message);
      }
    } catch (error) {
      ui.reportError(`quota warning check failed — ${errorMessage(error)}`);
    }
    if (!stopped) setTimeout(() => void tick(), QUOTA_POLL_INTERVAL_MS);
  };
  // Finish the first read before an automatic kickoff can spend the next turn.
  await tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

export async function renderSession(
  ui: AgentUi,
  session: ProviderSession,
  kickoff: { readonly session: VendorSessionRef; readonly text: string } | null,
  onApprovalWaiting: (requestId: string, summary: string) => void,
  onLifecycle: (event: NormalizedProviderEvent) => void,
  onPermissionSettled: (
    requestId: string,
    outcome: ProviderPermissionSettlementOutcome,
  ) => void = () => {},
): Promise<void> {
  if (kickoff !== null) {
    const clientInputId = randomUUID();
    ui.presentPrompt(clientInputId, kickoff.text);
    void session
      .submit({
        session: kickoff.session,
        clientInputId,
        text: kickoff.text,
      })
      .then((receipt) => ui.settlePrompt(receipt))
      .catch((error) => {
        ui.settlePrompt({ clientInputId, outcome: "unknown", turnId: null });
        ui.reportError(`kickoff submission failed — ${errorMessage(error)}`);
      });
  }
  for await (const event of session.events) {
    if (event.kind === "approval-waiting") {
      onApprovalWaiting(event.requestId, event.summary);
    }
    if (event.kind === "elicitation-settled") {
      onPermissionSettled(event.requestId, event.outcome);
    }
    onLifecycle(event);
    ui.onProviderEvent(event);
    ui.requestPump();
  }
}

function providerPermissionWatcher(
  options: AgentUiOptions,
  ui: AgentUi,
): {
  report: (requestId: string, description: string) => Promise<void>;
  settle: (
    requestId: string,
    outcome: ProviderPermissionSettlementOutcome,
  ) => Promise<void>;
  stop: () => void;
} | null {
  if (options.daemonPort === undefined) return null;
  const client = new ProviderPermissionClient(
    options.daemonPort,
    options.subject,
  );
  const reports = new Map<string, Promise<void>>();
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const decision of await client.poll()) {
        await ui.respondToPermission(decision.requestId, decision.outcome);
        await client.acknowledge(decision.approvalId);
      }
    } catch (error) {
      ui.reportError(
        `provider permission poll failed — ${errorMessage(error)}`,
      );
    }
    if (!stopped) setTimeout(() => void tick(), MAIL_POLL_INTERVAL_MS);
  };
  const report = (requestId: string, description: string): Promise<void> => {
    const pending = client.report(requestId, description);
    reports.set(requestId, pending);
    return pending;
  };
  const settle = async (
    requestId: string,
    outcome: ProviderPermissionSettlementOutcome,
  ): Promise<void> => {
    try {
      // The prompt and settlement come from one provider event stream, but their HTTP requests are asynchronous. Preserve that order so a prompt cannot appear in the daemon after its settlement already returned.
      await reports.get(requestId);
      await client.settle(requestId, outcome);
    } finally {
      reports.delete(requestId);
    }
  };
  void tick();
  return {
    report,
    settle,
    stop: () => {
      stopped = true;
    },
  };
}

/** Polls the daemon for mail-ready notifications and hands each to the UI. A failed poll is reported and retried rather than ending the pane: mail is one dimension of the screen, and a person mid-turn should not lose their terminal because the daemon blinked. Nothing here can reach the composer. */
function wakeReporter(
  options: AgentUiOptions,
): ((report: FrontendWakeReport) => Promise<void>) | undefined {
  if (options.daemonPort === undefined) return undefined;
  const reporter = new MailWakeReporter({
    port: options.daemonPort,
    subject: options.subject,
  });
  return (report) => reporter.report(report);
}

/** Acknowledge a polled burst first, then hand the whole burst to the pane. The acknowledgement is what records that this frontend was notified, and the ledger will not accept a wake queued for an item it has not been told reached a frontend. Reporting the queued wake first therefore fails its prerequisite every time, and the failure is a swallowed diagnostic rather than a stop — so the order here is load-bearing and cannot be read off either side alone. Acknowledging before the pane has acted widens what each ack claims: it says the notice reached this process, not that the UI finished with it. Reducing the acknowledged burst together also lets the pane paint its final state once instead of painting every intermediate backlog count. */
export async function deliverMailReadyNotices(
  notices: readonly MailReadyNotice[],
  ui: Pick<AgentUi, "onMailReadyBatch">,
  client: Pick<MailReadyClient, "acknowledge">,
): Promise<void> {
  for (const notice of notices) {
    await client.acknowledge(notice);
  }
  await ui.onMailReadyBatch(notices);
}

function mailReadyWatcher(
  options: AgentUiOptions,
  ui: AgentUi,
): { stop: () => void } | null {
  if (options.daemonPort === undefined) return null;
  const client = new MailReadyClient({
    port: options.daemonPort,
    recipient: options.subject,
    fetch: agentFetch(options.subject),
  });
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const notices = await client.poll();
      if (notices.length > 0) {
        await deliverMailReadyNotices(notices, ui, client);
      }
    } catch (error) {
      ui.reportError(`mail-ready poll failed — ${errorMessage(error)}`);
    }
    if (!stopped) setTimeout(() => void tick(), MAIL_POLL_INTERVAL_MS);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

export function sessionRefPath(journalPath: string): string {
  return join(dirname(journalPath), "session.json");
}
