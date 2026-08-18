import {
  type RootSessiondLocator,
  rootSessionIdForLaunchRequest,
} from "../daemon/orchestrator-host/orchestrator-host-contract";
import {
  type OrchestratorSessiondLaunch,
  type OrchestratorSessiondSnapshot,
  OrchestratorSessiondSnapshotSchema,
} from "../daemon/orchestrator-host/sessiond-controller";
import { sameSessionLocator } from "../daemon/session-host/locators";
import { hiveInstanceSuffix } from "../hive-home/home";
import { errorMessage } from "../shared/error-message";
import { isTestRunnerEnv } from "./invoker";
import {
  daemonErrorDetail,
  decodeJson,
  UserDaemonClient,
} from "./user-daemon-client";

export interface OrchestratorSessiondControl {
  start(
    request: OrchestratorSessiondLaunch,
  ): Promise<OrchestratorSessiondSnapshot>;
  waitForTerminal(requestId: string): Promise<OrchestratorSessiondWaitResult>;
}

export type OrchestratorSessiondWaitResult =
  | Readonly<{ kind: "snapshot"; snapshot: OrchestratorSessiondSnapshot }>
  | Readonly<{ kind: "missing" }>;

export class OrchestratorLaunchFailedError extends Error {
  readonly code = "ORCHESTRATOR_LAUNCH_FAILED" as const;

  constructor(readonly detail: string) {
    super(`ORCHESTRATOR_LAUNCH_FAILED: ${detail}`);
    this.name = "OrchestratorLaunchFailedError";
  }
}

function typedLaunchFailure(
  action: string,
  error: unknown,
): OrchestratorLaunchFailedError {
  if (error instanceof OrchestratorLaunchFailedError) return error;
  return new OrchestratorLaunchFailedError(`${action}: ${errorMessage(error)}`);
}

type AuthorizedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function responseError(
  response: Response,
): Promise<OrchestratorLaunchFailedError> {
  return new OrchestratorLaunchFailedError(
    daemonErrorDetail(
      await decodeJson(response),
      `queen session request failed with HTTP ${response.status}`,
    ).message,
  );
}

export function daemonOrchestratorSessiondControl(
  port: number,
  request?: AuthorizedFetch,
): OrchestratorSessiondControl {
  const daemon = new UserDaemonClient({
    port,
    ...(request === undefined ? {} : { fetch: request }),
    verifyIdentity: request === undefined && !isTestRunnerEnv(),
  });
  return {
    start: async (launch) => {
      const response = await daemon.request("/orchestrator-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(launch),
      });
      if (!response.ok) throw await responseError(response);
      return OrchestratorSessiondSnapshotSchema.parse(await response.json());
    },
    waitForTerminal: async (requestId) => {
      const response = await daemon.request(
        `/orchestrator-session?requestId=${encodeURIComponent(requestId)}`,
      );
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) throw await responseError(response);
      return {
        kind: "snapshot",
        snapshot: OrchestratorSessiondSnapshotSchema.parse(
          await response.json(),
        ),
      };
    },
  };
}

function requireExactRootGeneration(
  launch: OrchestratorSessiondLaunch,
  snapshot: OrchestratorSessiondSnapshot,
  expected: RootSessiondLocator | null,
): RootSessiondLocator {
  const locator = snapshot.locator;
  if (
    snapshot.requestId !== launch.requestId ||
    locator.instanceId !== hiveInstanceSuffix() ||
    locator.sessionId !== rootSessionIdForLaunchRequest(launch.requestId)
  ) {
    throw new OrchestratorLaunchFailedError(
      "sessiond queen returned a locator outside the launch request",
    );
  }
  if (expected !== null && !sameSessionLocator(expected, locator)) {
    throw new OrchestratorLaunchFailedError(
      "sessiond queen locator changed during one launch request",
    );
  }
  return locator;
}

/** Wait for one exact root generation. A missing result means the daemon no longer holds that request; replaying the same idempotent start reconstructs its durable locator instead of launching a second queen. */
export async function runOrchestratorSessiondLaunch(
  launch: OrchestratorSessiondLaunch,
  control: OrchestratorSessiondControl,
): Promise<number> {
  const start = async (): Promise<OrchestratorSessiondSnapshot> => {
    try {
      return await control.start(launch);
    } catch (error) {
      throw typedLaunchFailure("sessiond queen start request failed", error);
    }
  };
  const waitForTerminal = async (): Promise<OrchestratorSessiondWaitResult> => {
    try {
      return await control.waitForTerminal(launch.requestId);
    } catch (error) {
      throw typedLaunchFailure("sessiond queen wait failed", error);
    }
  };
  let snapshot = await start();
  let locator = requireExactRootGeneration(launch, snapshot, null);
  while (true) {
    switch (snapshot.state) {
      case "exited":
        if ((snapshot.exitCode ?? 1) !== 0 && snapshot.diagnostic !== null) {
          throw new OrchestratorLaunchFailedError(snapshot.diagnostic);
        }
        return snapshot.exitCode ?? 1;
      case "failed":
        throw new OrchestratorLaunchFailedError(
          snapshot.diagnostic ??
            "sessiond queen launch failed without a diagnostic",
        );
      case "awaiting-visibility":
      case "running":
        break;
    }
    const waited = await waitForTerminal();
    snapshot = waited.kind === "missing" ? await start() : waited.snapshot;
    locator = requireExactRootGeneration(launch, snapshot, locator);
  }
}
