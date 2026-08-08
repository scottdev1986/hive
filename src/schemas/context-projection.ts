import { z } from "zod";

/** One message a durable artifact was built from, body included. The body is embedded rather than pointed at. A reference that had to be resolved later would outlive the message it names — mail is settled and deleted once it is handled — leaving a handoff that cites requirements nothing can retrieve. */
export const ExactContentRefSchema = z
  .strictObject({
    kind: z.literal("message"),
    id: z.string().min(1),
    content: z.string(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .readonly();

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
