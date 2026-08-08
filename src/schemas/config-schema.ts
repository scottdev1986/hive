import { z } from "zod";

// The limits leave enough headroom for the daemon, orchestrator, and operating system to remain responsive while Hive refuses to add load.
export const ResourceLimitsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  perProcessMemoryMb: z.number().int().positive().default(12_288),
  minSystemAvailableMb: z.number().int().positive().default(4_096),
});

export const MemoryEmbeddingModelSchema = z.enum([
  "bge-small-en-v1.5",
  "all-MiniLM-L6-v2",
]);

// The daemon's memory sweep reads these per-tier retention settings from `[memory.retention]`. It logs the effective configuration at startup. These keys use the persisted configuration's snake_case naming.
export const MemoryRetentionConfigSchema = z.strictObject({
  events_hot_days: z.number().int().positive().default(30),
  // A wiki article whose status is verified and whose verified date is older than this demotes to stale but remains visible and readable.
  stale_after_days: z.number().int().positive().default(90),
  sweep_interval_hours: z.number().positive().default(24),
});

// How long a stored work product survives, read from `[artifacts]`. Generous on purpose: an artifact exists because the analysis behind a decision has to outlive the agent that wrote it, and the retention sweep that deletes one is the same pass that ages memory out.
export const ArtifactsConfigSchema = z.strictObject({
  retention_days: z.number().int().positive().default(90),
});

export const AutonomySchema = z.enum(["dangerous", "sandboxed"]);

/** The `/autonomy` wire envelope, in both directions. What a body that does not match means is the caller's to decide — the daemon refuses the request, the CLI throws, the feed degrades to an omitted field — so this says only what a match is. */
export const AutonomyEnvelopeSchema = z.object({ autonomy: AutonomySchema });

export const HiveConfigSchema = z.strictObject({
  // Agent autonomy. "sandboxed" (the default) runs writers inside their vendor sandboxes with an approval queue. "dangerous" launches agents with no user input required. Readers retain each adapter's reduced-authority posture, except Kimi, which has no per-launch read-only control and therefore depends on its user-owned permission configuration. The dial remains available through Workspace's Agents menu and `hive autonomy`, both of which persist here. An absent key means this default; an explicit key always means what it says.
  autonomy: AutonomySchema.default("sandboxed"),
  routingManifest: z.enum(["auto", "off"]).default("auto"),
  router: z.enum(["derived", "shipped"]).default("derived"),
  benchmarks: z
    .strictObject({
      mode: z.enum(["live", "shadow", "off"]).default("live"),
    })
    .prefault({}),
  resources: ResourceLimitsSchema.prefault({}),
  artifacts: ArtifactsConfigSchema.prefault({}),
  memory: z
    .strictObject({
      retention: MemoryRetentionConfigSchema.prefault({}),
      wake_budget_tokens: z.number().int().positive().default(300),
      // The semantic recall provider. "local" runs an ONNX model in the daemon, models cached under the Hive-owned models dir. "api" is a manual escape-hatch knob only — no API provider ships, and there is NO automatic fallback machinery: an unavailable semantic surface degrades recall to the FTS-only bundle, it never switches providers.
      embedding_provider: z.enum(["local", "api"]).default("local"),
      embedding_model: MemoryEmbeddingModelSchema.default("bge-small-en-v1.5"),
    })
    .prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type ArtifactsConfig = z.output<typeof ArtifactsConfigSchema>;
export type MemoryRetentionConfig = z.output<
  typeof MemoryRetentionConfigSchema
>;
export type MemoryEmbeddingModel = z.infer<typeof MemoryEmbeddingModelSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
