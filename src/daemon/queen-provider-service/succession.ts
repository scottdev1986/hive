// succession.ts Queen succession: the daemon-owned mechanism behind replacing the root. The supervisor drives the mechanics (terminate, relaunch, ping); this module owns the records that make the exchange provable — RunCheckpoints written at semantic boundaries, and one QueenSuccession per replacement, from declaration to attestation. The flow, bound to measurement at every step: 1. The root exits while agents live. The supervisor measures the live agents (a status snapshot) and DECLARES the backup: `begin` loads and verifies the latest checkpoint and records the proof the successor stands on — the checkpoint's exact (revision, digest) ref, or an explicit no-checkpoint proof. A checkpoint that fails verification is a contradiction, recorded, never silently worked around. 2. The supervisor sends the non-destructive recovery requests and records each measured reply against the open succession. 3. The boot capsule carries the proof to the fresh root: attest this digest, or reconstruct from the manifest journal and the measured replies — never from the agent table alone. 4. The fresh root re-reads status and inbox through her own tools — the daemon records those reads — and then ATTESTS: the exact succession id, generation, and digest. Only that explicit declaration completes the succession. A provider observation never attests, and the root's authority stays gated to the recovery tools until the attestation lands. Nothing here crosses the client control surface. The queen-provider projection reports idle|pending|failed through every phase; these records live behind user-only internal endpoints and the root's own tools.

import { createHash } from "node:crypto";
import type { MailStore } from "../../mail-service/store";
import { isLiveAgent, ORCHESTRATOR_NAME } from "../../schemas/agent";
import { DigestSchema, type RevisionRef } from "../../schemas/hierarchy-ids";
import type { Run } from "../../schemas/hierarchy-run";
import {
  type AgentSnapshotEntry,
  type BeginSuccessionRequest,
  type BeginSuccessionResponse,
  type BootstrapManifestRef,
  type CheckpointEvent,
  type CheckpointHierarchy,
  type CompactReplaceDecision,
  type ContextUsage,
  digestCheckpointContent,
  type HiveRunCheckpointRequest,
  HiveRunCheckpointRequestSchema,
  type QueenSuccession,
  type QueenSuccessionProjection,
  QueenSuccessionProjectionSchema,
  QueenSuccessionSchema,
  type RecoveryRepliesRequest,
  type RunCheckpoint,
  type RunCheckpointInput,
  type SuccessionAttestRequest,
  type SuccessionProof,
  type SuccessionReason,
} from "../../schemas/run-checkpoint";
import { workManifestRef } from "../../schemas/work-manifest";
import { systemClock } from "../../shared/clock";
import type { DatabaseHost } from "../../shared/database-host";
import type { Capability } from "../authorization/authorization-service";
import type { AgentStore } from "../database/agent-store";
import type { RuntimeStore } from "../database/runtime-store";
import { HierarchyStore } from "../hierarchy-store";
import type { ManifestJournal } from "../manifest-journal";
import {
  type CheckpointRead,
  SuccessionStateError,
  SuccessionStore,
} from "../succession-store";
import {
  type QueenBootCapsuleInput,
  queenBootCapsules,
} from "./queen-boot-capsule-service";
import {
  SUCCESSION_REQUIRED_READS,
  successionRequiredReadInstruction,
} from "./succession-recovery";

export {
  type CheckpointLoad,
  type CheckpointRead,
  SuccessionStateError,
  SuccessionStore,
} from "../succession-store";

interface SuccessionDatabase extends DatabaseHost {
  getAgentById: AgentStore["getAgentById"];
  listAgents: AgentStore["listAgents"];
  listTerminalHostBindings: RuntimeStore["listTerminalHostBindings"];
}

export function checkpointRequestKind(
  event: CheckpointEvent,
): "requested" | "required" {
  return event === "repeated-failure" ||
    event === "provider-compaction" ||
    event === "unknown-context"
    ? "required"
    : "requested";
}

export type AdmissionDecision =
  { admit: true } | { admit: false; reason: string };

