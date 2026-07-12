import { z } from "zod";

export const MemoryScopeSchema = z.enum(["repo", "global"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySourceSchema = z.enum([
  "init",
  "agent",
  "orchestrator",
  "human",
  "legacy",
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryWriterSourceSchema = z.enum([
  "init",
  "agent",
  "orchestrator",
  "human",
]);

export const MemoryVerificationStatusSchema = z.enum([
  "verified",
  "unverified",
  "stale",
  "conflicted",
]);
export type MemoryVerificationStatus = z.infer<
  typeof MemoryVerificationStatusSchema
>;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const MemoryTopicSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "topic must be lowercase kebab-case",
  );

export const MemoryFactSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  topic: MemoryTopicSchema,
  title: z.string().min(1),
  body: z.string(),
  tags: z.array(z.string()),
  date: IsoDateSchema,
  path: z.string().min(1),
  source: MemorySourceSchema,
  evidence: z.string().min(1),
  status: MemoryVerificationStatusSchema,
  supersedes: z.array(z.string()),
  raw: z.array(z.string()),
  verified: IsoDateSchema.optional(),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const MemoryWriteInputSchema = z.object({
  scope: MemoryScopeSchema,
  id: z.string().min(1).optional(),
  topic: MemoryTopicSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  date: IsoDateSchema.optional(),
  source: MemoryWriterSourceSchema,
  evidence: z.string().min(1),
  status: MemoryVerificationStatusSchema,
  supersedes: z.array(z.string()),
  verified: IsoDateSchema.optional(),
}).superRefine((input, context) => {
  if (input.status === "verified" && input.verified === undefined) {
    context.addIssue({
      code: "custom",
      path: ["verified"],
      message: "verified date is required when status is verified",
    });
  }
  if (input.status === "unverified" && input.verified !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["verified"],
      message: "unverified articles cannot carry a verified date",
    });
  }
  if (input.status === "stale" && input.verified === undefined) {
    context.addIssue({
      code: "custom",
      path: ["verified"],
      message: "stale articles require their prior verified date",
    });
  }
  if (input.status === "conflicted" && !/conflict|disagree|contradict/i.test(input.body)) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "conflicted articles must annotate the disagreement",
    });
  }
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

export const MemoryWriteResultSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  topic: MemoryTopicSchema,
  title: z.string().min(1),
  path: z.string().min(1),
  rawPath: z.string().min(1),
  source: MemorySourceSchema,
  status: MemoryVerificationStatusSchema,
  verified: IsoDateSchema.optional(),
});
export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

export function compactMemoryWriteResult(
  fact: MemoryFact,
  rawPath: string,
): MemoryWriteResult {
  return {
    id: fact.id,
    scope: fact.scope,
    topic: fact.topic,
    title: fact.title,
    path: fact.path,
    rawPath,
    source: fact.source,
    status: fact.status,
    ...(fact.verified !== undefined ? { verified: fact.verified } : {}),
  };
}

export const MemorySearchResultSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  topic: MemoryTopicSchema,
  title: z.string().min(1),
  snippet: z.string(),
  date: z.string(),
  status: MemoryVerificationStatusSchema,
  tags: z.array(z.string()),
  path: z.string().min(1),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
