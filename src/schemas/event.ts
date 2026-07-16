import { z } from "zod";

const HookEventBaseSchema = z.strictObject({
  agentName: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  // Claude pipes session_id to every hook; Codex notify carries thread-id.
  // Either one is the handle a crash recovery needs for a native resume.
  toolSessionId: z.string().min(1).optional(),
});

export const HookEventSchema = z.discriminatedUnion("kind", [
  // Emitted by Hive's supervisor immediately before it launches a root
  // generation. This is process lifecycle evidence, not a provider claim that
  // its UI is ready, so status maps it to `spawning`, never `idle`.
  HookEventBaseSchema.extend({ kind: z.literal("session-launch") }),
  HookEventBaseSchema.extend({ kind: z.literal("session-start") }),
  // Emitted by the Workspace orchestrator supervisor after its final provider
  // process exits. Provider TUIs do not all deliver a terminal callback to the
  // native Workspace, so liveness belongs in the same structured event stream
  // as turn state rather than in terminal scraping.
  HookEventBaseSchema.extend({ kind: z.literal("session-end") }),
  HookEventBaseSchema.extend({ kind: z.literal("turn-start") }),
  HookEventBaseSchema.extend({
    kind: z.literal("turn-end"),
    // Populated by exactly one producer: the Codex app-server driver
    // (adapters/tools/codex-app-server.ts), which measures it from
    // `thread/tokenUsage/updated` and constructs this event directly, never
    // through the `hive event` CLI. No hook command Hive writes for any
    // vendor can supply this field — Claude's Stop payload and Codex's notify
    // payload both carry no usage data — so the CLI never parses or forwards
    // it (cli.ts, cli/event.ts). Claude's contextPct lands on the agent row
    // via POST /statusline and the telemetry sweep's transcript measurement
    // (tool-telemetry.ts); it is never carried on an event.
    contextPct: z.number().min(0).max(100).optional(),
    usageUnits: z.number().nonnegative().optional(),
    usageSource: z.enum(["provider", "gateway", "estimated"]).optional(),
  }),
  HookEventBaseSchema.extend({
    kind: z.literal("notification"),
    /** Claude's `notification_type`. The vendor's own discriminator for WHY it
     * is speaking, and the only reliable way to tell a session BLOCKED on a
     * native permission dialog from one merely sitting idle — both arrive as
     * this same hook. Measured against claude 2.1.207:
     *
     *   permission_prompt  "Claude needs your permission"        <- blocked
     *   idle_prompt        "Claude is waiting for your input"    <- idle
     *
     * Deliberately a free string, not an enum: an unrecognized type must be
     * ignored, never rejected. Parsing the event strictly would drop the whole
     * hook the first time the vendor adds a type, and a dropped event reads as
     * "nothing happened". Absent means the producer sent no type — not that the
     * agent is unblocked. */
    notificationType: z.string().min(1).optional(),
  }),
  HookEventBaseSchema.extend({
    kind: z.literal("effort-drift"),
    description: z.string().min(1),
  }),
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