/** New work is admitted only when the resident context, the estimated cost of the remaining control work, and the handoff reserve together fit under the per-model absolute ceiling. Unknown usage is not free: it refuses until the usage is measured or the state is checkpointed — a verified checkpoint is what makes a forced handoff survivable. Absent usage data cannot reach here: the ContextUsage schema makes "unknown" explicit at the door, and the input carries the ceiling numbers only when there is a measurement to check them against. */
export type UnknownAdmissionInput = {
  checkpointed: boolean;
  usage: Extract<ContextUsage, { kind: "unknown" }>;
};
export type MeasuredAdmissionInput = {
  checkpointed: boolean;
  usage: Extract<ContextUsage, { kind: "measured" }>;
  remainingControlWorkTokens: number;
  handoffReserveTokens: number;
  absoluteResidentTokenCeiling: number;
};
export type AdmissionInput = UnknownAdmissionInput | MeasuredAdmissionInput;

function isMeasured(input: AdmissionInput): input is MeasuredAdmissionInput {
  return input.usage.kind === "measured";
}

export function admitWork(input: AdmissionInput): AdmissionDecision {
  if (!isMeasured(input)) {
    if (input.checkpointed) return { admit: true };
    return {
      admit: false,
      reason:
        `resident context usage is unknown (${input.usage.reason}); ` +
        "unknown usage blocks new admission until it is measured or the run " +
        "state is checkpointed. Fix: hive_run_checkpoint at a semantic " +
        "boundary, then retry",
    };
  }
  const required =
    input.usage.residentTokens +
    input.remainingControlWorkTokens +
    input.handoffReserveTokens;
  if (required > input.absoluteResidentTokenCeiling) {
    return {
      admit: false,
      reason:
        `resident ${input.usage.residentTokens} + remaining control work ` +
        `${input.remainingControlWorkTokens} + handoff reserve ` +
        `${input.handoffReserveTokens} = ${required} exceeds the absolute ` +
        `ceiling ${input.absoluteResidentTokenCeiling}. Fix: ` +
        "hive_run_checkpoint at a semantic boundary, then retry",
    };
  }
  return { admit: true };
}

/** A healthy warm root compacts in place. Replacement is reserved for the contexts compaction cannot fix: repeated same-subgoal failure (poisoned), a cold root, the absolute ceiling, and crash/provider/user events. */
export function decideCompactOrReplace(input: {
  warm: boolean;
  repeatedSameSubgoalFailure: boolean;
  ceilingReached: boolean;
  externalEvent: "crash" | "provider" | "user" | null;
}): CompactReplaceDecision {
  if (input.repeatedSameSubgoalFailure) {
    return {
      decision: "replace",
      reason: "repeated same-subgoal failure poisoned the context",
    };
  }
  if (!input.warm) {
    return {
      decision: "replace",
      reason: "the root is cold; there is no warm context to compact",
    };
  }
  if (input.ceilingReached) {
    return {
      decision: "replace",
      reason: "the absolute resident-token ceiling was reached",
    };
  }
  if (input.externalEvent !== null) {
    return {
      decision: "replace",
      reason: `a ${input.externalEvent} event forces a fresh root`,
    };
  }
  return {
    decision: "compact",
    reason: "healthy warm root; compact in place when the provider supports it",
  };
}

/** The staleness check: a checkpoint that verifies byte-for-byte can still disagree with what is measured now. Every disagreement is named — agents the checkpoint knows that no longer answer, agents answering that the checkpoint never saw, branches that moved. None of them are resolved here; they go on the record so the fresh root knows which parts of the checkpoint no longer hold. */
export function snapshotDiscrepancies(
  checkpoint: RunCheckpoint,
  measured: readonly {
    agentName: string;
    branch: string | null;
  }[],
): string[] {
  const discrepancies: string[] = [];
  const recorded = new Map(
    checkpoint.agentSnapshot.map((entry) => [entry.agentName, entry]),
  );
  const live = new Map(measured.map((entry) => [entry.agentName, entry]));
  for (const [name, entry] of recorded) {
    const current = live.get(name);
    if (current === undefined) {
      discrepancies.push(
        `checkpoint names agent ${name} (${entry.status}) but no live agent answers to that name`,
      );
    } else if (current.branch !== entry.branch) {
      discrepancies.push(
        `agent ${name} moved branch: checkpoint recorded ${entry.branch ?? "none"}, measured ${current.branch ?? "none"}`,
      );
    }
  }
  for (const name of live.keys()) {
    if (!recorded.has(name)) {
      discrepancies.push(`live agent ${name} is absent from the checkpoint`);
    }
  }
  return discrepancies;
}

