import { z } from "zod";
import {
  SessionInspectionSchema,
  SessionLocatorSchema,
  SessionSpecSchema,
  TerminationRequestSchema,
  VisibilityLeaseSchema,
  VisibilityRequestSchema,
} from "../../schemas/session-protocol";

export const HiveTerminalCreateEvidenceSchema = z.strictObject({
  expectedExecutable: SessionSpecSchema.unwrap().shape.expectedExecutable,
  executableVerified: SessionInspectionSchema.unwrap().shape.executableVerified,
  verifiedProviderRoot: SessionInspectionSchema.unwrap().shape.providerRoot,
  geometry: SessionSpecSchema.unwrap().shape.geometry,
  visibility: SessionInspectionSchema.unwrap().shape.visibility,
}).readonly();

export type HiveTerminalCreateEvidence = z.infer<
  typeof HiveTerminalCreateEvidenceSchema
>;

export const HiveTerminalTerminationAuditSchema = z.strictObject({
  reason: TerminationRequestSchema.unwrap().shape.reason,
  requestId: TerminationRequestSchema.unwrap().shape.requestId,
  requestedAt: SessionInspectionSchema.unwrap().shape.evidenceAt,
  /** Who ended the session. Absent means `operator`, so every row written
   * before this field existed — and every operator writer — keeps its exact
   * meaning. Recovery treats an operator audit as a deliberate kill and stops
   * resuming the agent; `visibility-expiry` is infrastructure protecting an
   * invariant, not operator intent, so it records the cause without
   * suppressing recovery. */
  origin: z.enum(["operator", "visibility-expiry"]).optional(),
}).readonly();

export type HiveTerminalTerminationAudit = z.infer<
  typeof HiveTerminalTerminationAuditSchema
>;

/** Hive-owned policy bound to one exact sessiond locator. */
export const HiveTerminalBindingSchema = z.strictObject({
  locator: SessionLocatorSchema.unwrap().extend({ hostKind: z.literal("sessiond") }).readonly(),
  visibility: VisibilityRequestSchema,
  createEvidence: HiveTerminalCreateEvidenceSchema.optional(),
  terminationAudit: HiveTerminalTerminationAuditSchema.optional(),
}).readonly();

export type HiveTerminalBinding = z.infer<typeof HiveTerminalBindingSchema>;

export interface TerminalHostBindingStore {
  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding;
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
  getTerminalHostBindingByLocator(locator: HiveTerminalBinding["locator"]): HiveTerminalBinding | null;
  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[];
}

export class TerminalHostBindingConflictError extends Error {
  constructor() {
    super("terminal host identity is already bound to different Hive policy");
    this.name = "TerminalHostBindingConflictError";
  }
}
