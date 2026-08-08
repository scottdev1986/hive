// The one spawn policy, enforced behind the spawner so every door inherits it. Before this wrapper existed, the MCP spawn door applied succession admission, the memory-pressure refusal, and the machine-mutation lease — and the quota-drain replacement door applied none of them. The shutdown latch belongs here too because it must stop every launch door. A policy that lives at each call site is a policy one caller eventually forgets, so the gates wrap the spawner itself: any caller handed a GatedSpawner cannot launch without passing them.
import { ORCHESTRATOR_NAME } from "../../schemas/agent";
import type { AgentRecord } from "../../schemas/agent";
import type { MachineMutationCoordinator } from "../mutation-lease";
import type { Spawner, SpawnRequest } from "./spawn-service";
import type { AdmissionDecision } from "../queen-provider-service/succession";

export interface SpawnGateDependencies {
  readonly isStopping: () => boolean;
  readonly admitRootWork: () => AdmissionDecision;
  readonly memoryPressure: () => boolean;
  readonly machineMutations: Pick<
    MachineMutationCoordinator,
    "beginOperation"
  > | null;
}

export class GatedSpawner implements Spawner {
  constructor(
    private readonly inner: Spawner,
    private readonly gates: SpawnGateDependencies,
  ) {}

  /** Every spawn door: all four gates. `subject` is the authenticated MCP subject; succession admission binds the root alone. */
  async spawn(request: SpawnRequest, subject?: string): Promise<AgentRecord> {
    return this.gatedSpawn(request, subject, { refuseUnderPressure: true });
  }

  /** The quota-drain replacement door, with its one deliberate exemption. Exempt from the memory-pressure refusal ONLY: the drained agent's handoff is already durable, and refusing under pressure would strand work the daemon admitted and can no longer run — the pressure refusal exists to keep NEW work out, and this spawn admits nothing new. The shutdown latch still refuses it, succession admission still applies by subject (a worker replacement never names the root), and the machine-mutation lease is still taken, because the replacement launches real processes and worktrees like any other spawn. */
  async spawnDrainReplacement(request: SpawnRequest): Promise<AgentRecord> {
    return this.gatedSpawn(request, undefined, {
      refuseUnderPressure: false,
    });
  }

  private async gatedSpawn(
    request: SpawnRequest,
    subject: string | undefined,
    policy: { refuseUnderPressure: boolean },
  ): Promise<AgentRecord> {
    if (this.gates.isStopping()) {
      throw new Error("Hive is shutting down and refusing new work admission");
    }
    if (subject === ORCHESTRATOR_NAME) {
      if (request.taskId === undefined) {
        throw new Error(
          "Queen dispatch requires a board task. Fix: create the story with " +
            "hive_task_create, then retry hive_spawn with its taskId.",
        );
      }
      const admission = this.gates.admitRootWork();
      if (!admission.admit) {
        throw new Error(admission.reason);
      }
    }
    if (policy.refuseUnderPressure && this.gates.memoryPressure()) {
      throw new Error(
        "Hive is refusing to spawn new agents while the system is under " +
          "memory pressure; retry once the resource watchdog reports the " +
          "pressure has cleared. Fix: hive_quota_status; reduce the concurrent " +
          "fleet; or wait for the resource watchdog to clear, then retry.",
      );
    }
    const operation =
      await this.gates.machineMutations?.beginOperation("spawn");
    try {
      return await this.inner.spawn(request);
    } finally {
      operation?.release();
    }
  }
}
