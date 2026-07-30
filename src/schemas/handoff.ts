import { z } from "zod";
import { ExactContentRefSchema } from "./context-projection";
import { MemoryScopeSchema } from "./memory";
import { RunOutcomeSchema } from "./run-outcome";
import { SessionLocatorSchema } from "./session-protocol";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const HandoffSummarySchema = z
  .strictObject({
    goal: z.string(),
    done: z.array(z.string()),
    remaining: z.array(z.string()),
    decisions: z.array(z.string()),
    failedApproaches: z.array(z.string()),
    uncertainty: z.array(z.string()),
    nextAction: z.string().nullable(),
    provenance: z.enum(["agent", "generated", "fallback"]),
  })
  .readonly();

export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const HandoffBundleSchema = z
  .strictObject({
    handoffId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    runOutcome: RunOutcomeSchema,
    reason: z.enum(["quota-drain", "capability-wall", "crash", "operator"]),
    originalTaskRef: z
      .strictObject({
        kind: z.literal("agent-task"),
        agentId: z.string().min(1),
        content: z.string(),
        digest: Sha256Schema,
      })
      .readonly(),
    requirementRefs: z.array(ExactContentRefSchema),
    branch: z
      .strictObject({
        name: z.string().min(1),
        base: z.string().min(1),
        head: z.string().min(1),
      })
      .readonly(),
    worktree: z
      .strictObject({
        dirtyPaths: z.array(z.string().min(1)),
        untrackedPaths: z.array(z.string().min(1)),
        commits: z.array(
          z
            .strictObject({
              id: z.string().min(1),
              subject: z.string(),
            })
            .readonly(),
        ),
      })
      .readonly(),
    messagesThrough: z.number().int().nonnegative(),
    pendingMessageIds: z.array(z.string().min(1)),
    memoryRefs: z.array(
      z
        .strictObject({
          scope: MemoryScopeSchema,
          id: z.string().min(1),
          digest: Sha256Schema,
          retrieval: z
            .strictObject({
              tool: z.literal("memory_read"),
              arguments: z
                .strictObject({
                  scope: MemoryScopeSchema,
                  id: z.string().min(1),
                })
                .readonly(),
            })
            .readonly(),
        })
        .readonly(),
    ),
    activity: z
      .strictObject({
        providerEventRefs: z.array(z.string().min(1)),
        terminalOutputRanges: z.array(
          z
            .strictObject({
              terminal: SessionLocatorSchema,
              through: z.string().min(1),
              digest: Sha256Schema,
              bytes: z.number().int().nonnegative(),
              completeness: z.enum(["complete", "gap"]),
            })
            .readonly(),
        ),
        providerTranscriptRefs: z.array(z.string().min(1)),
        statusReportRef: z.string().min(1).nullable(),
      })
      .readonly(),
    summary: HandoffSummarySchema.nullable(),
    completeness: z.enum(["complete", "partial", "unknown"]),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type HandoffBundle = z.infer<typeof HandoffBundleSchema>;

export const HandoffPickupSchema = z
  .strictObject({
    handoffId: z.string().uuid(),
    replacementAgentId: z.string().min(1),
    pickedUpAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type HandoffPickup = z.infer<typeof HandoffPickupSchema>;

/**
 * Capability-escalation payload. It remains distinct from the durable bundle:
 * escalation is an agent-authored claim, not measured preservation.
 */
export const HandoffSchema = z.object({
  agentName: z.string().min(1),
  goal: z.string(),
  done: z.array(z.string()),
  remaining: z.array(z.string()),
  decisions: z.array(z.string()),
  failedApproaches: z.array(z.string()),
  branch: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type Handoff = z.infer<typeof HandoffSchema>;
