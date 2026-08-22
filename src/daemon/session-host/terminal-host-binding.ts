import { z } from "zod";
import {
  SessionInspectionSchema,
  SessionLocatorSchema,
  SessionSpecSchema,
  TerminationRequestSchema,
  TerminationResultSchema,
  type VisibilityLeaseSchema,
  VisibilityRequestSchema,
} from "../../schemas/session-protocol";

export const HiveTerminalCreateEvidenceSchema = z
  .strictObject({
    expectedExecutable: SessionSpecSchema.unwrap()["shape"].expectedExecutable,
    executableVerified:
      SessionInspectionSchema.unwrap()["shape"].executableVerified,
    verifiedShellRoot: SessionInspectionSchema.unwrap()["shape"].shellRoot,
    geometry: SessionSpecSchema.unwrap()["shape"].geometry,
    visibility: SessionInspectionSchema.unwrap()["shape"].visibility,
  })
  .readonly();

export type HiveTerminalCreateEvidence = z.infer<
  typeof HiveTerminalCreateEvidenceSchema
>;

export const HiveTerminalTerminationAuditSchema = z
  .strictObject({
    reason: TerminationRequestSchema.unwrap()["shape"].reason,
    requestId: TerminationRequestSchema.unwrap()["shape"].requestId,
    requestedAt: SessionInspectionSchema.unwrap()["shape"].evidenceAt,
    /** Who ended the session. Absent means `user` for compatibility and for every user writer. Recovery treats a user audit as a deliberate kill and stops resuming the agent; `visibility-expiry` is infrastructure protecting an invariant, not user intent, so it records the cause without suppressing recovery. */
    origin: z.enum(["user", "visibility-expiry"]).optional(),
  })
  .readonly();

export type HiveTerminalTerminationAudit = z.infer<
  typeof HiveTerminalTerminationAuditSchema
>;

export const HiveTerminalTerminationEvidenceSchema = z
  .strictObject({
    completedAt: SessionInspectionSchema.unwrap()["shape"].evidenceAt,
    result: TerminationResultSchema,
  })
  .readonly();

export type HiveTerminalTerminationEvidence = z.infer<
  typeof HiveTerminalTerminationEvidenceSchema
>;

/** Hive-owned policy bound to one exact sessiond locator. */
export const HiveTerminalBindingSchema = z
  .strictObject({
    locator: SessionLocatorSchema.unwrap()
      .extend({ hostKind: z.literal("sessiond") })
      .readonly(),
    visibility: VisibilityRequestSchema,
    createEvidence: HiveTerminalCreateEvidenceSchema.optional(),
    terminationAudit: HiveTerminalTerminationAuditSchema.optional(),
    terminationEvidence: HiveTerminalTerminationEvidenceSchema.optional(),
  })
  .readonly();

export type HiveTerminalBinding = z.infer<typeof HiveTerminalBindingSchema>;

export interface TerminalHostBindingStore {
  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding;
  /** Remove only a binding that never acquired create evidence. Used when the host returns a typed pre-launch refusal, so a failed spawn is atomic. */
  releaseUncreatedTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
  ): boolean;
  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    evidence: HiveTerminalCreateEvidence,
  ): HiveTerminalBinding;
  renewTerminalHostVisibility(
    locator: HiveTerminalBinding["locator"],
    request: z.infer<typeof VisibilityRequestSchema>,
    lease: z.infer<typeof VisibilityLeaseSchema>,
  ): HiveTerminalBinding;
  recordTerminalHostTermination(
    locator: HiveTerminalBinding["locator"],
    audit: HiveTerminalTerminationAudit,
  ): HiveTerminalBinding;
  recordTerminalHostTerminationEvidence(
    locator: HiveTerminalBinding["locator"],
    evidence: HiveTerminalTerminationEvidence,
  ): HiveTerminalBinding;
  getTerminalHostBindingByLocator(
    locator: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null;
  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[];
}

export class TerminalHostBindingConflictError extends Error {
  constructor() {
    super("terminal host identity is already bound to different Hive policy");
    this.name = "TerminalHostBindingConflictError";
  }
}
