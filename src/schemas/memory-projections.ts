// Memory client wire contracts. Clients consume these envelopes instead of
// reading stores directly. Every store distinguishes not built (`absent`),
// built with no rows (`empty`), and populated (`ok`).
import { z } from "zod";
import {
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryUpdateRequestFieldsSchema,
  MemoryVerificationStatusSchema,
  MemoryWriteRequestFieldsSchema,
} from "./memory";

export const MemoryStoreStateSchema = z.enum(["absent", "empty", "ok"]);
export type MemoryStoreState = z.infer<typeof MemoryStoreStateSchema>;

/** Bumped when a field is removed or its meaning changes, so a client can refuse a payload it cannot read instead of silently mis-rendering one. */
export const MEMORY_PROJECTION_SCHEMA_VERSION = 1;

/** Carried by all four views. A client holding one of these needs to answer three questions the payload alone cannot: can I read this shape, when was it true, and has it changed since I last looked. `sourceRevision` is a digest of the payload WITHOUT this envelope, so it is stable across polls that find no change — an `observedAt` inside it would make every poll look like a new state. */
export const MemoryProjectionEnvelopeFields = {
  schemaVersion: z.literal(MEMORY_PROJECTION_SCHEMA_VERSION),
  observedAt: z.iso.datetime({ offset: true }),
  sourceRevision: z.string().min(1),
  /** `live` — read through to the stores at `observedAt`, which is the only value these four builders produce today. The field exists so a view that is ever served from a cache can say so without a wire break, because a client that cannot tell a cached view from a live one will present stale counts as current. */
  freshness: z.enum(["live", "cached"]),
};

export const MemoryProjectionEnvelopeSchema = z.strictObject(
  MemoryProjectionEnvelopeFields,
);
export type MemoryProjectionEnvelope = z.infer<
  typeof MemoryProjectionEnvelopeSchema
>;

export const MemoryRowScopeSchema = z.enum(["repo", "global", "project"]);

export const MemoryJobKindSchema = z.enum([
  "reindex",
  "retention-sweep",
  "consolidation-dry-run",
  "consolidation-apply",
]);
export type MemoryJobKind = z.infer<typeof MemoryJobKindSchema>;

/** Bounded progress: one short step label and a done/total pair. `total` is null while the job does not yet know how much work there is — null is never rendered as zero, because "unknown" and "none" are different answers. */
export const MemoryJobProgressSchema = z
  .strictObject({
    step: z.string().max(120),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
  })
  .refine(
    ({ done, total }) => total === null || done <= total,
    "done cannot exceed total",
  );
export type MemoryJobProgress = z.infer<typeof MemoryJobProgressSchema>;

/** Job results and readbacks are scalar maps so a receipt cannot grow into an unbounded payload the client has to page through. */
const JobFactsSchema = z.record(z.string(), z.union([z.number(), z.string()]));

const MemoryJobReceiptIdentityFields = {
  id: z.string().min(1),
  kind: MemoryJobKindSchema,
} as const;

const MemoryJobReceiptExecutionFields = {
  requestedBy: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
} as const;

const MemoryJobReceiptProgressFields = {
  progress: MemoryJobProgressSchema,
  summary: z.string().max(400),
} as const;

// Cross-language fixtures serialize schema order, so preserve the established field order.
export const MemoryJobReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...MemoryJobReceiptIdentityFields,
    state: z.literal("running"),
    ...MemoryJobReceiptExecutionFields,
    finishedAt: z.null(),
    ...MemoryJobReceiptProgressFields,
    error: z.null(),
    readback: z.null(),
  }),
  z.strictObject({
    ...MemoryJobReceiptIdentityFields,
    state: z.literal("succeeded"),
    ...MemoryJobReceiptExecutionFields,
    finishedAt: z.iso.datetime({ offset: true }),
    ...MemoryJobReceiptProgressFields,
    error: z.null(),
    readback: JobFactsSchema,
  }),
  z.strictObject({
    ...MemoryJobReceiptIdentityFields,
    state: z.literal("failed"),
    ...MemoryJobReceiptExecutionFields,
    finishedAt: z.iso.datetime({ offset: true }),
    ...MemoryJobReceiptProgressFields,
    error: z.string().min(1).max(2000),
    // A failed job still reports whatever state can be read back safely.
    readback: JobFactsSchema.nullable(),
  }),
]);
export type MemoryJobReceipt = z.infer<typeof MemoryJobReceiptSchema>;

