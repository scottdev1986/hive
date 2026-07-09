import { z } from "zod";

const HookEventBaseSchema = z.object({
  agentName: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});

export const HookEventSchema = z.discriminatedUnion("kind", [
  HookEventBaseSchema.extend({ kind: z.literal("session-start") }),
  HookEventBaseSchema.extend({ kind: z.literal("turn-start") }),
  HookEventBaseSchema.extend({
    kind: z.literal("turn-end"),
    contextPct: z.number().min(0).max(100).optional(),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("notification") }),
  HookEventBaseSchema.extend({
    kind: z.literal("approval-request"),
    description: z.string().min(1),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("dead") }),
]);

export type HookEvent = z.infer<typeof HookEventSchema>;
