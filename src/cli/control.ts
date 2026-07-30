import { readFileSync } from "node:fs";
import { factVerificationFlag } from "../adapters/memory";
import { type Autonomy, isAutonomy } from "../config/autonomy";
import { getHiveHome } from "../daemon/db";
import { hiveInstanceSuffix } from "../daemon/instance-identity";
import {
  cleanupLifecycleFiles,
  type DaemonInstanceLiveness,
  type DaemonProcessIdentity,
  daemonInstanceLiveness,
  getPidFilePath,
  macProcessIdentity,
  readDaemonPort,
} from "../daemon/lifecycle";
import type {
  MemoryScope,
  MemoryWriteInput,
  QuotaObservationInput,
  SessionLocator,
} from "../schemas";
import { operatorFetch, operatorHeaders } from "./credential";
import {
  captureInvokerIdentity,
  formatInvokerOrigin,
  type InvokerIdentity,
  isTestRunnerEnv,
} from "./invoker";
import {
  deleteMemory,
  fetchAgentStatus,
  fetchQuotaStatus,
  readMemory,
  reconcileQuota,
  reindexMemory,
  searchMemory,
  writeMemory,
} from "./mcp";
import { type ConfirmFn, confirmOnTty } from "./prompt";
import { formatQuotaStatus, formatStatusTable } from "./status";
export function requireDaemonPort(explicitPort?: number): number {
  const port = explicitPort ?? readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    throw new Error(
      "no daemon is running\nFix: run `hive` in the project first",
    );
  }
  return port;
}

function readDaemonPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(getPidFilePath(), "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `hive kill <agent>` — close an agent and everything it started.
 *
 * This is what the Workspace's pane X shells out to, and it is deliberately the
 * same daemon path `hive_kill` takes: the daemon owns the kill, because only
 * the daemon knows the agent's process tree, its quota reservation and its
 * unlanded work. A UI that killed only the terminal itself would leave the
 * vendor CLI, the Codex host and the MCP children running — that is the exact
 * leak this command exists to close.
 *
 * Immediate and unconditional: no confirmation, no prompt. Unlanded work is not
 * discarded by that — the daemon preserves the branch and tells the
 * orchestrator — so the caller has nothing to ask the user about.
 */
/**
 * Request a one-use viewer attach grant for a pane's EXACT sessiond session.
 * The Workspace's HiveTerminalView shells out to this and connects
 * directly to the returned host endpoint; a stale or superseded generation is
 * refused by the daemon before the broker is contacted. Prints the grant as
 * JSON on stdout — machine-readable, nothing else.
 */
export async function attachGrantCli(
  name: string,
  locator: SessionLocator,
  viewerId: string,
  geometry: {
    columns: number;
    rows: number;
    widthPx: number;
    heightPx: number;
    cellWidthPx: number;
    cellHeightPx: number;
  },
  port: number = requireDaemonPort(),
): Promise<void> {
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(name)}/attach-grant`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionLocator: locator,
        viewerId,
        geometry,
        operations: ["view", "human-input", "resize"],
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    state?: string;
    grant?: unknown;
    error?: string;
    reason?: string;
  } | null;
  if (!response.ok || body?.state !== "granted" || body.grant === undefined) {
    const reason = body?.reason === undefined ? "" : ` [${body.reason}]`;
    throw new Error(
      (body?.error ?? `attach grant failed (HTTP ${response.status})`) + reason,
    );
  }
  console.log(JSON.stringify(body.grant));
}

/** The provenance string a kill carries to the daemon's audit log:
 * full invoker identity — pid, parent chain with process names, argv, cwd and
 * the agent-worktree flag. Captured at the origin because the audit row is
 * the only record that survives the teardown cascade — the 2026-07-20 fleet
 * kills were audited as a bare `ppid=<gone> argv=[]` and needed a full
 * forensic reconstruction to attribute. */
export function killOrigin(
  subcommand: "kill" | "stop",
  invoker: InvokerIdentity = captureInvokerIdentity(),
): string {
  return formatInvokerOrigin(subcommand, invoker);
}

export async function killAgentCli(
  name: string,
  port: number = requireDaemonPort(),
  expectedLocator?: SessionLocator,
  origin?: string,
): Promise<void> {
  const locator =
    expectedLocator ??
    (await fetchAgentStatus(port)).find((agent) => agent.name === name)
      ?.sessionLocator;
  if (locator === undefined) {
    throw new Error(`Hive agent ${name} has no exact session locator`);
  }
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(name)}/kill`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionLocator: locator,
        ...(origin === undefined ? {} : { origin }),
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    reason?: string;
    alreadyDead?: boolean;
    preserved?: { branch: string; ref: string } | null;
    reaped?: {
      killed?: unknown[];
      survivors?: { pid: number; command: string }[];
    };
  } | null;
  if (!response.ok) {
    const reason = body?.reason === undefined ? "" : ` [${body.reason}]`;
    throw new Error(
      (body?.error ?? `kill failed (HTTP ${response.status})`) + reason,
    );
  }
  if (body?.alreadyDead === true) {
    console.log(`${name} was already closed`);
    return;
  }
  const killed = body?.reaped?.killed?.length ?? 0;
  console.log(`killed ${name} — ${killed} process(es) reaped`);
  if (body?.preserved != null) {
    console.log(
      `  unlanded work preserved: ${body.preserved.branch} at ${body.preserved.ref}`,
    );
  }
  // Survivors are a failed kill. Say so on stderr and exit non-zero: the whole
  // point of this command is that "I sent the signal" is not "it is dead".
  const survivors = body?.reaped?.survivors ?? [];
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} process(es) survived SIGKILL and are still running: ` +
        survivors
          .map((process) => `pid ${process.pid} (${process.command})`)
          .join(", "),
    );
  }
}

export async function printStatus(): Promise<void> {
  const agents = await fetchAgentStatus(requireDaemonPort());
  console.log(formatStatusTable(agents));
}

export async function printQuotaStatus(): Promise<void> {
  console.log(formatQuotaStatus(await fetchQuotaStatus(requireDaemonPort())));
}

const AUTONOMY_MEANING: Record<Autonomy, string> = {
  sandboxed:
    "writers use vendor sandboxes and agent permission prompts remain enabled",
  dangerous:
    "agents run with permission prompts off; writers also use unrestricted vendor mode",
};

/** `hive autonomy [mode]` — read or set the daemon's live autonomy dial.
 * Both directions go through the daemon, never the config file directly:
 * what this prints is what the next spawn will actually use, and a set is
 * confirmed by the daemon's answer, not assumed from a clean exit. */
export async function autonomyCli(
  mode?: string,
  port: number = requireDaemonPort(),
): Promise<void> {
  if (mode !== undefined && !isAutonomy(mode)) {
    throw new Error('autonomy must be "sandboxed" or "dangerous"');
  }
  const response = await operatorFetch(`http://127.0.0.1:${port}/autonomy`, {
    ...(mode === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autonomy: mode }),
        }),
  });
  const body = (await response.json().catch(() => null)) as {
    autonomy?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      body?.error ?? `autonomy request failed (HTTP ${response.status})`,
    );
  }
  const value = body?.autonomy;
  if (!isAutonomy(value)) {
    throw new Error("the daemon reported no autonomy setting");
  }
  console.log(
    mode === undefined
      ? `${value} — ${AUTONOMY_MEANING[value]}`
      : `autonomy is now ${value} — ${
          AUTONOMY_MEANING[value]
        } (persisted to config; applies to new spawns and crash resumes)`,
  );
}

export async function recordQuotaObservation(
  observation: QuotaObservationInput,
): Promise<void> {
  const recorded = await reconcileQuota(requireDaemonPort(), observation);
  console.log(
    `Recorded ${recorded.source} quota observation for ` +
      `${recorded.provider}/${recorded.account}/${recorded.pool} at ${recorded.observedAt}.`,
  );
}

export async function searchMemoryCli(
  query: string,
  options?: { scope?: MemoryScope; limit?: number },
): Promise<void> {
  const results = await searchMemory(requireDaemonPort(), query, options);
  if (results.length === 0) {
    console.log("no matching memory articles");
    return;
  }
  for (const result of results) {
    console.log(
      `[${result.scope}] ${result.id} (${result.date}) — ${result.title}\n  ${result.snippet}`,
    );
  }
}

/** The one-line CLI rendering of a write's embedding outcome (defect D2):
 * quiet on the happy path ("indexed" or a daemon too old to say), one loud
 * line otherwise. */
