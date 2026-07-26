import { logAlertDeliveryFailure } from "./alert-log";
import type { HiveDatabase } from "./db";
import type { MessageDelivery } from "./delivery";
import type { OrchestratorSessiondController } from "./orchestrator-sessiond";
import {
  assessResources,
  type CommandOutput,
  parseAvailableMemoryMb,
  parseProcessTable,
  type ResourceLimits,
} from "./resources";
import {
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
} from "./session-host/hive-terminal-host";
import type { HiveTerminalHostAdapter } from "./session-host/hive-terminal-host";
import {
  type ReapDependencies,
  type ReapOutcome,
  reapCapturedTree,
} from "./teardown";
import { ORCHESTRATOR_NAME } from "../schemas";

/**
 * The resource watchdog, with its dependencies named.
 *
 * Fourth extraction of the `HiveDaemon` decomposition (audit §11).
 * `memoryPressure` is daemon-owned mutable state read by an unrelated endpoint,
 * so it crosses as a setter rather than a field: the sweep must be able to raise
 * the flag without owning it, and a copied boolean would strand the reader on a
 * stale value.
 */
export interface SweepResourcesDeps {
  db: HiveDatabase;
  delivery: MessageDelivery;
  orchestratorSessiond: OrchestratorSessiondController | null;
  terminalHost: HiveTerminalHostAdapter;
  resources: ResourceLimits | null;
  psSample: CommandOutput;
  vmStatSample: CommandOutput;
  killProcess: (pid: number) => void;
  reapDependencies: ReapDependencies;
  setMemoryPressure: (value: boolean) => void;
  reapCodexOrphans: () => Promise<void>;
}

export async function sweepResources(deps: SweepResourcesDeps): Promise<void> {
  const limits = deps.resources;
  if (limits === null || !limits.enabled) return;
  try {
    const [psRaw, vmRaw] = await Promise.all([
      deps.psSample(),
      deps.vmStatSample(),
    ]);
    const sessions: Array<{ owner: string; rootPids: number[] }> = [];
    const root = deps.orchestratorSessiond?.snapshot() ?? null;
    if (root !== null) {
      try {
        const inspection = await deps.terminalHost.inspect(
          requireSessiondRootLocator(root.locator),
        );
        sessions.push({
          owner: ORCHESTRATOR_NAME,
          rootPids:
            inspection.shellRoot === null ? [] : [inspection.shellRoot.pid],
        });
      } catch {
        // A vanished session has no processes left to watch.
      }
    }
    for (const agent of deps.db
      .listAgents()
      .filter(
        (candidate) => !["dead", "done", "failed"].includes(candidate.status),
      )) {
      try {
        const inspection = await deps.terminalHost.inspect(
          requireSessiondAgentLocator(agent),
        );
        sessions.push({
          owner: agent.name,
          rootPids:
            inspection.shellRoot === null ? [] : [inspection.shellRoot.pid],
        });
      } catch {
        // A vanished session has no processes left to watch.
      }
    }
    const assessment = assessResources({
      samples: parseProcessTable(psRaw),
      sessions,
      daemonPid: process.pid,
      availableMb: parseAvailableMemoryMb(vmRaw),
      limits,
    });
    deps.setMemoryPressure(assessment.memoryPressure);
    for (const kill of assessment.kills) {
      let reaped: ReapOutcome;
      try {
        reaped = await reapCapturedTree(
          [
            {
              pid: kill.process.pid,
              command: kill.process.command,
            },
          ],
          {
            ...deps.reapDependencies,
            kill: (pid) => deps.killProcess(pid),
          },
        );
      } catch (error) {
        console.error(
          `Hive memory watchdog could not verify pid ${kill.process.pid} under ${kill.owner}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        await deps.delivery
          .send(
            "hive-resources",
            ORCHESTRATOR_NAME,
            `Hive memory watchdog FAILED to verify whether pid ${kill.process.pid} under ${kill.owner} stopped ` +
              `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
              `${kill.process.command.slice(0, 160)}. The process may still be allocating; ` +
              `it may need to be stopped by hand.`,
            { idempotencyKey: `resource-kill-failed:${kill.process.pid}` },
          )
          .catch(logAlertDeliveryFailure);
        continue;
      }
      if (reaped.survivors.length > 0) {
        console.error(
          `Hive memory watchdog failed to kill pid ${kill.process.pid} under ${kill.owner}: process survived SIGKILL`,
        );
        await deps.delivery
          .send(
            "hive-resources",
            ORCHESTRATOR_NAME,
            `Hive memory watchdog FAILED to kill pid ${kill.process.pid} under ${kill.owner} ` +
              `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
              `${kill.process.command.slice(0, 160)}. The process survived SIGKILL and may still be allocating; ` +
              `it may need to be stopped by hand.`,
            { idempotencyKey: `resource-kill-failed:${kill.process.pid}` },
          )
          .catch(logAlertDeliveryFailure);
        continue;
      }
      await deps.delivery
        .send(
          "hive-resources",
          ORCHESTRATOR_NAME,
          `Hive memory watchdog killed pid ${kill.process.pid} under ${kill.owner} ` +
            `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
            `${kill.process.command.slice(0, 160)}. The ${kill.owner} session itself is still running; ` +
            `check whether its work needs to be retried.`,
          { idempotencyKey: `resource-kill:${kill.process.pid}` },
        )
        .catch(logAlertDeliveryFailure);
      // The agent whose child died sees only an opaque failed command, so it
      // reads the death as "my command was wrong" and retries — the 2026-07-12
      // incident was three escalating OOM kills in 90 seconds, each a wider
      // search than the last. A killed process cannot report its own cause of
      // death; only the killer can, and it must tell the agent, not just the
      // orchestrator watching it.
      if (kill.owner !== ORCHESTRATOR_NAME) {
        await deps.delivery
          .send(
            "hive-resources",
            kill.owner,
            `Hive's memory watchdog KILLED a process you started — the command did not fail on its own. ` +
              `pid ${kill.process.pid} reached ${Math.round(kill.process.rssMb)} MB resident, ` +
              `past the ${limits.perProcessMemoryMb} MB per-process ceiling that keeps this machine alive: ` +
              `${kill.process.command.slice(0, 160)}. Do NOT retry it as written, and do not widen it — ` +
              `a bigger version of the same command hits the same ceiling faster. Make it cheaper: ` +
              `narrow the input (scope a search to a subdirectory), anchor patterns on real literals ` +
              `instead of leading with \`.*\` or \`.{0,N}\`, or use a different tool. Your session is fine; ` +
              `only that process was killed.`,
            { idempotencyKey: `resource-kill-owner:${kill.process.pid}` },
          )
          .catch(logAlertDeliveryFailure);
      }
    }
    if (assessment.memoryPressure && assessment.availableMb !== null) {
      await deps.delivery
        .send(
          "hive-resources",
          ORCHESTRATOR_NAME,
          `Hive paused agent spawning: ${Math.round(assessment.availableMb)} MB of ` +
            `reclaimable system memory is below the ${limits.minSystemAvailableMb} MB floor. ` +
            "Spawns resume automatically once memory pressure clears.",
          // One alert per hour of sustained pressure, not one per sweep.
          {
            idempotencyKey: `resource-pressure:${new Date().toISOString().slice(0, 13)}`,
          },
        )
        .catch(logAlertDeliveryFailure);
    }
    await deps.reapCodexOrphans();
  } catch (error) {
    console.error(
      `Hive resource sweep failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