export const MemoryConfigProjectionSchema = z.strictObject({
  revision: z.string().min(1),
  eventsHotDays: z.number().int().positive(),
  staleAfterDays: z.number().int().positive(),
  sweepIntervalHours: z.number().positive(),
  wakeBudgetTokens: z.number().int().positive(),
  embeddingProvider: z.enum(["local", "api"]),
  embeddingModel: z.string().min(1),
});
export type MemoryConfigProjection = z.infer<
  typeof MemoryConfigProjectionSchema
>;

/** Only the tunable retention values. */
export const MemoryConfigPatchSchema = z.strictObject({
  eventsHotDays: z.number().int().positive().optional(),
  staleAfterDays: z.number().int().positive().optional(),
  sweepIntervalHours: z.number().positive().optional(),
  wakeBudgetTokens: z.number().int().positive().optional(),
});
export type MemoryConfigPatch = z.infer<typeof MemoryConfigPatchSchema>;

export const MemoryConfigCasResultSchema = z.discriminatedUnion("state", [
  /** The config that is now on disk, re-read after the write. */
  z.strictObject({
    state: z.literal("applied"),
    config: MemoryConfigProjectionSchema,
  }),
  z.strictObject({
    state: z.literal("conflict"),
    currentRevision: z.string().min(1),
    detail: z.string(),
  }),
  z.strictObject({
    state: z.literal("rejected"),
    detail: z.string(),
  }),
]);
export type MemoryConfigCasResult = z.infer<typeof MemoryConfigCasResultSchema>;

export const MemoryIndexHealthSchema = z.strictObject({
  fts: z.strictObject({
    state: MemoryStoreStateSchema,
    articles: z.number().int().nonnegative(),
  }),
  vectors: z.strictObject({
    state: MemoryStoreStateSchema,
    articles: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    provider: z.enum(["local", "api"]),
    model: z.string().min(1),
    /** The embedding runtime's own health label (ready, pending, disabled, embedding-runtime-missing, …). Separate from `state` on purpose: a ready runtime with no rows yet and a broken runtime with stale rows are both things a user must be able to see, and one field cannot say both. */
    runtime: z.string().min(1),
  }),
});
export type MemoryIndexHealth = z.infer<typeof MemoryIndexHealthSchema>;

export const MemoryScopeHealthSchema = z.strictObject({
  scope: MemoryScopeSchema,
  state: MemoryStoreStateSchema,
  articles: z.number().int().nonnegative(),
  pitfalls: z.number().int().nonnegative(),
  unverifiedPitfalls: z.number().int().nonnegative(),
  rawObservations: z.number().int().nonnegative(),
});

export const MemoryGapSchema = z.strictObject({
  code: z.string().min(1),
  detail: z.string().min(1).max(400),
});

export const MemoryOverviewProjectionSchema = z.strictObject({
  ...MemoryProjectionEnvelopeFields,
  wiki: z.strictObject({
    state: MemoryStoreStateSchema,
    articles: z.number().int().nonnegative(),
    pitfalls: z.number().int().nonnegative(),
    unverifiedPitfalls: z.number().int().nonnegative(),
    scopes: z.array(MemoryScopeHealthSchema),
  }),
  episodic: z.strictObject({
    state: MemoryStoreStateSchema,
    events: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    digests: z.number().int().nonnegative(),
  }),
  indexes: MemoryIndexHealthSchema,
  config: MemoryConfigProjectionSchema,
  /** The newest receipt for each job kind that has ever run here. A kind that has never run is absent from this list rather than present with a zeroed receipt. */
  lastJobs: z.array(MemoryJobReceiptSchema),
  gaps: z.array(MemoryGapSchema),
});
export type MemoryOverviewProjection = z.infer<
  typeof MemoryOverviewProjectionSchema
>;

/** Every row carries `key`, its position in one total order over the whole corpus: `kind \0 scope \0 id`, with numeric ids zero-padded so they sort as numbers. Pagination walks that order, which is why it survives concurrent writes — a row inserted during a walk lands at its own key and never shifts a key the client already holds. Ordering by date would renumber the page under the cursor on every write. */
const ListRowBase = {
  key: z.string().min(1),
  scope: MemoryRowScopeSchema,
  id: z.string().min(1),
  title: z.string(),
  topic: z.string(),
  updated: z.string().min(1),
  /** Content revision, for compare-and-set mutation. */
  revision: z.string().min(1),
  source: z.string().min(1),
};

