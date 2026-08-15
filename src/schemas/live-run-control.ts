import { z } from "zod";
import {
  MutationExpectationSchema,
  mutationIntentSchema,
  mutationResultSchema,
} from "./run-control";
import { CapabilityProviderSchema } from "./capability";
import { AdapterChildIdentitySchema } from "./provider-run";
import {
  DecimalUint64Schema,
  ProcessRootSchema,
  Rfc3339UtcMillisecondsSchema,
  SessionLocatorSchema,
  SessionSurvivorsSchema,
} from "./session-protocol";

const LiveRunProviderRunSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("running"),
    runId: z.string().uuid(),
    provider: CapabilityProviderSchema,
    process: AdapterChildIdentitySchema,
  }),
  z.strictObject({ state: z.literal("absent") }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
]);

const LiveRunShellSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("retained"),
    root: ProcessRootSchema,
    foreground: z.enum(["provider", "shell", "other"]),
  }),
  z.strictObject({ state: z.literal("terminated") }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
]);

const LiveRunInputOwnerSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("free") }),
  z.strictObject({
    state: z.literal("owned"),
    writer: z.string().min(1),
    kind: z.enum(["user", "automation"]),
    leaseExpiresAt: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
]);

const LiveRunProcessCensusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("complete"),
    source: z.literal("sessiond-process-tree"),
    members: z.array(
      z.strictObject({
        pid: z.number().int().positive(),
        startToken: z.string().min(1),
      }),
    ),
    observedAt: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({ state: z.literal("terminated") }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
]);

const LiveRunTerminationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not-requested") }),
  z.strictObject({
    state: z.literal("terminated"),
    completedAt: Rfc3339UtcMillisecondsSchema,
    survivors: z.tuple([]),
  }),
  z.strictObject({
    state: z.literal("survivors"),
    completedAt: Rfc3339UtcMillisecondsSchema,
    survivors: SessionSurvivorsSchema.unwrap().min(1).readonly(),
  }),
  z.strictObject({
    state: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);

const LiveRunControlAvailabilitySchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().min(1).nullable(),
});

export const LiveRunControlProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observedAt: Rfc3339UtcMillisecondsSchema,
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  provider: CapabilityProviderSchema,
  locator: SessionLocatorSchema,
  providerRun: LiveRunProviderRunSchema,
  shell: LiveRunShellSchema,
  inputOwner: LiveRunInputOwnerSchema,
  processCensus: LiveRunProcessCensusSchema,
  termination: LiveRunTerminationSchema,
  controls: z.strictObject({
    stopProvider: LiveRunControlAvailabilitySchema,
    terminateTerminal: LiveRunControlAvailabilitySchema,
  }),
});
export type LiveRunControlProjection = z.infer<
  typeof LiveRunControlProjectionSchema
>;

const LiveRunControlTargetSchema = z.strictObject({
  agentId: z.string().min(1),
  locator: SessionLocatorSchema,
  expectedShellRoot: ProcessRootSchema,
});

export const LiveRunControlBodySchema = z.discriminatedUnion("operation", [
  LiveRunControlTargetSchema.extend({
    operation: z.literal("stop-provider"),
    expectedProviderRunId: z.string().uuid(),
  }),
  LiveRunControlTargetSchema.extend({
    operation: z.literal("terminate-terminal"),
  }),
]);
export type LiveRunControlBody = z.infer<typeof LiveRunControlBodySchema>;

const LiveRunGenerationExpectationSchema = MutationExpectationSchema.refine(
  (expected) => expected.kind === "epoch",
  "Live Run control requires an exact terminal generation",
).pipe(
  z.strictObject({ kind: z.literal("epoch"), epoch: DecimalUint64Schema }),
);

export const LiveRunControlIntentSchema = mutationIntentSchema(
  LiveRunControlBodySchema,
  LiveRunGenerationExpectationSchema,
);
export type LiveRunControlIntent = z.infer<typeof LiveRunControlIntentSchema>;

export const LiveRunControlResultSchema = mutationResultSchema(
  LiveRunControlProjectionSchema,
  LiveRunGenerationExpectationSchema,
);
export type LiveRunControlResult = z.infer<typeof LiveRunControlResultSchema>;
