import { type AgentRecord, ORCHESTRATOR_NAME } from "../schemas/agent";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../schemas/capability";
import {
  type PrepareQueenLaunchRequest,
  type PrepareQueenLaunchResponse,
  PrepareQueenLaunchResponseSchema,
} from "../schemas/run-checkpoint";
import { isTestRunnerEnv } from "./invoker";
import { userFetch } from "./credential";
import {
  daemonErrorDetail,
  decodeJson,
  UserDaemonClient,
} from "./user-daemon-client";
import { buildHookEvent, postHookEvent } from "./event-command";
import { fetchAgentStatus } from "./mcp";
import { launchOrchestrator } from "./orchestrator";
import { withOrchestratorRuntime } from "./orchestrator-runtime";
import { OrchestratorLaunchFailedError } from "./orchestrator-sessiond";
import { withNativeOrchestratorTurnMonitor } from "./orchestrator-turn-monitor";
import {
  endTokenUsageSession,
  endTokenUsageSubject,
  startOrchestratorTokenSubject,
  startTokenUsageSession,
} from "../usage-service/token-usage-client";
import { errorMessage } from "../shared/error-message";
import { mintSessionRequestId } from "../daemon/session-host/locators";

const STATUS_RETRY_MAX_MS = 30_000;
const RAPID_EXIT_MS = 10_000;

export interface OrchestratorSupervisorDependencies {
  initialTool: CapabilityProvider;
  launch: (
    tool: CapabilityProvider,
    prepared: PrepareQueenLaunchResponse,
  ) => Promise<number>;
  prepareLaunch: (
    request: PrepareQueenLaunchRequest,
  ) => Promise<PrepareQueenLaunchResponse>;
  desiredTool: () => Promise<CapabilityProvider | null>;
  reportLaunchFailure: (
    tool: CapabilityProvider,
    detail: string,
  ) => Promise<void>;
  fetchAgents: () => Promise<AgentRecord[]>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  report: (message: string) => void;
}

async function readKnownAgentState(
  dependencies: OrchestratorSupervisorDependencies,
): Promise<AgentRecord[]> {
  let delay = 1_000;
  while (true) {
    try {
      return await dependencies.fetchAgents();
    } catch (error) {
      dependencies.report(
        `[hive] Hive cannot determine agent state; refusing to guess and retrying (${errorMessage(error)})`,
      );
      await dependencies.sleep(delay);
      delay = Math.min(delay * 2, STATUS_RETRY_MAX_MS);
    }
  }
}

export async function superviseOrchestratorSession(
  dependencies: OrchestratorSupervisorDependencies,
): Promise<number> {
  let consecutiveRapidExits = 0;
  let lastLiveTool: CapabilityProvider | null = null;
  let reason: PrepareQueenLaunchRequest["reason"] = "initial-boot";
  let reasonDetail = "initial queen boot";

  while (true) {
    const desired = await dependencies.desiredTool().catch(() => null);
    const tool: CapabilityProvider =
      desired ?? lastLiveTool ?? dependencies.initialTool;
    if (desired !== null && lastLiveTool !== null && desired !== lastLiveTool) {
      reason = "provider-change";
      reasonDetail = `queen provider changed from ${lastLiveTool} to ${desired}`;
    }
    // Gate the relaunch on the daemon answering: readKnownAgentState retries
    // until it gets through, while a rejected prepareLaunch would propagate
    // out of the supervisor and kill it. The agent snapshot the succession
    // needs is built daemon-side, so the read here only waits.
    await readKnownAgentState(dependencies);
    const requestId = mintSessionRequestId();
    const prepared = await dependencies.prepareLaunch({
      requestId,
      provider: tool,
      cwd: process.cwd(),
      reason,
      reasonDetail,
    });
    const startedAt = dependencies.now();
    let exitCode: number;
    try {
      exitCode = await dependencies.launch(tool, prepared);
      lastLiveTool = tool;
    } catch (error) {
      if (!(error instanceof OrchestratorLaunchFailedError)) throw error;
      dependencies.report(`[hive] ${error.message}`);
      await dependencies
        .reportLaunchFailure(tool, error.message)
        .catch(() => {});
      exitCode = 1;
    }
    const lifetime = Math.max(0, dependencies.now() - startedAt);
    const after = await readKnownAgentState(dependencies);
    const liveAgents = after.filter(
      (agent) => !["dead", "done", "failed"].includes(agent.status),
    );
    const steered = await dependencies.desiredTool().catch(() => null);
    if (liveAgents.length === 0 && (steered === null || steered === tool)) {
      dependencies.report(
        `[hive] orchestrator exited with code ${exitCode}; no live agents remain`,
      );
      return exitCode;
    }
    reason =
      steered !== null && steered !== tool
        ? "provider-change"
        : "root-exit-with-live-agents";
    reasonDetail =
      reason === "root-exit-with-live-agents"
        ? `orchestrator exited with code ${exitCode} while ${liveAgents.length} agent(s) remained active`
        : `orchestrator exited with code ${exitCode}`;
    consecutiveRapidExits =
      lifetime < RAPID_EXIT_MS ? consecutiveRapidExits + 1 : 0;
    if (consecutiveRapidExits > 0) {
      const delay = Math.min(
        1_000 * 2 ** (consecutiveRapidExits - 1),
        STATUS_RETRY_MAX_MS,
      );
      await dependencies.sleep(delay);
    }
  }
}

