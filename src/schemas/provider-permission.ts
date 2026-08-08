import { z } from "zod";

export const ProviderPermissionDecisionSchema = z.strictObject({
  approvalId: z.string().min(1),
  requestId: z.string().min(1),
  outcome: z.enum(["allow", "deny"]),
});
export type ProviderPermissionDecision = z.infer<
  typeof ProviderPermissionDecisionSchema
>;

export const ProviderPermissionDecisionsSchema = z.strictObject({
  decisions: z.array(ProviderPermissionDecisionSchema),
});

export const ProviderPermissionSettlementOutcomeSchema = z.enum([
  ...ProviderPermissionDecisionSchema.shape.outcome.options,
  "answered",
  "cancelled",
]);
export type ProviderPermissionSettlementOutcome = z.infer<
  typeof ProviderPermissionSettlementOutcomeSchema
>;

export const ProviderPermissionSettlementSchema = z.strictObject({
  requestId: z.string().min(1),
  outcome: ProviderPermissionSettlementOutcomeSchema,
});