const ArticleRowFields = {
  ...ListRowBase,
  scope: MemoryScopeSchema,
  status: MemoryVerificationStatusSchema,
  verified: z.string().nullable(),
  supersedes: z.array(z.string()),
  rawRefs: z.array(z.string()),
  evidence: z.string(),
  source: MemorySourceSchema,
};

export const MemoryListItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("article"), ...ArticleRowFields }),
  z.strictObject({ kind: z.literal("pitfall"), ...ArticleRowFields }),
  z.strictObject({
    kind: z.literal("fact"),
    ...ListRowBase,
    scope: z.literal("project"),
    /** Only currently-believed facts are listed; the episodic store exposes no reader for invalidated ones, so this is the single honest value rather than an enum whose other arm nothing can produce. */
    status: z.literal("current"),
    confidence: z.number().nullable(),
    validAt: z.string(),
    invalidAt: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("digest"),
    ...ListRowBase,
    scope: z.literal("project"),
    status: z.literal("compiled"),
    agent: z.string(),
    sessionId: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("raw-ref"),
    ...ListRowBase,
    scope: MemoryScopeSchema,
    /** Raw observations are evidence. They are never edited and never expire, so their only lifecycle value is this one. */
    status: z.literal("immutable"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  }),
]);
export type MemoryListItem = z.infer<typeof MemoryListItemSchema>;

export const MemoryListKindSchema = z.enum([
  "article",
  "pitfall",
  "fact",
  "digest",
  "raw-ref",
]);

export const MemoryListRequestSchema = z.strictObject({
  cursor: z.string().nullish(),
  limit: z.number().int().positive().max(200).default(50),
  kinds: z.array(MemoryListKindSchema).nullish(),
  scopes: z.array(MemoryRowScopeSchema).nullish(),
  statuses: z.array(z.string()).nullish(),
});
export type MemoryListRequest = z.input<typeof MemoryListRequestSchema>;

export const MemoryListPageSchema = z.strictObject({
  ...MemoryProjectionEnvelopeFields,
  state: MemoryStoreStateSchema,
  items: z.array(MemoryListItemSchema),
  nextCursor: z.string().nullable(),
  /** Rows matching the filter across the whole corpus at the moment the page was built. A concurrent write changes it between pages; that is a real change in the world, not pagination drift. */
  total: z.number().int().nonnegative(),
});
export type MemoryListPage = z.infer<typeof MemoryListPageSchema>;

// Update and delete require the revision the caller read; create has no fence.
export const MemoryMutationRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    input: MemoryWriteRequestFieldsSchema,
  }),
  z.strictObject({
    action: z.literal("update"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    expectedRevision: z.string().min(1),
    input: MemoryUpdateRequestFieldsSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    expectedRevision: z.string().min(1),
  }),
]);
export type MemoryMutationRequest = z.input<typeof MemoryMutationRequestSchema>;
export type ParsedMemoryMutationRequest = z.output<
  typeof MemoryMutationRequestSchema
>;

export const MemoryMutationResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("applied"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    /** The revision after the write — read back from disk, not predicted. */
    revision: z.string().nullable(),
  }),
  /** The article moved since the client read it. The current revision comes back so the client can re-read and rebase its edit rather than guess. */
  z.strictObject({
    state: z.literal("conflict"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    currentRevision: z.string().nullable(),
    detail: z.string(),
  }),
  /** A create named an id that is already taken. Refused rather than merged: create carries no revision, so letting it land on an existing article is a blind overwrite — a door around the compare-and-set fence that the update path exists to enforce. The current revision comes back so the caller can reissue as an update. */
  z.strictObject({
    state: z.literal("already-exists"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    currentRevision: z.string().min(1),
    detail: z.string(),
  }),
  z.strictObject({
    state: z.literal("referenced"),
    scope: MemoryScopeSchema,
    id: z.string().min(1),
    referencedBy: z.array(z.string()),
    detail: z.string(),
  }),
]);
export type MemoryMutationResult = z.infer<typeof MemoryMutationResultSchema>;

