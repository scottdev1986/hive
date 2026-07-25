import { z } from "zod";

export const ExactContentRefSchema = z
  .strictObject({
    kind: z.literal("message"),
    id: z.string().min(1),
    retrieval: z
      .strictObject({
        tool: z.literal("hive_read_message"),
        arguments: z.strictObject({ id: z.string().min(1) }).readonly(),
      })
      .readonly(),
  })
  .readonly();

export type ExactContentRef = z.infer<typeof ExactContentRefSchema>;

export const ContextProjectionSchema = z
  .strictObject({
    projectionId: z.string().uuid(),
    providerRunId: z.string().uuid(),
    purpose: z.enum(["bootstrap", "message-batch", "control", "handoff"]),
    body: z.string(),
    sourceRefs: z.array(ExactContentRefSchema),
    sourceDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    omitted: z
      .strictObject({
        sources: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .readonly(),
    complete: z.boolean(),
  })
  .readonly();

export type ContextProjection = z.infer<typeof ContextProjectionSchema>;