/** The tools the fresh root may use while her succession awaits attestation: re-read, answer recovery traffic, and attest. Everything else is gated — her authority resumes at the attestation, not at the process launch. */
export const SUCCESSION_RECOVERY_TOOLS: ReadonlySet<string> = new Set([
  ...SUCCESSION_REQUIRED_READS.map(({ tool }) => tool),
  "hive_mail_claim",
  "hive_mail_complete",
  "hive_mail_status",
  "hive_mail_publish",
  "hive_succession_attest",
]);

export interface SuccessionServiceOptions {
  db: SuccessionDatabase;
  mail: MailStore;
  journal: ManifestJournal;
  instanceId: string;
  reasonSource?: () => SuccessionReason;
  now?: () => Date;
}

export class SuccessionService {
  private readonly store: SuccessionStore;
  private readonly journal: ManifestJournal;
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly reasonSource: () => SuccessionReason;
  private readonly hierarchy: HierarchyStore;
  private readonly db: SuccessionDatabase;
  private readonly mail: MailStore;

  constructor(options: SuccessionServiceOptions) {
    this.store = new SuccessionStore(options.db);
    this.journal = options.journal;
    this.instanceId = options.instanceId;
    this.now = options.now ?? systemClock;
    this.reasonSource =
      options.reasonSource ?? (() => "root-exit-with-live-agents");
    this.hierarchy = new HierarchyStore(options.db);
    this.db = options.db;
    this.mail = options.mail;
  }

  writeCheckpoint(input: RunCheckpointInput): RunCheckpoint {
    return this.store.writeCheckpoint(input, this.now().toISOString());
  }

  readCheckpoint(revision?: string): CheckpointRead {
    return this.store.readCheckpoint(this.instanceId, revision);
  }

