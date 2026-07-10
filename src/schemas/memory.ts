import { z } from "zod";

// Durable knowledge has exactly two scopes (SPEC.md decision 5): per-repo
// facts committed at `.hive/memory/` travel with the clone, global facts at
// `~/.hive/memory/` accumulate lessons across every project.
export const MemoryScopeSchema = z.enum(["repo", "global"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// One fact per Markdown file; the file is the source of truth and the id is
// its filename (without extension), so re-reading the file always agrees
// with whatever the SQLite FTS index says.
export const MemoryFactSchema = z.object({
  id: z.string().min(1),
  scope: MemoryScopeSchema,
  title: z.string().min(1),
  body: z.string(),
  tags: z.array(z.string()),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  path: z.string().min(1),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const MemoryWriteInputSchema = z.object({
  scope: MemoryScopeSchema,
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
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
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