export async function daemonSteeredTool(
  port: number,
): Promise<CapabilityProvider | null> {
  const response = await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  })
    .request("/queen-succession/steer")
    .catch(() => null);
  if (response === null || !response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    tool?: unknown;
  } | null;
  const parsed = CapabilityProviderSchema.safeParse(body?.tool);
  return parsed.success ? parsed.data : null;
}

export async function reportQueenLaunchFailure(
  port: number,
  tool: CapabilityProvider,
  detail: string,
): Promise<void> {
  const response = await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  }).request("/queen-succession/launch-failure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: tool, detail }),
  });
  if (!response.ok) {
    throw new Error(
      `queen launch-failure report refused: ${daemonErrorDetail(await decodeJson(response), `HTTP ${response.status}`).message}`,
    );
  }
}

export async function prepareQueenLaunch(
  port: number,
  request: PrepareQueenLaunchRequest,
): Promise<PrepareQueenLaunchResponse> {
  const response = await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  }).request("/queen-succession/prepare-launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `queen launch preparation refused: ${daemonErrorDetail(await decodeJson(response), `HTTP ${response.status}`).message}`,
    );
  }
  return PrepareQueenLaunchResponseSchema.parse(await response.json());
}

export async function runWorkspaceOrchestrator(
  tool: CapabilityProvider,
  port: number,
  cwd = process.cwd(),
): Promise<number> {
  return await withOrchestratorRuntime(tool, async () => {
    let tokenSessionId: string | null = null;
    try {
      tokenSessionId = await startTokenUsageSession(port, cwd);
    } catch (error) {
      console.error(
        `[hive] token tracking unavailable: ${errorMessage(error)}`,
      );
    }
    const exitCode = await superviseOrchestratorSession({
      initialTool: tool,
      desiredTool: () => daemonSteeredTool(port),
      prepareLaunch: (request) => prepareQueenLaunch(port, { ...request, cwd }),
      reportLaunchFailure: (launchTool, detail) =>
        reportQueenLaunchFailure(port, launchTool, detail),
      launch: async (launchTool, prepared) => {
        let subjectId: string | null = null;
        if (tokenSessionId !== null) {
          subjectId = await startOrchestratorTokenSubject(
            port,
            tokenSessionId,
            launchTool,
            cwd,
          ).catch(() => null);
        }
        try {
          await postHookEvent(
            buildHookEvent("session-launch", { agent: ORCHESTRATOR_NAME }),
            port,
            userFetch,
          );
          return await withNativeOrchestratorTurnMonitor(
            launchTool,
            port,
            cwd,
            () =>
              launchOrchestrator(
                launchTool,
                port,
                cwd,
                prepared.bootCapsule,
                {},
                prepared.targetGeneration,
              ),
          ).catch((error: unknown) => {
            if (error instanceof OrchestratorLaunchFailedError) throw error;
            throw new OrchestratorLaunchFailedError(errorMessage(error));
          });
        } finally {
          if (subjectId !== null) {
            await endTokenUsageSubject(port, subjectId).catch(() => {});
          }
        }
      },
      fetchAgents: async () => await fetchAgentStatus(port),
      sleep: async (milliseconds) =>
        await new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: Date.now,
      report: (message) => console.error(message),
    });
    await postHookEvent(
      buildHookEvent("session-end", { agent: ORCHESTRATOR_NAME }),
      port,
      userFetch,
    ).catch(() => {});
    if (tokenSessionId !== null) {
      await endTokenUsageSession(port, tokenSessionId).catch(() => {});
    }
    return exitCode;
  });
}
