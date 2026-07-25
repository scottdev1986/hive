import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";
import { RoutingCategorySchema } from "./routing-policy";

export const RunOutcomeSchema = z
  .strictObject({
    decisionId: z.string().min(1),
    providerRunId: z.string().uuid(),
    provider: CapabilityProviderSchema,
    model: z.string().min(1),
    taskCategory: RoutingCategorySchema,
    outcome: z.enum([
      "completed",
      "quota-drained",
      "capability-escalated",
      "launch-failed",
      "crashed",
      "stopped",
    ]),
    handoffId: z.string().uuid().nullable(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
