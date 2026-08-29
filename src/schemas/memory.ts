import { z } from "zod";
import { definedFields } from "../shared/defined-fields";
import { formatlessString } from "./wire-schema";

export function normalizeNulText(value: string): string {
  return value.replaceAll("\0", "\uFFFD");
}

const RequiredMemoryTextSchema = z.string().min(1).transform(normalizeNulText);
const MemoryTextSchema = z.string().transform(normalizeNulText);

export const MemoryScopeSchema = z.enum(["repo", "global"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySourceSchema = z.enum([
  "init",
  "agent",
  "orchestrator",
  "user",
  "consolidator",
  "legacy",
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** Pre-rename articles may still say `human`; normalize before schema parse. */
export function normalizeMemorySource(value: string): string {
  return value === "human" ? "user" : value;
}

export const MemoryWriterSourceSchema = z.enum([
  "init",
  "agent",
  "orchestrator",
  "user",
  "consolidator",
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

export const MemoryKindSchema = z.enum(["article", "pitfall"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

const IsoDateSchema = formatlessString(z.iso.date());

/** Who wrote an article: the actor identity the daemon binds to the call, never a name the caller supplies. It is what makes "verified by someone else" checkable — `source` records a ROLE (agent, orchestrator, user) and cannot tell two agents apart. Optional because articles written before it existed carry no author, and an absent author reads as unknown rather than as "anyone may verify this". */
export const MemoryAuthorSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\s:]+$/, "author must be a single token with no colon or space");

const verificationDateError = (input: {
  status: MemoryVerificationStatus;
  verified?: string | undefined;
}): string | null => {
  if (input.status === "verified" && input.verified === undefined) {
    return "verified date is required when status is verified";
  }
  if (input.status === "unverified" && input.verified !== undefined) {
    return "unverified articles cannot carry a verified date";
  }
  if (input.status === "stale" && input.verified === undefined) {
    return "stale articles require their prior verified date";
  }
  return null;
};

/** The rules an article obeys whether it arrives as a write or is read back off disk. Shared so the two cannot drift apart, and so a schema derived from the write input's fields can restate them. */
const refineMemoryVerification = (
  input: {
    status: MemoryVerificationStatus;
    verified?: string | undefined;
  },
  context: z.RefinementCtx,
): void => {
  const verificationError = verificationDateError(input);
  if (verificationError !== null) {
    context.addIssue({
      code: "custom",
      path: ["verified"],
      message: verificationError,
    });
  }
};

export const MemoryTopicSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "topic must be lowercase kebab-case");

export const MemoryFactSchema = z
  .strictObject({
    id: z.string().min(1),
    scope: MemoryScopeSchema,
    topic: MemoryTopicSchema,
    title: RequiredMemoryTextSchema,
    body: MemoryTextSchema,
    tags: z.array(MemoryTextSchema),
    date: IsoDateSchema,
    path: z.string().min(1),
    source: MemorySourceSchema,
    evidence: RequiredMemoryTextSchema,
    status: MemoryVerificationStatusSchema,
    kind: MemoryKindSchema.default("article"),
    supersedes: z.array(z.string()),
    raw: z.array(z.string()),
    verified: IsoDateSchema.optional(),
    author: MemoryAuthorSchema.optional(),
    eventIds: z.array(z.number().int().positive()).optional(),
  })
  .superRefine(refineMemoryVerification);
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

const MemoryWriteInputFields = z.strictObject({
  scope: MemoryScopeSchema,
  id: z.string().min(1).optional(),
  topic: MemoryTopicSchema,
  title: RequiredMemoryTextSchema,
  body: RequiredMemoryTextSchema,
  tags: z.array(MemoryTextSchema).optional(),
  date: IsoDateSchema.optional(),
  source: MemoryWriterSourceSchema,
  evidence: RequiredMemoryTextSchema,
  status: MemoryVerificationStatusSchema,
  kind: MemoryKindSchema.default("article"),
  supersedes: z.array(z.string()),
  verified: IsoDateSchema.optional(),
  author: MemoryAuthorSchema.optional(),
  eventIds: z.array(z.number().int().positive()).optional(),
});

export const MemoryWriteInputSchema = MemoryWriteInputFields.superRefine(
  refineMemoryVerification,
);
export type MemoryWriteInput = z.input<typeof MemoryWriteInputSchema>;

/** The write input as a CALLER may express it: every field except `author`. The daemon fills the author from the identity bound to the call, so a caller is never asked who it is and cannot answer with someone else's name. Derived from the same fields as the write input so the two cannot drift. */
export const MemoryWriteRequestFieldsSchema = MemoryWriteInputFields.omit({
  author: true,
}).superRefine(refineMemoryVerification);

/** Update identity comes from the outer compare-and-set fence. */
export const MemoryUpdateRequestFieldsSchema = MemoryWriteInputFields.omit({
  author: true,
  id: true,
  scope: true,
}).superRefine(refineMemoryVerification);

export const MemorySimilarCandidateSchema = z.strictObject({
  scope: MemoryScopeSchema,
  id: z.string().min(1),
  title: z.string().min(1),
});
export type MemorySimilarCandidate = z.infer<
  typeof MemorySimilarCandidateSchema
>;

export const MemoryWriteResultSchema = z
  .strictObject({
    id: z.string().min(1),
    scope: MemoryScopeSchema,
    topic: MemoryTopicSchema,
    title: z.string().min(1),
    path: z.string().min(1),
    rawPath: z.string().min(1),
    source: MemorySourceSchema,
    status: MemoryVerificationStatusSchema,
    verified: IsoDateSchema.optional(),
    similarCandidates: z.array(MemorySimilarCandidateSchema).optional(),
    embedding: z.string().optional(),
  })
  .superRefine((input, context) => {
    const verificationError = verificationDateError(input);
    if (verificationError !== null) {
      context.addIssue({
        code: "custom",
        path: ["verified"],
        message: verificationError,
      });
    }
  });
export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

export function compactMemoryWriteResult(
  fact: MemoryFact,
  rawPath: string,
  similarCandidates: MemorySimilarCandidate[] = [],
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
    ...definedFields({
      verified: fact.verified,
      similarCandidates:
        similarCandidates.length > 0 ? similarCandidates : undefined,
    }),
  };
}

export const MemorySearchResultSchema = z.strictObject({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  topic: MemoryTopicSchema,
  title: z.string().min(1),
  snippet: z.string(),
  date: IsoDateSchema,
  status: MemoryVerificationStatusSchema,
  tags: z.array(z.string()),
  path: z.string().min(1),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
