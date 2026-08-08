import { homedir } from "node:os";
import { join } from "node:path";

import { findLatestCodexRollout } from "../adapters/providers/codex-cli";
import {
  findLatestGrokSessionDirectory,
  findLatestGrokSessionId,
} from "../adapters/providers/grok-cli";
import { grokQueenHome } from "../adapters/queen-skills";
import type { TurnBoundaryKind } from "../daemon/status-service/status-service";
import { readNativeTurnCompleted } from "../daemon/observability/tool-telemetry";
import type { CapabilityProvider } from "../schemas/capability";
import { ORCHESTRATOR_NAME } from "../schemas/agent";
import { userFetch } from "./credential";
import { buildHookEvent, postHookEvent } from "./event-command";
import { publishOrchestratorSessionId } from "./orchestrator-runtime";
import { orchestratorConfigRoot } from "./orchestrator";
import { abortableSleep } from "../shared/sleep";
import { errorMessage } from "../shared/error-message";

const POLL_MS = 250;

export interface NativeTurnArtifact {
  readonly sessionId: string;
  readonly path: string;
}

export interface NativeTurnMonitorDependencies {
  readonly locate: () => Promise<NativeTurnArtifact | null>;
  readonly read: (artifact: NativeTurnArtifact) => Promise<boolean | null>;
  readonly report: (kind: TurnBoundaryKind, sessionId: string) => Promise<void>;
  readonly identify?: (artifact: NativeTurnArtifact) => Promise<void>;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly warn: (message: string) => void;
}

export async function monitorNativeOrchestratorTurns(
  baselineSessionId: string | null,
  signal: AbortSignal,
  dependencies: NativeTurnMonitorDependencies,
): Promise<void> {
  let artifact: NativeTurnArtifact | null = null;
  let reported: boolean | null = null;
  let lastWarning: string | null = null;

  while (!signal.aborted) {
    try {
      if (artifact === null) {
        const candidate = await dependencies.locate();
        if (candidate !== null && candidate.sessionId !== baselineSessionId) {
          await dependencies.identify?.(candidate);
          artifact = candidate;
        }
      }
      if (artifact !== null) {
        const observed = await dependencies.read(artifact);
        if (observed !== null && observed !== reported) {
          if (reported === null && observed) {
            await dependencies.report("turn-start", artifact.sessionId);
            await dependencies.report("turn-end", artifact.sessionId);
          } else {
            await dependencies.report(
              observed ? "turn-end" : "turn-start",
              artifact.sessionId,
            );
          }
          reported = observed;
        }
      }
      lastWarning = null;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== lastWarning) {
        dependencies.warn(
          `[hive] orchestrator status observation failed: ${message}`,
        );
        lastWarning = message;
      }
    }
    await dependencies.sleep(POLL_MS, signal);
  }
}

async function locateNativeTurnArtifact(
  tool: "codex" | "grok",
  cwd: string,
): Promise<NativeTurnArtifact | null> {
  if (tool === "codex") {
    const rollout = await findLatestCodexRollout(cwd, homedir());
    return rollout === null
      ? null
      : { sessionId: rollout.sessionId, path: rollout.path };
  }
  const home = grokQueenHome(orchestratorConfigRoot());
  const sessionId = await findLatestGrokSessionId(cwd, home);
  if (sessionId === null) return null;
  const directory = await findLatestGrokSessionDirectory(cwd, sessionId, home);
  return directory === null
    ? null
    : { sessionId, path: join(directory, "updates.jsonl") };
}

async function reportBoundary(
  port: number,
  kind: TurnBoundaryKind,
  sessionId: string,
): Promise<void> {
  await postHookEvent(
    buildHookEvent(kind, {
      agent: ORCHESTRATOR_NAME,
      toolSessionId: sessionId,
    }),
    port,
    userFetch,
  );
}

/** Run one root generation with an implemented passive artifact monitor. Failure to establish the baseline fails closed to unknown status while leaving the orchestrator itself usable. */
export async function withNativeOrchestratorTurnMonitor<T>(
  tool: CapabilityProvider,
  port: number,
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  if (tool !== "codex" && tool !== "grok") return run();
  const nativeTool = tool;
  if (!(await publishOrchestratorSessionId(null))) {
    console.error("[hive] orchestrator session identity marker unavailable");
  }
  let baseline: NativeTurnArtifact | null;
  try {
    baseline = await locateNativeTurnArtifact(nativeTool, cwd);
  } catch (error) {
    console.error(
      `[hive] orchestrator status baseline unavailable: ${errorMessage(error)}`,
    );
    return run();
  }

  const controller = new AbortController();
  const monitor = monitorNativeOrchestratorTurns(
    baseline?.sessionId ?? null,
    controller.signal,
    {
      locate: () => locateNativeTurnArtifact(nativeTool, cwd),
      read: (artifact) => readNativeTurnCompleted(artifact.path, nativeTool),
      identify: async (artifact) => {
        if (!(await publishOrchestratorSessionId(artifact.sessionId))) {
          throw new Error("orchestrator session identity marker unavailable");
        }
      },
      report: (kind, sessionId) => reportBoundary(port, kind, sessionId),
      sleep: abortableSleep,
      warn: (message) => console.error(message),
    },
  );
  try {
    return await run();
  } finally {
    controller.abort();
    await monitor;
  }
}