export function memoryEmbeddingNotice(
  embedding: string | undefined,
): string | null {
  if (embedding === undefined || embedding === "indexed") return null;
  if (embedding === "queued") {
    return (
      "embedding queued — the vector projection is running in the " +
      "background; this write is keyword-searchable until it lands"
    );
  }
  const state = embedding.startsWith("unavailable:")
    ? embedding.slice("unavailable:".length)
    : embedding;
  return (
    `⚠ embedding unavailable (${state}) — this write is ` +
    "keyword-searchable only; see ~/.hive/logs/daemon.log or run " +
    "`hive init`"
  );
}

export async function writeMemoryCli(input: MemoryWriteInput): Promise<void> {
  const fact = await writeMemory(requireDaemonPort(), input);
  console.log(
    `wrote [${fact.scope}/${fact.topic}] ${fact.id} — ${fact.path}\n` +
      `raw observation: ${fact.rawPath}`,
  );
  const embeddingNotice = memoryEmbeddingNotice(fact.embedding);
  if (embeddingNotice !== null) {
    console.log(embeddingNotice);
  }
  for (const candidate of fact.similarCandidates ?? []) {
    console.log(
      `similar: [${candidate.scope}] ${candidate.id} — ${candidate.title} ` +
        `(re-issue as an update to that id if this duplicates it)`,
    );
  }
}

export async function readMemoryCli(
  scope: MemoryScope,
  id: string,
): Promise<void> {
  const fact = await readMemory(requireDaemonPort(), scope, id);
  // Provenance surfaces on read, where the load-bearing check happens: show
  // source and verification, and flag a fact whose
  // concrete claims must be re-checked against the repo before acting.
  const flag = factVerificationFlag(fact);
  const provenance = [
    `date: ${fact.date}`,
    `topic: ${fact.topic}`,
    `source: ${fact.source}`,
    `status: ${fact.status}`,
    `verified: ${fact.verified ?? "never"}`,
    `evidence: ${fact.evidence}`,
    `supersedes: ${fact.supersedes.join(", ")}`,
    `raw: ${fact.raw.join(", ")}`,
    `tags: ${fact.tags.join(", ")}`,
  ].join("\n");
  const notice =
    flag === null
      ? ""
      : `\n⚠ ${flag}: reconcile this article before acting on any path, command, or flag it names.`;
  console.log(`# ${fact.title}\n\n${provenance}${notice}\n\n${fact.body}`);
}

export async function deleteMemoryCli(
  scope: MemoryScope,
  id: string,
): Promise<void> {
  const deleted = await deleteMemory(requireDaemonPort(), scope, id);
  console.log(
    deleted
      ? `Deleted [${scope}] ${id}.`
      : `No memory article found at [${scope}] ${id}.`,
  );
}

export async function reindexMemoryCli(): Promise<void> {
  const result = await reindexMemory(requireDaemonPort());
  console.log(
    `rebuilt the memory search index from ${result.count} article(s)`,
  );
  for (const backup of result.migration.backups) {
    console.log(`backed up [${backup.scope}] legacy memory to ${backup.path}`);
  }
}

export interface RecoveryOutcomeView {
  agent: string;
  action: "resumed" | "marked-dead" | "skipped";
  sessionId?: string;
  reason?: string;
}

export async function recoverAgentsCli(name?: string): Promise<void> {
  const port = requireDaemonPort();
  const response = await fetch(`http://127.0.0.1:${port}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", ...operatorHeaders() },
    body: JSON.stringify(name === undefined ? {} : { agent: name }),
  });
  // A daemon that fails before its JSON handler (proxy page, empty body)
  // must still surface as the HTTP failure it is, not as a parse error.
  const body = (await response.json().catch(() => ({}))) as {
    outcomes?: RecoveryOutcomeView[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Recovery failed (HTTP ${response.status})`);
  }
  const outcomes = body.outcomes ?? [];
  if (outcomes.length === 0) {
    console.log("no crashed agents to recover");
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.action === "resumed") {
      console.log(`resumed ${outcome.agent} (session ${outcome.sessionId})`);
    } else if (outcome.action === "marked-dead") {
      console.log(`marked ${outcome.agent} dead: ${outcome.reason}`);
    } else {
      console.log(`skipped ${outcome.agent}: ${outcome.reason}`);
    }
  }
}

/** One agent's unlanded state, as the daemon's `/stop` refusal names it. */
export interface StopUnlandedAgent {
  readonly name: string;
  readonly branch: string | null;
  readonly dirtyFiles: number;
  readonly unmergedCommits: number;
}

