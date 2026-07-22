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

type AuthorizedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? `queen session request failed with HTTP ${response.status}`);
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
    throw new Error("sessiond queen returned a locator outside the launch request");
  }
  if (expected !== null && !sameSessionLocator(expected, locator)) {
    throw new Error("sessiond queen locator changed during one launch request");
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
  let snapshot = await control.start(launch);
  let locator = requireExactRootGeneration(launch, snapshot, null);
  while (true) {
    switch (snapshot.state) {
      case "exited":
        return snapshot.exitCode ?? 1;
      case "failed":
        return 1;
      case "awaiting-visibility":
      case "running":
        await sleep(250);
        break;
    }
    const inspected = await control.inspect(launch.requestId);
    snapshot = inspected ?? await control.start(launch);
    locator = requireExactRootGeneration(launch, snapshot, locator);
  }
}
