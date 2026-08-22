import { z } from "zod";
import {
  CreatedAtSchema,
  domainUuidV7Schema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
} from "./hierarchy-ids";
import {
  AgentBindingRefSchema,
  GrantIdSchema,
  NodeIdSchema,
} from "./hierarchy-node";

export const TransferIdSchema = domainUuidV7Schema("transfer");

// How the store evidenced the loss. One reason today: every binding recorded on the lost node is unbound, so no live generation still holds the node.
export const OWNER_LOSS_REASONS = ["owner-bindings-unbound"] as const;
export const OwnerLossReasonSchema = z.enum(OWNER_LOSS_REASONS);

/** What a caller may ask for. Deliberately narrower than the stored record: anything that would let the caller narrate the death (a reason, evidence prose, a loss timestamp) is absent here, so supplying one fails strict parsing instead of being stored as fact. */
export const OwnershipTransferInputSchema = z.strictObject({
  transferId: TransferIdSchema,
  runId: RunIdSchema,
  lostOwnerNodeId: NodeIdSchema,
  successorNodeId: NodeIdSchema,
  /** The live grant the successor already holds. Crew grants the lost owner issued are re-issued underneath it, so the full grant validator stack — attenuation, lead standing, real-tree containment, budget fence — decides whether each re-issue is legal, inside the transfer's own transaction. */
  successorGrantId: GrantIdSchema,
  createdAt: CreatedAtSchema,
});
export type OwnershipTransferInput = z.infer<
  typeof OwnershipTransferInputSchema
>;

/** The stored fact. Fence fields stamp the exact counters the transfer committed under: hierarchyRevision is the value the transfer advanced to, and each binding's epoch is the one its fence check matched. */
export const OwnershipTransferSchema = z.strictObject({
  ...OwnershipTransferInputSchema.shape,
  reason: OwnerLossReasonSchema,
  hierarchyRevision: RevisionSchema,
  runEpoch: SafeUintSchema,
  actingBinding: AgentBindingRefSchema,
  actingCapabilityEpoch: SafeUintSchema,
  successorBinding: AgentBindingRefSchema,
  successorCapabilityEpoch: SafeUintSchema,
});
export type OwnershipTransfer = z.infer<typeof OwnershipTransferSchema>;
