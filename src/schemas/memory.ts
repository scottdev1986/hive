import { z } from "zod";

// Durable knowledge has exactly two scopes (SPEC.md decision 5): per-repo
// facts committed at `.hive/memory/` travel with the clone, global facts at
// `~/.hive/memory/` accumulate lessons across every project.
export const MemoryScopeSchema = z.enum(["repo", "global"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// Provenance is first-class, not decoration (SPEC.md decision 5): who authored
// a fact decides how it ages. `init` facts are derived-and-re-derivable — the
// cheap target of init's re-verify pass — while `agent`/`orchestrator`/`human`
// facts are earned and load-bearing until something disproves them. A *missing*
// source means a legacy fact written before provenance existed; §5 binds that
// to "treated as earned", so absence is the honest encoding of an unknown
// author — there is deliberately no "unknown" member to invent precision with.
export const MemorySourceSchema = z.enum([
  "init",
  "agent",
  "orchestrator",
  "human",
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

// One fact per Markdown file; the file is the source of truth and the id is
// its filename (without extension), so re-reading the file always agrees
// with whatever the SQLite FTS index says.
export const MemoryFactSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  title: z.string().min(1),
  body: z.string(),
  tags: z.array(z.string()),
  date: IsoDateSchema,
  path: z.string().min(1),
  // Provenance (§5). Both optional: a legacy fact carries neither, and §5
  // reads absence as "earned, never re-confirmed", with `date` as the
  // freshness floor when `verified` is missing.
  source: MemorySourceSchema.optional(),
  // The date the fact was last confirmed true against the repo — distinct from
  // `date` (last written). Absent means never re-confirmed.
  verified: IsoDateSchema.optional(),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const MemoryWriteInputSchema = z.object({
  scope: MemoryScopeSchema,
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  date: IsoDateSchema.optional(),
  // The writer records who is writing (§5): `agent` at landing, `orchestrator`
  // for decisions it made, `init` for seeded narrative facts, `human` for a
  // hand-authored one. Omitting it stores a fact with no provenance, read as
  // legacy/earned — callers that know the author should always pass it.
  source: MemorySourceSchema.optional(),
  verified: IsoDateSchema.optional(),
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

export const MemorySearchResultSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  title: z.string().min(1),
  snippet: z.string(),
  date: z.string(),
  tags: z.array(z.string()),
  path: z.string().min(1),
});
// Search returns short snippets to *find* a fact; provenance and the
// re-verify check surface where §5 places them — the injected index marks
// staleness, and `verified` rides the full fact from memory_read.
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