export interface StopRequestBody {
  readonly origin: string;
  readonly invoker: { readonly cwd: string; readonly agentWorktree: boolean };
  readonly confirmUnlanded: boolean;
}

export type StopResponseBody =
  | { state: "stopping"; killed: string[] }
  | { state: "already-stopping" }
  | { state: "refused-unlanded"; unlanded: StopUnlandedAgent[]; error?: string }
  | { state: "refused-invoker"; error?: string }
  | { state: "stop-failed"; failures: string[]; error?: string };

const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 30_000;

/** POST /stop — the daemon's own atomic-or-abortive shutdown. One
 * request; every gate (agent-worktree invoker and unlanded work) is evaluated
 * daemon-side before anything dies, and past the
 * commit point the daemon drives kills and its own exit to completion whether
 * or not this client survives to see the answer. */
async function defaultRequestStop(
  body: StopRequestBody,
): Promise<StopResponseBody> {
  const response = await operatorFetch(
    `http://127.0.0.1:${requireDaemonPort()}/stop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json().catch(() => null)) as
    | (Partial<StopResponseBody> & { error?: string })
    | null;
  if (parsed === null || typeof parsed.state !== "string") {
    throw new Error(
      `hive stop failed (HTTP ${response.status}): the daemon returned no stop state`,
    );
  }
  return parsed as StopResponseBody;
}

export interface StopHiveDependencies {
  readonly readPid?: () => number | null;
  readonly liveness?: () => Promise<DaemonInstanceLiveness>;
  readonly cleanup?: (pid?: number) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly processIdentity?: (pid: number) => DaemonProcessIdentity;
  readonly killDaemon?: (pid: number) => void;
  readonly log?: (message: string) => void;
  /** Captured once per invocation; injectable for tests. */
  readonly invoker?: InvokerIdentity;
  /** `hive stop --force`: skip the unlanded-work confirmation. */
  readonly force?: boolean;
  /** TTY confirmation for the unlanded-work gate; defaults to asking the
   * terminal (default no), refusing outright without one. */
  readonly confirm?: ConfirmFn;
  /** The daemon `/stop` transport. This is the only lethal dependency.
   * Under a test runner it must be injected explicitly because a defaulted
   * transport can reach the live fleet through ambient HIVE_HOME. */
  readonly requestStop?: (body: StopRequestBody) => Promise<StopResponseBody>;
  /** Set only by the `hive stop` CLI action: a real CLI subprocess is a
   * process boundary, not an in-process test caller, even when the test
   * runner's NODE_ENV=test leaks into its environment (e2e suites). */
  readonly invokedViaCli?: boolean;
}

function formatUnlanded(unlanded: readonly StopUnlandedAgent[]): string {
  return unlanded
    .map(
      (agent) =>
        `${agent.name} (branch ${agent.branch ?? "none"}: ` +
        `${agent.unmergedCommits} unmerged commit(s), ` +
        `${agent.dirtyFiles} uncommitted file(s))`,
    )
    .join("; ");
}

export async function stopHive(deps: StopHiveDependencies = {}): Promise<void> {
  const invoker = deps.invoker ?? captureInvokerIdentity();
  // An agent worktree shell carries no fleet-kill authority. Refuse before
  // touching anything, daemon contacted or not.
  if (invoker.agentWorktree) {
    throw new Error(
      "Hive refused `hive stop`: it was invoked from inside an agent worktree " +
        `(${invoker.cwd}), and agent shells hold no fleet-kill authority.\n` +
        "No agent was killed and the daemon was not signalled. " +
        "Fix: run `hive stop` from the project root, outside .hive/worktrees/.",
    );
  }
  const pid = (deps.readPid ?? readDaemonPid)();
  const liveness =
    deps.liveness ??
    (() => daemonInstanceLiveness(getHiveHome(), hiveInstanceSuffix()));
  const cleanup = deps.cleanup ?? cleanupLifecycleFiles;
  let state = await liveness();
  if (state === "unknown") {
    throw new Error(
      "the daemon's liveness is unknown; refusing to signal it or close its sessions\n" +
        "Fix: inspect the daemon lifecycle files, then rerun `hive stop`.",
    );
  }
  const daemonWasLive = state === "live";
  if (daemonWasLive) {
    // Inside a test-runner process, the stop transport must be an explicit
    // injection. A defaulted transport would resolve the ambient HIVE_HOME's
    // daemon port and operator credential and could kill the live fleet.
    if (
      isTestRunnerEnv() &&
      deps.requestStop === undefined &&
      deps.invokedViaCli !== true
    ) {
      throw new Error(
        "Hive refused `hive stop`: this is a test-runner process (NODE_ENV=test) " +
          "and no stop transport was injected.\n" +
          "No agent was killed and the daemon was not signalled. " +
          "Fix: pass an explicit requestStop dependency (tests), or unset NODE_ENV.",
      );
    }
    if (pid === null) {
      throw new Error(
        "the daemon is live but has no recorded pid\n" +
          "Fix: inspect the daemon lifecycle files, then rerun `hive stop`.",
      );
    }
    const processIdentity = deps.processIdentity ?? macProcessIdentity;
    let daemonIdentity: DaemonProcessIdentity | null = null;
    try {
      daemonIdentity = processIdentity(pid);
    } catch {
      // A normal stop is still safe if exact inspection races daemon exit.
      // Forced escalation below remains disabled without an exact identity.
    }
    const requestStop = deps.requestStop ?? defaultRequestStop;
    const body: StopRequestBody = {
      origin: killOrigin("stop", invoker),
      invoker: { cwd: invoker.cwd, agentWorktree: invoker.agentWorktree },
      confirmUnlanded: deps.force === true,
    };
    let response = await requestStop(body);
    if (response.state === "refused-unlanded") {
      // Unlanded work stops the stop. Name the agents and their state, ask a
      // real terminal, and refuse everywhere else.
      const summary = formatUnlanded(response.unlanded);
      const confirm = deps.confirm ?? confirmOnTty;
      (deps.log ?? console.log)(
        `Unlanded work would die with this stop: ${summary}`,
      );
      const answer = await confirm(
        `Stop anyway and kill ${response.unlanded.length} agent(s) with unlanded work?`,
        false,
      );
      if (answer !== true) {
        throw new Error(
          `Hive refused shutdown: ${response.unlanded.length} agent(s) hold ` +
            `unlanded work: ${summary}\n` +
            "No agent was killed and the daemon was not signalled. " +
            "Fix: land or discard their work, or rerun `hive stop --force`.",
        );
      }
      response = await requestStop({ ...body, confirmUnlanded: true });
    }
    if (response.state === "stop-failed") {
      throw new Error(
        "Hive refused shutdown because agent teardown failed: " +
          response.failures.join("; "),
      );
    }
    if (
      response.state === "refused-invoker" ||
      response.state === "refused-unlanded"
    ) {
      throw new Error(
        response.error ?? `Hive refused shutdown (${response.state})`,
      );
    }
    const sleep =
      deps.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
    const attempts = Math.max(
      1,
      Math.ceil((deps.timeoutMs ?? DEFAULT_DAEMON_STOP_TIMEOUT_MS) / 50),
    );
    state = await liveness();
    for (
      let attempt = 0;
      state !== "dead" && attempt < attempts;
      attempt += 1
    ) {
      await sleep(50);
      state = await liveness();
    }
    if (state !== "dead") {
      let currentIdentity: DaemonProcessIdentity | null = null;
      try {
        currentIdentity = processIdentity(pid);
      } catch {
        // The daemon exited between the liveness read and exact observation.
      }
      if (
        daemonIdentity !== null &&
        currentIdentity !== null &&
        currentIdentity.startToken === daemonIdentity.startToken &&
        currentIdentity.executablePath === daemonIdentity.executablePath
      ) {
        (deps.killDaemon ?? ((ownedPid) => process.kill(ownedPid, "SIGKILL")))(
          pid,
        );
        for (let attempt = 0; attempt < 20 && state !== "dead"; attempt += 1) {
          await sleep(50);
          state = await liveness();
        }
      }
      if (state !== "dead") {
        throw new Error(
          `daemon pid ${pid} did not stop (liveness: ${state}) and exact forced cleanup could not verify its exit\n` +
            "Fix: inspect the daemon lifecycle files, then rerun `hive stop`.",
        );
      }
    }
  }

  cleanup(pid ?? undefined);
  const report = daemonWasLive
    ? "Stopped the Hive daemon and its sessions."
    : "No live Hive daemon or sessions were found.";
  (deps.log ?? console.log)(report);
}
