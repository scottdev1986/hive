import type { HiveDatabase } from "./db";
import type { MessageDelivery } from "./delivery";
import { hiveInstanceSuffix } from "./instance-identity";
import type { OrchestratorSessiondController } from "./orchestrator-sessiond";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
  sessiondAgentProviderRunIsDead,
} from "./session-host/hive-terminal-host";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../schemas";

/**
 * The wake-path check, with its dependencies named.
 *
 * `alertedWakeFaults` passes by reference: the check de-duplicates its own
 * alerts across sweeps by remembering what it has already reported, so the set
 * has to be the daemon's, not a fresh one per call.
 */
export interface WakePathCheckDeps {
  alertedWakeFaults: Set<string>;
  db: HiveDatabase;
  delivery: MessageDelivery;
  orchestratorSessiond: OrchestratorSessiondController | null;
  terminalHost: HiveTerminalHostAdapter;
  hasCompletedSessiondBinding: (agent: AgentRecord) => boolean;
}

export async function checkWakePaths(
  deps: WakePathCheckDeps,
): Promise<readonly string[]> {
  const faults: string[] = [];
  const live = deps.db
    .listAgents()
    .filter((agent) => !["dead", "done", "failed"].includes(agent.status));
  // No team, no wake to protect — and nobody to tell.
  if (live.length > 0) {
    const root = deps.orchestratorSessiond?.snapshot() ?? null;
    if (root === null) {
      faults.push("the root wake path has no queen generation");
    } else if (root.state !== "running") {
      faults.push(
        `the root wake path is ${root.state}` +
          (root.diagnostic === null ? "" : `: ${root.diagnostic}`),
      );
    } else {
      try {
        const inspection = await deps.terminalHost.inspect(
          requireSessiondRootLocator(root.locator),
        );
        const activeRun = deps.terminalHost.reconcileProviderRun(root.locator);
        if (sessiondAgentProviderRunIsDead(inspection, activeRun)) {
          faults.push("the queen vendor process is confirmed dead");
        } else if (inspection.presence !== "present") {
          faults.push(
            `the queen presence is ${inspection.presence}, not present`,
          );
        }
      } catch (error) {
        faults.push(
          `the queen cannot be inspected (${
            error instanceof Error ? error.message : "unknown error"
          })`,
        );
      }
    }
    // A locator exists before sessiond finishes registering it. The broker
    // cannot list that in-flight create yet, so absence is not death until
    // the binding carries completed create evidence.
    const sessiond = live.filter((agent) =>
      deps.hasCompletedSessiondBinding(agent),
    );
    if (sessiond.length > 0) {
      let listed: Awaited<ReturnType<HiveTerminalHostAdapter["list"]>> | null =
        null;
      try {
        listed = await deps.terminalHost.list(hiveInstanceSuffix());
      } catch (error) {
        faults.push(
          `the sessiond broker will not list sessions (${
            error instanceof Error ? error.message : "unknown error"
          }), so no message can reach any sessiond agent`,
        );
      }
      for (const agent of sessiond) {
        if (listed === null) break;
        const match = listed.find(
          (inspection) =>
            inspection.locator.sessionId === agent.sessionLocator?.sessionId,
        );
        if (match === undefined) {
          faults.push(
            `${agent.name}'s sessiond session is not listed by the broker`,
          );
        } else if (
          sessiondAgentProviderRunIsDead(
            match,
            deps.terminalHost.reconcileProviderRun(
              requireSessiondAgentLocator(agent),
            ),
          )
        ) {
          faults.push(
            `${agent.name}'s sessiond vendor process is confirmed dead`,
          );
        } else if (match.presence !== "present") {
          faults.push(
            `${agent.name}'s sessiond session presence is ${match.presence}, not present`,
          );
        }
      }
    }
  }
  for (const fault of faults) {
    if (deps.alertedWakeFaults.has(fault)) continue;
    deps.alertedWakeFaults.add(fault);
    await deps.delivery
      .send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `Wake path check failed: ${fault}.`,
      )
      .catch(() => undefined);
  }
  // Re-arm cleared faults so a recurrence is reported again.
  for (const fault of [...deps.alertedWakeFaults]) {
    if (!faults.includes(fault)) deps.alertedWakeFaults.delete(fault);
  }
  return faults;
}
