import { z } from "zod";
import { RoutingTierSchema } from "./routing";

// Reserved recipient name for the root orchestrator. It is not a spawned
// agent and has no row in the agents table; delivery routes it through the
// dedicated root wake bridge instead of ordinary agent liveness checks.
export const ORCHESTRATOR_NAME = "orchestrator";

export const TerminalHandleSchema = z.discriminatedUnion("app", [
  z.object({
    app: z.literal("iterm2"),
    sessionId: z.string().min(1),
  }).strict(),
  z.object({
    app: z.literal("terminal"),
    processId: z.number().int().positive(),
    windowId: z.number().int().positive(),
    tty: z.string().min(1),
  }).strict(),
]);

export type TerminalHandle = z.infer<typeof TerminalHandleSchema>;

// A control restart must be able to reproduce the process that was actually
// launched without reading a routing table or a mutable tool default. Keep
// only immutable launch choices here; daemon ports, paths, permissions, and
// hook configuration remain dynamic and are rebuilt for the read-only run.
export const ExecutionIdentitySchema = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("claude"),
    model: z.string().min(1),
  }),
  z.strictObject({
    tool: z.literal("codex"),
    model: z.string().min(1),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
  }),
]);

export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export const AgentRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tool: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  tier: RoutingTierSchema,
  status: z.enum([
    "spawning",
    "working",
    "idle",
    "awaiting-approval",
    "control-paused",
    "stuck",
    "done",
    "dead",
    "failed",
  ]),
  failureReason: z.string().optional(),
  failedAt: z.iso.datetime().optional(),
  quotaReservationId: z.string().min(1).optional(),
  controlQuotaReservationId: z.string().min(1).optional(),
  controlMessageId: z.string().min(1).optional(),
  executionIdentity: ExecutionIdentitySchema.optional(),
  taskDescription: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  tmuxSession: z.string().min(1),
  terminalHandle: TerminalHandleSchema.optional(),
  contextPct: z.number().min(0).max(100),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  writeRevoked: z.boolean().default(false),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;
