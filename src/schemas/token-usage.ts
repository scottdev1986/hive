import { z } from "zod";

/** Provider-reported cumulative usage for one model session. Input includes
 * cached input; cached/cache-creation/reasoning are subsets when the provider
 * reports them and null when it does not. */
export const TokenCountsSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

export const TokenUsageReadingSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("measured"),
    counts: TokenCountsSchema,
    source: z.string().min(1),
    observedAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    state: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);
export type TokenUsageReading = z.infer<typeof TokenUsageReadingSchema>;

export const TokenUsageSubjectSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  role: z.enum(["orchestrator", "worker"]),
  // Deliberately open. Adding OpenCode is an adapter addition, not a schema
  // migration or a UI release.
  provider: z.string().min(1),
  model: z.string().min(1).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  reading: TokenUsageReadingSchema,
});
export type TokenUsageSubject = z.infer<typeof TokenUsageSubjectSchema>;

export const TokenUsageBreakdownSchema = z.strictObject({
  // Null means no subject in this bucket has a provider reading. A measured
  // zero is a non-null TokenCounts full of zeroes.
  counts: TokenCountsSchema.nullable(),
  subjectCount: z.number().int().nonnegative(),
});
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

export const TokenUsageSessionSchema = z.strictObject({
  id: z.string().uuid(),
  repoRoot: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  complete: z.boolean(),
  unknownSubjects: z.array(z.string().min(1)),
  fleet: TokenUsageBreakdownSchema,
  hiveControl: TokenUsageBreakdownSchema,
  workerSessions: TokenUsageBreakdownSchema,
  subjects: z.array(TokenUsageSubjectSchema),
});
export type TokenUsageSession = z.infer<typeof TokenUsageSessionSchema>;

export const TokenUsageSnapshotSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  currentSessionId: z.string().uuid().nullable(),
  sessions: z.array(TokenUsageSessionSchema),
  // The control bucket is exact. Worker sessions mix task work with Hive's
  // embedded protocol, so the ratio is a lower bound, never "the overhead".
  attribution: z.literal("control-lower-bound"),
});
export type TokenUsageSnapshot = z.infer<typeof TokenUsageSnapshotSchema>;
