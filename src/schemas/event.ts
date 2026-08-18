import { z } from "zod";
import { Sha256HexSchema } from "./primitives";

const HookEventBaseSchema = z.strictObject({
  agentName: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  providerRunId: z.string().uuid().optional(),
  toolSessionId: z.string().min(1).optional(),
});

export const HookEventSchema = z.discriminatedUnion("kind", [
  // Emitted by Hive's supervisor immediately before it launches a root generation. This is process lifecycle evidence, not a provider claim that its UI is ready, so status maps it to `spawning`, never `idle`.
  HookEventBaseSchema.extend({ kind: z.literal("session-launch") }),
  HookEventBaseSchema.extend({ kind: z.literal("session-start") }),
  // Emitted by the Workspace orchestrator supervisor after its final provider process exits. Provider TUIs do not all deliver a terminal callback to the native Workspace, so liveness belongs in the same structured event stream as turn state rather than in terminal scraping.
  HookEventBaseSchema.extend({ kind: z.literal("session-end") }),
  HookEventBaseSchema.extend({ kind: z.literal("turn-start") }),
  HookEventBaseSchema.extend({ kind: z.literal("turn-failure") }),
  HookEventBaseSchema.extend({
    kind: z.literal("turn-end"),
    contextPct: z.number().min(0).max(100).optional(),
    usageUnits: z.number().nonnegative().optional(),
    usageSource: z.enum(["provider", "gateway", "estimated"]).optional(),
  }),
  HookEventBaseSchema.extend({
    kind: z.literal("notification"),
    /** Claude's `notification_type`. The vendor's own discriminator for WHY it is speaking, and the only reliable way to tell a session BLOCKED on a native permission dialog from one merely sitting idle — both arrive as this same hook. Measured against claude 2.1.207: permission_prompt "Claude needs your permission" <- blocked idle_prompt "Claude is waiting for your input" <- idle Deliberately a free string, not an enum: an unrecognized type must be ignored, never rejected. Parsing the event strictly would drop the whole hook the first time the vendor adds a type, and a dropped event reads as "nothing happened". Absent means the producer sent no type — not that the agent is unblocked. */
    notificationType: z.string().min(1).optional(),
  }),
  HookEventBaseSchema.extend({
    kind: z.literal("effort-drift"),
    description: z.string().min(1),
  }),
  // A completed tool call inside a running turn (Claude's PostToolUse). The agent is provably between tool calls, so an injected paste lands in the composer as a queued steer instead of interrupting anything. It is a delivery tick, not a lifecycle fact — it never changes status and is not persisted to the events table.
  HookEventBaseSchema.extend({
    kind: z.literal("tool-start"),
    toolName: z.string().min(1).optional(),
    inputDigest: Sha256HexSchema.optional(),
  }),
  HookEventBaseSchema.extend({
    kind: z.literal("tool-boundary"),
    toolName: z.string().min(1).optional(),
    inputDigest: Sha256HexSchema.optional(),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("compacted") }),
  HookEventBaseSchema.extend({
    kind: z.literal("approval-request"),
    description: z.string().min(1),
  }),
  HookEventBaseSchema.extend({ kind: z.literal("dead") }),
]);

export type HookEvent = z.infer<typeof HookEventSchema>;
