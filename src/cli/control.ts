import { readFileSync } from "node:fs";
import { factVerificationFlag } from "../adapters/memory";
import { TmuxAdapter } from "../adapters/tmux";
import {
  cleanupLifecycleFiles,
  daemonInstanceLiveness,
  getPidFilePath,
  readDaemonPort,
  type DaemonInstanceLiveness,
} from "../daemon/lifecycle";
import { getHiveHome } from "../daemon/db";
import {
  captureProcessTree,
  defaultReapDependencies,
  reapCapturedTree,
  type ReapDependencies,
} from "../daemon/teardown";
import type {
  MemoryScope,
  MemoryWriteInput,
  QuotaObservationInput,
} from "../schemas";
import { hiveInstanceSuffix, isTmuxSessionForInstance } from "../daemon/tmux-sessions";
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
import { operatorFetch, operatorHeaders } from "./credential";
import { isAutonomy, type Autonomy } from "../config/autonomy";
import { formatQuotaStatus, formatStatusTable } from "./status";

const isNoSuchProcessError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ESRCH";

type StopTmux = Pick<
  TmuxAdapter,
  "killSession" | "listPanePids" | "listSessions"
>;

export interface StopAgentSessionDependencies {
  tmux: StopTmux;
  hiveHome?: string;
  reap?: ReapDependencies;
}

export async function stopAgentSessions(
  dependencies: StopAgentSessionDependencies,
): Promise<number> {
  const sessions = (await dependencies.tmux.listSessions()).filter(
    (session) => isTmuxSessionForInstance(session, dependencies.hiveHome),
  );
  if (sessions.length === 0) return 0;

  const reap = dependencies.reap ?? defaultReapDependencies();
  const captured = await Promise.all(sessions.map(async (session) => {
    try {
      const roots = await dependencies.tmux.listPanePids(session);
      return await captureProcessTree(roots, reap);
    } catch (error) {
      throw new Error(
        `Refusing to close ${session} because its process tree could not be captured: ${
          error instanceof Error ? error.message : String(error)
        }\nFix: inspect the session, then rerun \`hive stop\`.`,
      );
    }
  }));

  const sessionResults = await Promise.allSettled(sessions.map((session) =>
    dependencies.tmux.killSession(session, { ignoreMissing: true })
  ));
  const outcomes = await Promise.all(
    captured.map((tree) => reapCapturedTree(tree, reap)),
  );
  const survivors = outcomes.flatMap((outcome) => outcome.survivors);
  const remaining = new Set(await dependencies.tmux.listSessions());
  const remainingOwned = sessions.filter((session) => remaining.has(session));
  const sessionErrors = sessionResults.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []
  );
  if (
    sessionErrors.length > 0 || survivors.length > 0 || remainingOwned.length > 0
  ) {
    const details = [
      ...sessionErrors,
      ...survivors.map((process) => `pid ${process.pid} (${process.command}) survived`),
      ...remainingOwned.map((session) => `${session} is still present`),
    ];
    throw new Error(
      `Hive could not completely stop its remaining sessions: ${details.join("; ")}\n` +
        "Fix: inspect the named sessions and processes, stop them, then rerun `hive stop`.",
    );
  }
  return sessions.length;
}

