import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import {
  rootSessionIdForLaunchRequest,
  type RootSessiondLocator,
} from "../daemon/orchestrator-host";
import {
  OrchestratorSessiondSnapshotSchema,
  type OrchestratorSessiondLaunch,
  type OrchestratorSessiondSnapshot,
} from "../daemon/orchestrator-sessiond";
import { sameSessionLocator } from "../daemon/session-host/locators";
import { operatorFetch } from "./credential";

export interface OrchestratorSessiondControl {
  start(request: OrchestratorSessiondLaunch): Promise<OrchestratorSessiondSnapshot>;
  inspect(requestId: string): Promise<OrchestratorSessiondSnapshot | null>;
}

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
  return new OrchestratorLaunchFailedError(
    `${action}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

type AuthorizedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function responseError(response: Response): Promise<OrchestratorLaunchFailedError> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return new OrchestratorLaunchFailedError(
    body?.error ?? `queen session request failed with HTTP ${response.status}`,
  );
}

export function daemonOrchestratorSessiondControl(
  port: number,
  request: AuthorizedFetch = operatorFetch,
): OrchestratorSessiondControl {
  const endpoint = `http://127.0.0.1:${port}/orchestrator-session`;
  return {
    start: async (launch) => {
      const response = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(launch),
      });
      if (!response.ok) throw await responseError(response);
      return OrchestratorSessiondSnapshotSchema.parse(await response.json());
    },
    inspect: async (requestId) => {
      const response = await request(
        `${endpoint}?requestId=${encodeURIComponent(requestId)}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw await responseError(response);
      return OrchestratorSessiondSnapshotSchema.parse(await response.json());
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

/** Wait for one exact root generation. A missing snapshot means the daemon
 * restarted; retrying the same request reconstructs the same locator instead
 * of launching a second queen. */
export async function runOrchestratorSessiondLaunch(
  launch: OrchestratorSessiondLaunch,
  control: OrchestratorSessiondControl,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    Bun.sleep(milliseconds),
): Promise<number> {
  const start = async (): Promise<OrchestratorSessiondSnapshot> => {
    try {
      return await control.start(launch);
    } catch (error) {
      throw typedLaunchFailure("sessiond queen start request failed", error);
    }
  };
  const inspect = async (): Promise<OrchestratorSessiondSnapshot | null> => {
    try {
      return await control.inspect(launch.requestId);
    } catch (error) {
      throw typedLaunchFailure("sessiond queen inspection failed", error);
    }
  };
  let snapshot = await start();
  let locator = requireExactRootGeneration(launch, snapshot, null);
  while (true) {
    switch (snapshot.state) {
      case "exited":
        return snapshot.exitCode ?? 1;
      case "failed":
        throw new OrchestratorLaunchFailedError(
          snapshot.diagnostic ?? "sessiond queen launch failed without a diagnostic",
        );
      case "awaiting-visibility":
      case "running":
        await sleep(250);
        break;
    }
    const inspected = await inspect();
    snapshot = inspected ?? await start();
    locator = requireExactRootGeneration(launch, snapshot, locator);
  }
}
