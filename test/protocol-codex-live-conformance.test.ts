import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import { CodexAppServerAdapter } from "../src/adapters/providers/codex-app-server/runtime-adapter";
import type { CodexAppServerSession } from "../src/adapters/providers/codex-app-server/session";
import {
  capabilitySupport,
  type NormalizedProviderEvent,
  steadyStateUnknowns,
  unprovenBaseline,
} from "../src/adapters/providers/protocol/types";
import type { CapabilityName } from "../src/schemas/capability";
import { writeEvidenceFile } from "./evidence-write";
import {
  requireExecutable,
  requireStagedLiveFile,
  requireSuccessfulTurn,
  requireVerifiedVersion,
} from "./live-prerequisites";
import type { JsonObject } from "../src/shared/json";

const LIVE = process.env.HIVE_CODEX_LIVE === "1";
const EVIDENCE_PATH = join(
  "docs/evidence/protocol-terminal/codex",
  "conformance.json",
);

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly tty: string;
  readonly command: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processRows(): Promise<readonly ProcessRow[]> {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,tty=,command="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ps exited ${exitCode}`);
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        tty: match[4] ?? "unknown",
        command: match[5] ?? "",
      },
    ];
  });
}

async function appServerRows(): Promise<readonly ProcessRow[]> {
  return (await processRows()).filter((row) =>
    /\/codex\s+app-server\s+--stdio(?:\s|$)/.test(row.command),
  );
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function eventAfter(
  seen: readonly NormalizedProviderEvent[],
  offset: number,
  predicate: (event: NormalizedProviderEvent) => boolean,
): NormalizedProviderEvent | undefined {
  return seen.slice(offset).find(predicate);
}

async function waitForTerminal(
  seen: readonly NormalizedProviderEvent[],
  turnId: string,
): Promise<NormalizedProviderEvent> {
  return waitFor(
    () =>
      seen.find(
        (event) =>
          "turnId" in event &&
          event.turnId === turnId &&
          ["turn-idle", "turn-failed", "interrupted"].includes(event.kind),
      ),
    `terminal event for ${turnId}`,
  );
}

function summarizeCapabilities(
  session: CodexAppServerSession,
): Record<string, string> {
  const names: CapabilityName[] = [
    "newSession",
    "prompt",
    "cancel",
    "permissions",
    "streamingText",
    "toolLifecycle",
    "sessionRecovery",
    "questions",
    "commandCatalog",
    "modelCatalog",
    "modeCatalog",
    "contextUsage",
    "fork",
    "compact",
    "steering",
  ];
  return Object.fromEntries(
    names.map((name) => [name, capabilitySupport(session.capabilities, name)]),
  );
}

async function exerciseApproval(
  session: CodexAppServerSession,
  seen: readonly NormalizedProviderEvent[],
  threadId: string,
  outcome: "allow" | "deny",
): Promise<void> {
  const offset = seen.length;
  const receipt = await session.submit({
    session: { vendorSessionId: threadId, replayedHistory: false },
    clientInputId: `codex-permission-${outcome}`,
    text:
      `Use the shell tool exactly once to run printf hive-codex-${outcome}. ` +
      "Do not skip the tool and do not use any other tool.",
  });
  if (receipt.outcome !== "accepted" || receipt.turnId === null) {
    throw new Error(`permission ${outcome} turn was ${receipt.outcome}`);
  }
  const approval = await waitFor(
    () =>
      eventAfter(
        seen,
        offset,
        (event) =>
          event.kind === "approval-waiting" && event.turnId === receipt.turnId,
      ),
    `approval-waiting (${outcome})`,
  );
  if (approval.kind !== "approval-waiting") {
    throw new Error("approval event changed while reading it");
  }
  await session.respondToPermission({
    requestId: approval.requestId,
    outcome,
  });
  const terminal = await waitForTerminal(seen, receipt.turnId);
  if (terminal.kind === "turn-failed") {
    throw new Error(`permission ${outcome} failed: ${terminal.reason}`);
  }
  if (outcome === "allow") {
    requireSuccessfulTurn(`permission ${outcome}`, receipt, seen.slice(offset));
  }
}

function writeEvidence(payload: JsonObject): void {
  writeEvidenceFile(EVIDENCE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

(LIVE ? test : test.skip)(
  "installed Codex 0.147.x passes App Server conformance",
  async () => {
    const executable = requireExecutable("Codex", which("codex"));
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_AUTH_FILE",
      join(process.env.CODEX_HOME ?? "", "auth.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_CONFIG_FILE",
      join(process.env.CODEX_HOME ?? "", "config.toml"),
    );
    const resolvedExecutable = realpathSync(executable);
    const baselinePids = new Set((await appServerRows()).map((row) => row.pid));
    const adapter = new CodexAppServerAdapter({ approvalTimeoutMs: 15_000 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const steps: Record<string, string> = {};
    const seen: NormalizedProviderEvent[] = [];
    let session: CodexAppServerSession | null = null;
    let reader: Promise<void> | null = null;
    let processAudit: JsonObject = {};
    let measuredVersion = "unknown";

    try {
      const probe = await adapter.probe(executable);
      expect(probe.verdict).toBe("compatible");
      measuredVersion = requireVerifiedVersion("Codex", probe.version, "0.147");
      steps["1-initialize-capabilities"] = "pass";

      session = await adapter.connect({
        provider: "codex",
        executable,
        argv: [],
        cwd: process.cwd(),
        env,
      });
      reader = (async () => {
        if (session === null) return;
        for await (const event of session.events) seen.push(event);
      })();
      const child = await waitFor(async () => {
        const rows = await appServerRows();
        return rows.find((row) => !baselinePids.has(row.pid));
      }, "piped app-server child");
      processAudit = {
        childObserved: true,
        controllingTty:
          child.tty === "?" || child.tty === "??" ? null : child.tty,
        isolatedProcessGroup: child.processGroupId === child.pid,
      };

      const created = await session.newSession({ cwd: process.cwd() });
      expect(created.vendorSessionId).not.toBe("");
      steps["2-new-thread-without-prompt"] = "pass";

      const promptOffset = seen.length;
      const prompt = await session.submit({
        session: created,
        clientInputId: "codex-conformance-prompt",
        text: "Reply with exactly PONG and nothing else. Do not use tools.",
      });
      if (prompt.outcome !== "accepted" || prompt.turnId === null) {
        throw new Error(`isolated prompt was ${prompt.outcome}`);
      }
      await waitFor(
        () =>
          eventAfter(
            seen,
            promptOffset,
            (event) =>
              event.kind === "turn-started" && event.turnId === prompt.turnId,
          ),
        "authoritative turn start",
      );
      await waitFor(
        () =>
          eventAfter(
            seen,
            promptOffset,
            (event) =>
              event.kind === "message-delta" && event.turnId === prompt.turnId,
          ),
        "streaming message delta",
      );
      expect((await waitForTerminal(seen, prompt.turnId)).kind).toBe(
        "turn-idle",
      );
      steps["3-prompt-start-stream-complete"] = "pass";

      await session.updateThreadSettings({
        threadId: created.vendorSessionId,
        approvalPolicy: "untrusted",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [process.cwd()],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      await exerciseApproval(session, seen, created.vendorSessionId, "deny");
      await exerciseApproval(session, seen, created.vendorSessionId, "allow");
      steps["4-approval-deny-and-allow"] = "pass";

      await session.updateThreadSettings({
        threadId: created.vendorSessionId,
        approvalPolicy: "never",
      });
      const cancellation = await session.submit({
        session: created,
        clientInputId: "codex-conformance-cancel",
        text:
          "Write at least 3000 words about computing history. Do not use tools. " +
          "Start immediately and do not summarize.",
      });
      if (cancellation.outcome !== "accepted" || cancellation.turnId === null) {
        throw new Error(`cancel turn was ${cancellation.outcome}`);
      }
      await waitFor(
        () =>
          seen.find(
            (event) =>
              event.kind === "turn-started" &&
              event.turnId === cancellation.turnId,
          ),
        "cancel turn start",
      );
      await session.cancel(cancellation.turnId);
      expect((await waitForTerminal(seen, cancellation.turnId)).kind).toBe(
        "interrupted",
      );
      steps["5-targeted-interrupt"] = "pass";

      const resumed = await session.resumeSession({
        vendorSessionId: created.vendorSessionId,
        style: "resume",
      });
      expect(resumed.vendorSessionId).toBe(created.vendorSessionId);
      const read = await session.readThread(created.vendorSessionId, true);
      expect(read.thread.id).toBe(created.vendorSessionId);
      steps["6-resume-and-read-thread"] = "pass";

      const [commands, models, permissions, config, threads] =
        await Promise.all([
          session.listCommands(),
          session.listModels({ limit: 2 }),
          session.listPermissionProfiles({ limit: 2, cwd: process.cwd() }),
          session.readConfig({ includeLayers: false, cwd: process.cwd() }),
          session.listThreads({ limit: 2, cwd: process.cwd() }),
        ]);
      for (const name of [
        "review",
        "compact",
        "model",
        "permissions",
        "status",
      ]) {
        expect(commands.some((command) => command.name === name)).toBe(true);
      }
      expect(models.data.length).toBeGreaterThan(0);
      expect(permissions.data.length).toBeGreaterThan(0);
      expect(config.config).toBeDefined();
      expect(
        threads.data.some((thread) => thread.id === created.vendorSessionId),
      ).toBe(true);
      steps["7-commands-models-permissions-config-status"] = "pass";

      const review = await session.startReview({
        threadId: created.vendorSessionId,
        target: {
          type: "custom",
          instructions: "Reply with exactly REVIEW_OK. Do not use tools.",
        },
      });
      expect((await waitForTerminal(seen, review.turn.id)).kind).toBe(
        "turn-idle",
      );
      steps["7b-review-start"] = "pass";

      const compactOffset = seen.length;
      await session.compact(created.vendorSessionId);
      await waitFor(
        () =>
          eventAfter(
            seen,
            compactOffset,
            (event) => event.kind === "compacted",
          ),
        "thread compaction",
      );
      steps["7c-thread-compact"] = "pass";

      const reconnectOffset = seen.length;
      const startsBeforeReconnect = seen.filter(
        (event) => event.kind === "turn-started",
      ).length;
      await session.disconnect();
      await waitFor(
        () =>
          eventAfter(
            seen,
            reconnectOffset,
            (event) => event.kind === "runtime-disconnected",
          ),
        "runtime disconnect",
      );
      await session.reconnect();
      await waitFor(
        () =>
          eventAfter(
            seen,
            reconnectOffset,
            (event) => event.kind === "runtime-ready",
          ),
        "runtime reconnect",
      );
      await sleep(250);
      expect(seen.filter((event) => event.kind === "turn-started").length).toBe(
        startsBeforeReconnect,
      );
      const afterReconnect = await session.submit({
        session: created,
        clientInputId: "codex-after-reconnect",
        text: "Reply with exactly RECONNECTED and nothing else. Do not use tools.",
      });
      if (
        afterReconnect.outcome !== "accepted" ||
        afterReconnect.turnId === null
      ) {
        throw new Error(`post-reconnect prompt was ${afterReconnect.outcome}`);
      }
      expect((await waitForTerminal(seen, afterReconnect.turnId)).kind).toBe(
        "turn-idle",
      );
      expect(seen.filter((event) => event.kind === "turn-started").length).toBe(
        startsBeforeReconnect + 1,
      );
      steps["8-disconnect-reattach-no-duplicate"] = "pass";

      expect(unprovenBaseline(session.capabilities)).toEqual([]);
      expect(steadyStateUnknowns(session.capabilities)).toEqual([]);
      expect(
        Object.values(summarizeCapabilities(session)).every(
          (support) => support !== "unknown",
        ),
      ).toBe(true);
    } finally {
      await session?.close();
      if (reader !== null) await reader;
      const orphans = await waitFor(
        async () => {
          const rows = await appServerRows();
          const added = rows.filter((row) => !baselinePids.has(row.pid));
          return added.length === 0 ? added : undefined;
        },
        "App Server process-group exit",
        5_000,
      );
      processAudit = {
        ...processAudit,
        noOrphansAfterClose: orphans.length === 0,
      };
      writeEvidence({
        runtime: {
          product: "codex-cli",
          version: measuredVersion,
          executable: "<user-home>/.local/bin/codex",
          resolvedExecutable: resolvedExecutable.replace(
            /^\/Users\/[^/]+/,
            "<user-home>",
          ),
        },
        runAt: new Date().toISOString(),
        steps,
        capabilities: session === null ? {} : summarizeCapabilities(session),
        unprovenBaseline:
          session === null ? [] : [...unprovenBaseline(session.capabilities)],
        steadyStateUnknowns:
          session === null
            ? []
            : [...steadyStateUnknowns(session.capabilities)],
        eventKinds: [...new Set(seen.map((event) => event.kind))],
        counts: {
          events: seen.length,
          approvals: seen.filter((event) => event.kind === "approval-waiting")
            .length,
          terminalTurns: seen.filter((event) =>
            ["turn-idle", "turn-failed", "interrupted"].includes(event.kind),
          ).length,
        },
        processAudit,
        sanitized: true,
      });
    }
  },
  10 * 60_000,
);
