import { z } from "zod";

// The limits leave enough headroom for the daemon, orchestrator, and operating
// system to remain responsive while Hive refuses to add load.
export const ResourceLimitsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  perProcessMemoryMb: z.number().int().positive().default(12_288),
  minSystemAvailableMb: z.number().int().positive().default(4_096),
});

// An agent whose work is merged (or who never had any to merge) and who then
// sits idle earns no further quota reservation or human attention, so the
// daemon closes it itself rather than leaving that judgment to the
// orchestrator. The delay gives a human time to react to the idle agent's
// output before it closes.
export const LifecycleConfigSchema = z.strictObject({
  idleReap: z.boolean().default(true),
  idleReapMinutes: z.number().int().positive().default(10),
});

// Local embedding models run in the daemon process without a server.
export const MemoryEmbeddingModelSchema = z.enum([
  "bge-small-en-v1.5",
  "all-MiniLM-L6-v2",
]);

// The daemon's memory sweep reads these per-tier retention settings from
// `[memory.retention]`. It logs the effective configuration at startup.
// `facts_retention` and `digests_retention` are not knobs:
// facts are bi-temporal history (contradiction stamps invalid_at; rows are
// never deleted) and a digest is the downsample an aged event tier collapses
// into, so "forever" is the only value the schema accepts. These keys use the
// persisted configuration's snake_case naming.
export const MemoryRetentionConfigSchema = z.strictObject({
  // Raw hot tier: episodic `events` rows older than this are deleted by the
  // sweep (unless a digest's provenance still references them).
  events_hot_days: z.number().int().positive().default(30),
  facts_retention: z.literal("forever").default("forever"),
  digests_retention: z.literal("forever").default("forever"),
  // A wiki article whose status is verified and whose verified date is older
  // than this demotes to stale but remains visible and readable.
  stale_after_days: z.number().int().positive().default(90),
  sweep_interval_hours: z.number().positive().default(24),
});

export const HiveConfigSchema = z.strictObject({
  // Agent autonomy. "sandboxed" (the default) runs writers inside
  // their vendor sandboxes with an approval queue. "dangerous" launches
  // agents with no human input required — writers use Claude with
  // permissions.defaultMode "bypassPermissions" in its worktree settings,
  // Codex with approval_policy="never" and sandbox_mode="danger-full-access"
  // — while readers keep their read-only boundary and suppress vendor/MCP
  // confirmation prompts. The dial remains available through Workspace's Agents
  // menu and `hive autonomy`, both of which persist here. An absent key means
  // this default; an explicit key always means what it says. The read-only
  // orchestrator and read-only control restarts keep their reduced authority.
  autonomy: z.enum(["dangerous", "sandboxed"]).default("sandboxed"),
  // Parsed for wire compatibility only. The binary ships no model knowledge,
  // so neither value changes routing. An explicit model policy is the only
  // escape from a bad derivation, and user policy always wins.
  routingManifest: z.enum(["auto", "off"]).default("auto"),
  router: z.enum(["derived", "shipped"]).default("derived"),
  // Parsed for wire compatibility only. Nothing reads this value.
  benchmarks: z
    .strictObject({
      mode: z.enum(["live", "shadow", "off"]).default("live"),
    })
    .prefault({}),
  resources: ResourceLimitsSchema.prefault({}),
  lifecycle: LifecycleConfigSchema.prefault({}),
  memory: z
    .strictObject({
      retention: MemoryRetentionConfigSchema.prefault({}),
      // Hard token ceiling for the memory delta injected when an agent wakes
      // through message delivery or resume.
      wake_budget_tokens: z.number().int().positive().default(300),
      // The semantic recall provider. "local" runs an ONNX model in the daemon,
      // models cached under the Hive-owned models dir. "api" is a manual
      // escape-hatch knob only — no API provider ships, and there is NO
      // automatic fallback machinery: an unavailable semantic surface degrades
      // recall to the FTS-only bundle, it never switches providers.
      embedding_provider: z.enum(["local", "api"]).default("local"),
      embedding_model: MemoryEmbeddingModelSchema.default("bge-small-en-v1.5"),
    })
    .prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
export type MemoryRetentionConfig = z.output<
  typeof MemoryRetentionConfigSchema
>;
export type MemoryEmbeddingModel = z.infer<typeof MemoryEmbeddingModelSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