  /** The hierarchy state a checkpoint binds from the live records: the run's spine plus the task, decision, and stage refs that exist RIGHT NOW — each ref naming its record by identity, revision, and a digest over the WHOLE record, so a drifted outcome is as visible as a drifted intent. Where the store holds none of a kind, the array is empty — that is measured-empty, never unfilled. Ownership transfers stay out by design: they are their own record family, re-read from the store, not checkpoint content. */
  private hierarchyRefs(run: Run): {
    hierarchy: CheckpointHierarchy;
    artifacts: string[];
  } {
    const tasks = this.hierarchy.listTasks(run.runId);
    const decisions = this.hierarchy.listRunControlDecisions(run.runId);
    return {
      hierarchy: {
        runId: run.runId,
        spec: run.spec,
        plan: run.currentPlan,
        topology: run.topology,
        phase: run.phase,
        budget: run.budget,
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          revision: task.revision,
          digest: digestCheckpointContent(task),
        })),
        decisions: decisions.map((decision) => ({
          idempotencyKey: decision.idempotencyKey,
          revision: decision.result.observedPostState.revision,
          digest: digestCheckpointContent(decision),
        })),
        promotionQueue: this.hierarchy
          .listIntegrationStages(run.runId)
          .map((stage) => ({
            stageId: stage.stageId,
            revision: stage.revision,
            digest: digestCheckpointContent(stage),
          })),
      },
      artifacts: [
        ...new Set(
          tasks.flatMap((task) => [...task.artifactRefs, ...task.evidence]),
        ),
      ],
    };
  }

  private activeRun(): Run | null {
    const activeRuns = this.hierarchy
      .listRuns()
      .filter((run) => run.lifecycle === "active");
    return activeRuns.length === 1 ? (activeRuns[0] as Run) : null;
  }

  writeBoundaryCheckpoint(
    event: CheckpointEvent,
    run: Run | null = this.activeRun(),
  ): RunCheckpoint {
    const refs = run === null ? null : this.hierarchyRefs(run);
    const checkpoint = this.writeCheckpoint({
      instanceId: this.instanceId,
      reason: event,
      hierarchy: refs?.hierarchy ?? null,
      pendingMessages: this.pendingRootMessageRefs(),
      artifacts: refs?.artifacts ?? [],
      unresolvedQuestions: [],
      contextUsage: {
        kind: "unknown",
        reason: "the daemon has no root context measurement",
      },
      model: null,
      decision: decideCompactOrReplace({
        warm: true,
        repeatedSameSubgoalFailure: false,
        ceilingReached: false,
        externalEvent: null,
      }),
      agentSnapshot: this.agentSnapshot(),
      replies: [],
      written: null,
    });
    const verified = this.readCheckpoint(checkpoint.revision);
    if (verified.state !== "present") {
      const detail =
        verified.state === "digest-mismatch"
          ? verified.detail
          : `checkpoint revision ${checkpoint.revision} is absent`;
      throw new Error(`checkpoint digest verification failed: ${detail}`);
    }
    if (verified.checkpoint.digest !== checkpoint.digest) {
      throw new Error(
        `checkpoint digest verification returned ${verified.checkpoint.digest}, expected ${checkpoint.digest}`,
      );
    }
    return verified.checkpoint;
  }

  writeRootCheckpoint(request: HiveRunCheckpointRequest): RunCheckpoint {
    const parsed = HiveRunCheckpointRequestSchema.parse(request);
    const run = this.activeRun();
    const refs = run === null ? null : this.hierarchyRefs(run);
    return this.writeCheckpoint({
      instanceId: this.instanceId,
      reason: parsed.reason,
      hierarchy: refs?.hierarchy ?? null,
      pendingMessages: this.pendingRootMessageRefs(),
      artifacts: refs?.artifacts ?? [],
      unresolvedQuestions: parsed.unresolvedQuestions,
      contextUsage: parsed.contextUsage,
      model: parsed.model,
      decision: parsed.decision,
      agentSnapshot: this.agentSnapshot(),
      replies: [],
      written: parsed.written,
    });
  }

  /** The durable root session generation for this instance: the highest terminal_host_bindings generation whose subject is root. Zero when no root has ever bound — that is measured-empty, not a default claim. Succession prior is this value, not a process-local counter the supervisor invents. Attestation then checks against a number that can disagree with a lying client. */
  durableRootGeneration(): number {
    return this.db
      .listTerminalHostBindings(this.instanceId)
      .reduce(
        (highest, binding) =>
          binding.locator.subject.kind === "root"
            ? Math.max(highest, binding.locator.generation)
            : highest,
        0,
      );
  }

  prepareLaunch(
    input: Omit<
      QueenBootCapsuleInput,
      | "instanceId"
      | "successionId"
      | "targetGeneration"
      | "priorSuccessionId"
      | "proof"
      | "checkpoint"
      | "discrepancies"
      | "bootstrap"
      | "contradictions"
    >,
  ): {
    succession: QueenSuccession;
    targetGeneration: number;
    bootCapsule: string;
    bootCapsuleDigest: string;
    bootstrap: BootstrapManifestRef[];
    snapshot: AgentSnapshotEntry[];
  } {
    return this.store.transaction(() => {
      const existing = this.store.successionForRequest(
        this.instanceId,
        input.requestId,
      );
      if (existing !== null) {
        const rebuilt = queenBootCapsules.create({
          ...input,
          instanceId: this.instanceId,
          successionId: existing.successionId,
          targetGeneration: existing.priorRootGeneration + 1,
          priorSuccessionId: this.store.priorSuccessionId(
            this.instanceId,
            existing.revision,
          ),
          proof: existing.proof,
          checkpoint:
            existing.proof.kind === "checkpoint" &&
            this.readCheckpoint(existing.proof.ref.revision).state === "present"
              ? (
                  this.readCheckpoint(existing.proof.ref.revision) as Extract<
                    CheckpointRead,
                    { state: "present" }
                  >
                ).checkpoint
              : null,
          discrepancies: existing.discrepancies,
          bootstrap: this.bootstrap(),
          contradictions: this.projection().contradictions,
        });
        if (
          existing.bootCapsuleDigest === undefined ||
          rebuilt.digest !== existing.bootCapsuleDigest
        ) {
          throw new SuccessionStateError(
            `prepared launch ${input.requestId} no longer reproduces its durable boot capsule`,
          );
        }
        return {
          succession: existing,
          targetGeneration: existing.priorRootGeneration + 1,
          bootCapsule: rebuilt.text,
          bootCapsuleDigest: rebuilt.digest,
          bootstrap: this.bootstrap(),
          snapshot: [...existing.snapshot],
        };
      }
      const load = this.store.loadLatestCheckpoint(this.instanceId);
      let proof: SuccessionProof;
      const discrepancies: string[] = [];
      if (load.kind === "absent") {
        proof = {
          kind: "no-checkpoint",
          detail: "no checkpoint has been written for this instance",
        };
      } else if (load.kind === "corrupt") {
        proof = { kind: "no-checkpoint", detail: load.detail };
        discrepancies.push(load.detail);
      } else {
        proof = {
          kind: "checkpoint",
          ref: {
            revision: load.checkpoint.revision,
            digest: load.checkpoint.digest,
          },
        };
        discrepancies.push(
          ...snapshotDiscrepancies(load.checkpoint, input.agents),
        );
      }
      const priorRootGeneration = this.durableRootGeneration();
      const successionId = `qsc_${Bun.randomUUIDv7()}`;
      const prior = this.store.latestSuccession(this.instanceId);
      const bootstrap = this.bootstrap();
      const capsule = queenBootCapsules.create({
        ...input,
        instanceId: this.instanceId,
        successionId,
        targetGeneration: priorRootGeneration + 1,
        priorSuccessionId: prior?.successionId ?? null,
        proof,
        checkpoint: load.kind === "valid" ? load.checkpoint : null,
        discrepancies,
        bootstrap,
        contradictions: this.projection().contradictions,
      });
      const succession = this.store.appendSuccession({
        successionId,
        instanceId: this.instanceId,
        createdAt: this.now().toISOString(),
        reason: input.reason,
        reasonDetail: input.reasonDetail,
        priorRootGeneration,
        newRootGeneration: null,
        proof,
        snapshot: [...input.agents],
        replies: [],
        discrepancies,
        launchRequestId: input.requestId,
        bootCapsuleDigest: capsule.digest,
        attestation: null,
      });
      return {
        succession,
        targetGeneration: priorRootGeneration + 1,
        bootCapsule: capsule.text,
        bootCapsuleDigest: capsule.digest,
        bootstrap,
        snapshot: [...input.agents],
      };
    });
  }

  begin(request: BeginSuccessionRequest): BeginSuccessionResponse {
    const prepared = this.prepareLaunch({
      requestId: `req_${Bun.randomUUIDv7()}`,
      provider: "claude",
      reason: this.reasonSource(),
      reasonDetail: request.reasonDetail,
      cwd: "/",
      mailbox: {
        counts: {
          controlAvailable: 0,
          controlLeased: 0,
          workAvailable: 0,
          workLeased: 0,
          deadLettered: 0,
        },
        control: [],
        work: [],
      },
      board: {
        schemaVersion: 2,
        instanceId: this.instanceId,
        seq: "0",
        entities: [],
        createdAt: this.now().toISOString(),
        contentSha256: "0".repeat(64),
      },
      agents: request.snapshot,
      replies: [],
    });
    return { succession: prepared.succession, bootstrap: prepared.bootstrap };
  }

  /** Record the measured replies to the recovery requests against the open succession they belong to. The succession must be open: replies for an attested or unknown succession are refused, never silently dropped. */
  recordRecoveryReplies(request: RecoveryRepliesRequest): QueenSuccession {
    const open = this.store
      .listOpenSuccessions(this.instanceId)
      .find((record) => record.successionId === request.successionId);
    if (open === undefined) {
      throw new SuccessionStateError(
        `no open succession ${request.successionId} to record replies on`,
      );
    }
    const updated = QueenSuccessionSchema.parse({
      ...open,
      replies: request.replies,
    });
    this.store.recordReplies(updated);
    return updated;
  }

  /** The successor's own attestation. It validates, in order: the succession is the open one; the generation is the declared backup's; the digest is exactly what the daemon verified (or null against a no-checkpoint proof); and the ATTESTING credential's own re-read of status and inbox was measured — another queen credential's reads, however valid, prove nothing about this successor. Only then does the record complete. A provider observation performs none of this, so a provider observation never attests. */
  attest(
    request: SuccessionAttestRequest,
    attesterId: string,
  ): QueenSuccession {
    const open = this.store.latestSuccession(this.instanceId);
    if (open === null || open.attestation !== null) {
      throw new SuccessionStateError("no succession is open");
    }
    if (open.successionId !== request.successionId) {
      throw new SuccessionStateError(
        `succession ${request.successionId} is not the open succession ${open.successionId}`,
      );
    }
    const expectedGeneration = open.priorRootGeneration + 1;
    if (request.generation !== expectedGeneration) {
      throw new SuccessionStateError(
        `attestation names generation ${request.generation}; the open succession expects ${expectedGeneration}`,
      );
    }
    const expectedDigest =
      open.proof.kind === "checkpoint" ? open.proof.ref.digest : null;
    if (request.checkpointDigest !== expectedDigest) {
      throw new SuccessionStateError(
        expectedDigest === null
          ? "the open succession has a no-checkpoint proof; the attestation must name a null digest"
          : `attestation names digest ${request.checkpointDigest ?? "null"}; the daemon verified ${expectedDigest}`,
      );
    }
    const reads = this.store.readsFor(open.successionId, attesterId);
    const missing = SUCCESSION_REQUIRED_READS.filter(
      ({ proof }) => !reads.has(proof),
    ).map(({ proof }) => proof);
    if (missing.length > 0) {
      throw new SuccessionStateError(
        `the successor's re-read is not measured: missing ${missing.join(" and ")} — re-read ${successionRequiredReadInstruction()} with this same credential before attesting`,
      );
    }
    const completed = QueenSuccessionSchema.parse({
      ...open,
      newRootGeneration: request.generation,
      attestation: {
        checkpointDigest: request.checkpointDigest,
        attestedAt: this.now().toISOString(),
      },
    });
    this.store.completeSuccession(completed);
    return completed;
  }

  /** The root's admission gate at the work-admission path. The daemon has no root context measurement, so today's usage is always unknown — and unknown admits only when a verified checkpoint exists, because the checkpoint is what makes a forced handoff survivable. The refusal names the remedy and its weight: an unmeasured context makes the checkpoint required, not requested. */
  admitNewWork(): AdmissionDecision {
    const load = this.store.loadLatestCheckpoint(this.instanceId);
    const decision = admitWork({
      checkpointed: load.kind === "valid",
      usage: {
        kind: "unknown",
        reason: "the daemon has no root context measurement",
      },
    });
    if (decision.admit) return decision;
    return {
      admit: false,
      reason:
        `${decision.reason}; a RunCheckpoint is ` +
        `${checkpointRequestKind("unknown-context")} here`,
    };
  }

  /** One orchestrator tool call, gated. While a succession is open the root's authority is limited to the recovery tools — re-read, recovery traffic, and the attestation itself — because her authority resumes at the attestation, not at the process launch. The re-read itself is measured here, bound to the exact credential that makes the call: a hive_status or hive_mail_poll call against an open succession is the durable proof THAT successor re-read before attesting, and no other credential's reads count. */
  gateRootToolCall(capability: Capability, tool: string): void {
    const open = this.store.latestSuccession(this.instanceId);
    if (open === null || open.attestation !== null) {
      return;
    }
    const requiredRead = SUCCESSION_REQUIRED_READS.find(
      ({ tool: requiredTool }) => requiredTool === tool,
    );
    if (requiredRead !== undefined) {
      this.store.recordRead(
        open.successionId,
        requiredRead.proof,
        capability.id,
        this.now().toISOString(),
      );
    }
    if (!SUCCESSION_RECOVERY_TOOLS.has(tool)) {
      throw new SuccessionStateError(
        `succession ${open.successionId} awaits attestation: re-read ${successionRequiredReadInstruction()}, then call hive_succession_attest — ${tool} is gated until the attestation lands`,
      );
    }
  }

  /** The no-checkpoint reconstruction source: the manifest journal's latest per-agent captures that still need accounting for, named by exact (revision, digest) ref. The agent table is never consulted here — a row in it is a claim about the present, while the journal is what was measured before anything was destroyed. */
  private bootstrap(): BootstrapManifestRef[] {
    return this.journal.listAttention().map((entry) => ({
      agentId: entry.agentId,
      agentName: entry.manifest.agentName,
      branch: entry.manifest.branch,
      classification: entry.manifest.classification,
      workManifest: workManifestRef(entry),
    }));
  }

  private agentSnapshot() {
    return this.db
      .listAgents()
      .filter(isLiveAgent)
      .map((agent) => ({
        agentName: agent.name,
        status: agent.status,
        branch: agent.branch,
        worktreePath: agent.worktreePath,
        lastEventAt: agent.lastEventAt,
      }));
  }

  /** The root's unacknowledged messages, by id and content digest — never bodies. The uuidv7 id is the delivery cursor. */
  private pendingRootMessageRefs() {
    const now = new Date().toISOString();
    return [
      ...this.mail.listAvailable(ORCHESTRATOR_NAME, "control", 0, 100, now),
      ...this.mail.listAvailable(ORCHESTRATOR_NAME, "work", 0, 100, now),
    ]
      .sort((left, right) => left.seq - right.seq)
      .map((item) => ({
        messageId: item.itemId,
        digest: digestMessageBody(item.body),
      }));
  }

  /** The internal read model. Contradictions come from the latest checkpoint load (corruption is visible before any succession runs), from every succession still waiting for attestation, and from the latest completed one — convergence does not erase what was found on the way. */
  projection(now?: Date): QueenSuccessionProjection {
    const load = this.store.loadLatestCheckpoint(this.instanceId);
    const sightings: string[] = [];
    if (load.kind === "corrupt") sightings.push(load.detail);
    const open = this.store.listOpenSuccessions(this.instanceId);
    for (const record of open) sightings.push(...record.discrepancies);
    const latest = this.store.latestSuccession(this.instanceId);
    if (latest !== null && latest.attestation !== null) {
      sightings.push(...latest.discrepancies);
    }
    // One contradiction sighted twice — once on the succession record, once by the current load — is still one contradiction.
    const contradictions = [...new Set(sightings)];
    const latestCheckpoint: RevisionRef | null =
      load.kind === "valid"
        ? {
            revision: load.checkpoint.revision,
            digest: load.checkpoint.digest,
          }
        : null;
    return QueenSuccessionProjectionSchema.parse({
      schemaVersion: 1,
      instanceId: this.instanceId,
      latestCheckpoint,
      succession:
        latest === null
          ? null
          : {
              successionId: latest.successionId,
              revision: latest.revision,
              state: latest.attestation === null ? "recovering" : "attested",
              reason: latest.reason,
              priorRootGeneration: latest.priorRootGeneration,
              newRootGeneration: latest.newRootGeneration,
            },
      contradictions,
      observedAt: (now ?? this.now()).toISOString(),
    });
  }
}

export function digestMessageBody(body: string): string {
  return DigestSchema.parse(
    `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
  );
}
