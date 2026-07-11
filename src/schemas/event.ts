import { z } from "zod";

const HookEventBaseSchema = z.object({
  agentName: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  // Claude pipes session_id to every hook; Codex notify carries thread-id.
  // Either one is the handle a crash recovery needs for a native resume.
  toolSessionId: z.string().min(1).optional(),
});

export const HookEventSchema = z.discriminatedUnion("kind", [
  HookEventBaseSchema.extend({ kind: z.literal("session-start") }),
  HookEventBaseSchema.extend({ kind: z.literal("turn-start") }),
  HookEventBaseSchema.extend({
    kind: z.literal("turn-end"),
    // Populated by exactly one producer: the Codex app-server driver
    // (adapters/tools/codex-app-server.ts), which measures it from
    // `thread/tokenUsage/updated` and constructs this event directly, never
    // through the `hive event` CLI. No hook command Hive writes for any
    // vendor can supply this field — Claude's Stop payload and Codex's notify
    // payload both carry no usage data — so the CLI never parses or forwards
    // it (cli.ts, cli/event.ts). Claude's contextPct comes solely from
    // POST /statusline onto the agent row (decision 2); it is never carried
    // on an event.
    contextPct: z.number().min(0).max(100).optional(),
    usageUnits: z.number().nonnegative().optional(),
    usageSource: z.enum(["provider", "gateway", "estimated"]).optional(),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("notification") }),
  // A completed tool call inside a running turn (Claude's PostToolUse). This
  // is the "nearest safe lifecycle boundary" SPEC decision 1 gives urgent
  // messages: the agent is provably between tool calls, so an injected paste
  // lands in the composer as a queued steer instead of interrupting anything.
  // It is a delivery tick, not a lifecycle fact — it never changes status and
  // is not persisted to the events table.
  HookEventBaseSchema.extend({ kind: z.literal("tool-boundary") }),
  HookEventBaseSchema.extend({
    kind: z.literal("approval-request"),
    description: z.string().min(1),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("dead") }),
]);

export type HookEvent = z.infer<typeof HookEventSchema>;
