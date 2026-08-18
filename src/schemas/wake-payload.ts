import { z } from "zod";
import { MailLaneSchema } from "./mail";
import {
  MemoryRecallRowSchema,
  MemoryRecallSemanticSchema,
} from "./memory-projections";

/** Wake payload the daemon builds when a wake is ready to submit. Carries mail counts by lane, the wake correlation ids, and recent wiki slice clamped to wake_budget_tokens. Never carries message bodies - the mailbox remains the only channel for those. */

export const WakePayloadSchema = z.strictObject({
  wakeId: z.string().min(1),
  oldestItemId: z.string().min(1),
  lane: MailLaneSchema,
  mailCounts: z.strictObject({
    controlAvailable: z.number().int().min(0),
    workAvailable: z.number().int().min(0),
  }),
  memoryDelta: z.strictObject({
    state: z.enum(["ok", "empty", "absent"]),
    semantic: MemoryRecallSemanticSchema,
    pitfalls: z.array(MemoryRecallRowSchema),
    articles: z.array(MemoryRecallRowSchema),
    tokens: z.number().int().min(0),
    budget: z.number().int().min(0),
    truncated: z.boolean(),
    omitted: z.number().int().min(0),
    omittedPitfalls: z.number().int().min(0),
    omittedArticles: z.number().int().min(0),
  }),
});
export type WakePayload = z.infer<typeof WakePayloadSchema>;

export const WakePayloadRequestSchema = z.strictObject({
  recipient: z.string().min(1),
  wakeId: z.string().min(1),
  oldestItemId: z.string().min(1),
  lane: MailLaneSchema,
});
export type WakePayloadRequest = z.infer<typeof WakePayloadRequestSchema>;