export const MemoryRecallRowSchema = z.strictObject({
  scope: z.string(),
  topic: z.string(),
  id: z.string(),
  date: z.string(),
  title: z.string(),
  snippet: z.string(),
  status: z.string(),
  flag: z.string().nullable(),
  pitfall: z.boolean(),
});

export const MemoryRecallSemanticSchema = z.union([
  z.literal("hybrid"),
  z.literal("disabled"),
  z.templateLiteral([z.literal("degraded:"), z.string()]),
]);

export const MEMORY_QUERY_CLASSES = [
  "agent-now",
  "agent-history",
  "fleet-summary",
  "what-landed",
  "who-blocked",
  "token-spend",
  "point-search",
  "my-history",
  "pitfall-check",
] as const;
export const MemoryQueryClassSchema = z.enum(MEMORY_QUERY_CLASSES);
export type MemoryQueryClass = z.infer<typeof MemoryQueryClassSchema>;

export const MemoryQueryEnvelopeSchema = z.strictObject({
  class: MemoryQueryClassSchema,
  state: MemoryStoreStateSchema,
  detail: z.string().nullable(),
  /** The ceiling actually enforced (after clamping any caller budget). */
  budget: z.number(),
  tokens: z.number(),
  truncated: z.boolean(),
  omitted: z.number(),
  asOf: z.string().nullable(),
  source: z.array(z.string()),
  results: z.array(z.unknown()),
});

/** What the preview is standing in for. The purpose picks the budget ceiling the real path would have used — a wake preview shown against the explicit recall ceiling is a preview of a bundle no agent will ever receive. */
export const MemoryRecallPurposeSchema = z.enum([
  "explicit-recall",
  "spawn-preview",
  "wake-preview",
]);
export type MemoryRecallPurpose = z.infer<typeof MemoryRecallPurposeSchema>;

export const MemoryRecallPreviewRequestSchema = z.strictObject({
  query: z.string().min(1),
  purpose: MemoryRecallPurposeSchema.default("explicit-recall"),
  budget: z.number().int().positive().nullish(),
});

export const MemoryRecallPreviewRowSchema = z.strictObject({
  rank: z.number().int().positive(),
  class: z.enum(["pitfall", "article"]),
  ...MemoryRecallRowSchema.omit({ pitfall: true })["shape"],
});

/** Per-class budget accounting. The reserve is what the class was guaranteed before the other side could bid for it, which is the anti-starvation guarantee made visible instead of asserted. */
export const MemoryRecallPartitionSchema = z.strictObject({
  class: z.enum(["pitfall", "article"]),
  reservedTokens: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
});

export const MemoryRecallPreviewSchema = z.strictObject({
  ...MemoryProjectionEnvelopeFields,
  purpose: MemoryRecallPurposeSchema,
  query: z.string(),
  state: z.enum(["ok", "empty", "absent"]),
  semantic: z.string().min(1),
  warning: z.string().nullable(),
  note: z.string().min(1),
  budget: z.number().int().positive(),
  tokens: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted: z.number().int().nonnegative(),
  omittedPitfalls: z.number().int().nonnegative(),
  omittedArticles: z.number().int().nonnegative(),
  partitions: z.array(MemoryRecallPartitionSchema),
  rows: z.array(MemoryRecallPreviewRowSchema),
  triggerPhrase: z
    .strictObject({
      detected: z.enum(["recall", "note", "document"]),
      treatedAs: z.literal("literal-query"),
    })
    .nullable(),
  mutation: z.literal("none"),
  highWaterAdvanced: z.literal(false),
});
export type MemoryRecallPreview = z.infer<typeof MemoryRecallPreviewSchema>;

export const MemoryMaintenanceProjectionSchema = z.strictObject({
  ...MemoryProjectionEnvelopeFields,
  config: MemoryConfigProjectionSchema,
  indexes: MemoryIndexHealthSchema,
  consolidation: z.strictObject({
    state: MemoryStoreStateSchema,
    candidates: z.number().int().nonnegative(),
  }),
  jobs: z.strictObject({
    state: MemoryStoreStateSchema,
    recent: z.array(MemoryJobReceiptSchema),
  }),
});
export type MemoryMaintenanceProjection = z.infer<
  typeof MemoryMaintenanceProjectionSchema
>;
