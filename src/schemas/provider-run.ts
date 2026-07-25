import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";
import { SessionLocatorSchema } from "./session-protocol";

export const ProviderRunBindingSchema = z
  .strictObject({
    runId: z.string().uuid(),
    agentId: z.string().min(1).nullable(),
    terminal: SessionLocatorSchema,
    provider: CapabilityProviderSchema,
    model: z.string().min(1).nullable(),
    effort: z.string().min(1).nullable(),
    conversationId: z.string().min(1).nullable(),
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
    foregroundProcessGroupId: z.number().int().positive(),
    capabilityEpoch: z.number().int().nonnegative(),
    launchGrantId: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .readonly();

export type ProviderRunBinding = z.infer<typeof ProviderRunBindingSchema>;

export const ProviderRunSchema = z
  .strictObject({
    ...ProviderRunBindingSchema.unwrap().shape,
    state: z.enum(["running", "exited"]),
    exitReason: z.string().min(1).nullable(),
  })
  .readonly()
  .superRefine((run, context) => {
    if (run.state === "running" && run.endedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "a running provider run cannot have endedAt",
        path: ["endedAt"],
      });
    }
    if (run.state === "exited" && run.endedAt === null) {
      context.addIssue({
        code: "custom",
        message: "an exited provider run requires endedAt",
        path: ["endedAt"],
      });
    }
  });

export type ProviderRun = z.infer<typeof ProviderRunSchema>;