export function requireDaemonPort(explicitPort?: number): number {
  const port = explicitPort ?? readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    throw new Error(
      "no daemon is running\nFix: run `hive init` in the project first",
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
 * unlanded work. A UI that killed the tmux session itself would leave the
 * vendor CLI, the Codex host and the MCP children running — that is the exact
 * leak this command exists to close.
 *
 * Immediate and unconditional: no confirmation, no prompt. Unlanded work is not
 * discarded by that — the daemon preserves the branch and tells the
 * orchestrator — so the caller has nothing to ask the user about.
 */
export async function killAgentCli(
  name: string,
  port: number = requireDaemonPort(),
): Promise<void> {
  const response = await operatorFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(name)}/kill`,
    { method: "POST" },
  );
  const body = await response.json().catch(() => null) as
    | {
      error?: string;
      alreadyDead?: boolean;
      preserved?: { branch: string; ref: string } | null;
      reaped?: { killed?: unknown[]; survivors?: { pid: number; command: string }[] };
    }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `kill failed (HTTP ${response.status})`);
  }
  if (body?.alreadyDead === true) {
    console.log(`${name} was already closed`);
    return;
  }
  const killed = body?.reaped?.killed?.length ?? 0;
  console.log(
    `killed ${name} — ${killed} process(es) reaped`,
  );
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
        survivors.map((process) => `pid ${process.pid} (${process.command})`)
          .join(", "),
    );
  }
}

export async function printStatus(): Promise<void> {
  const agents = await fetchAgentStatus(requireDaemonPort());
  console.log(formatStatusTable(agents));
}

export async function printQuotaStatus(): Promise<void> {
  console.log(formatQuotaStatus(
    await fetchQuotaStatus(requireDaemonPort()),
  ));
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
    ...(mode === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autonomy: mode }),
    }),
  });
  const body = await response.json().catch(() => null) as
    | { autonomy?: unknown; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `autonomy request failed (HTTP ${response.status})`);
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

export async function writeMemoryCli(input: MemoryWriteInput): Promise<void> {
  const fact = await writeMemory(requireDaemonPort(), input);
  console.log(
    `wrote [${fact.scope}/${fact.topic}] ${fact.id} — ${fact.path}\n` +
      `raw observation: ${fact.rawPath}`,
  );
}

export async function readMemoryCli(
  scope: MemoryScope,
  id: string,
): Promise<void> {
  const fact = await readMemory(requireDaemonPort(), scope, id);
  // Provenance surfaces on read (SPEC decision 5), where the load-bearing
  // check happens: show source and verification, and flag a fact whose
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
  const notice = flag === null
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
  console.log(`rebuilt the memory search index from ${result.count} article(s)`);
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
  const body = await response.json().catch(() => ({})) as {
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

export interface StopHiveDependencies {
  readonly tmux?: StopTmux;
  readonly readPid?: () => number | null;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly liveness?: () => Promise<DaemonInstanceLiveness>;
  readonly cleanup?: (pid?: number) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export async function stopHive(deps: StopHiveDependencies = {}): Promise<void> {
  const tmux = deps.tmux ?? new TmuxAdapter();
  const pid = (deps.readPid ?? readDaemonPid)();
  const liveness = deps.liveness ?? (() =>
    daemonInstanceLiveness(getHiveHome(), hiveInstanceSuffix())
  );
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
    if (pid === null) {
      throw new Error(
        "the daemon is live but has no recorded pid\n" +
          "Fix: inspect the daemon lifecycle files, then rerun `hive stop`.",
      );
    }
    try {
      (deps.kill ?? process.kill)(pid, "SIGTERM");
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        throw error;
      }
    }
    const sleep = deps.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
    const attempts = Math.max(1, Math.ceil((deps.timeoutMs ?? 5_000) / 50));
    state = await liveness();
    for (let attempt = 0; state !== "dead" && attempt < attempts; attempt += 1) {
      await sleep(50);
      state = await liveness();
    }
    if (state !== "dead") {
      throw new Error(
        `daemon pid ${pid} did not stop (liveness: ${state})\n` +
          "Fix: inspect the daemon, stop it manually, then rerun `hive stop`.",
      );
    }
  }

  const stoppedSessions = await stopAgentSessions({ tmux });
  cleanup(pid ?? undefined);
  const sessionLabel = stoppedSessions === 1 ? "session" : "sessions";
  const report = daemonWasLive
    ? stoppedSessions === 0
      ? "Stopped the Hive daemon and its sessions."
      : `Stopped the Hive daemon; reaped ${stoppedSessions} remaining Hive ${sessionLabel}.`
    : stoppedSessions === 0
    ? "No live Hive daemon or sessions were found."
    : `Stopped ${stoppedSessions} stale Hive ${sessionLabel}; no live daemon was found.`;
  (deps.log ?? console.log)(report);
}
