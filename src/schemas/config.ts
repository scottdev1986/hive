import { z } from "zod";

// Defaults sized against the 2026-07-10 OOM incident: the runaway test
// processes that took the machine down crossed 12 GB within their first
// minute, while no legitimate hive workload (agent CLIs, test suites,
// typechecks) has been observed above ~2 GB. The floor keeps enough headroom
// that the daemon, the orchestrator, and macOS itself stay responsive while
// hive refuses to add load.
export const ResourceLimitsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  perProcessMemoryMb: z.number().int().positive().default(12_288),
  minSystemAvailableMb: z.number().int().positive().default(4_096),
});

// An agent whose work is merged (or who never had any to merge) and who then
// sits idle earns no further quota reservation or human attention, so the
// daemon closes it itself rather than leaving that judgment to the
// orchestrator. 10 minutes is long enough that a human reading the idle
// agent's output has time to react before it is gone.
export const LifecycleConfigSchema = z.strictObject({
  idleReap: z.boolean().default(true),
  idleReapMinutes: z.number().int().positive().default(10),
});

// HiveMemory HM-2 WP3 (board #72; planning/story-m3-s37-digests-lifecycle.md
// DoD 5): the per-tier retention constants the daemon's memory sweep runs on,
// as the `[memory.retention]` section of ~/.hive/config.toml. The numbers are
// ratifiable starting points; changes are loud — the daemon logs the effective
// config at start. `facts_retention` and `digests_retention` are not knobs:
// facts are bi-temporal history (contradiction stamps invalid_at; rows are
// never deleted) and a digest is the downsample an aged event tier collapses
// into, so "forever" is the only value the schema accepts. Naming follows the
// story's snake_case key names; the rest of this file is camelCase.
export const MemoryRetentionConfigSchema = z.strictObject({
  // Raw hot tier: episodic `events` rows older than this are deleted by the
  // sweep (unless a digest's provenance still references them).
  events_hot_days: z.number().int().positive().default(30),
  facts_retention: z.literal("forever").default("forever"),
  digests_retention: z.literal("forever").default("forever"),
  // A wiki article whose status is verified and whose verified date is older
  // than this demotes to stale (S3.7 DoD 7: visible, still readable, never
  // deleted).
  stale_after_days: z.number().int().positive().default(90),
  sweep_interval_hours: z.number().positive().default(24),
});

export const HiveConfigSchema = z.strictObject({
  codex: z.strictObject({
    driver: z.enum(["tui", "app-server"]).default("tui"),
  }).default({ driver: "tui" }),
  // Agent autonomy. "sandboxed" (the default) runs writers inside
  // their vendor sandboxes with decision 4's approval queue (acceptEdits
  // allowlist, workspace-write + on-request): a fresh install is safe out of
  // the box, per the 2026-07-11 user decision (SPEC §4). "dangerous" launches
  // agents with no human input required — writers use Claude with
  // permissions.defaultMode "bypassPermissions" in its worktree settings,
  // Codex with approval_policy="never" and sandbox_mode="danger-full-access"
  // — while readers keep their read-only boundary and suppress vendor/MCP
  // confirmation prompts. The dial remains available through Workspace's Agents
  // menu and `hive autonomy`, both of which persist here. An absent key means
  // this default; an explicit key always means what it says. The read-only
  // orchestrator and read-only control restarts keep their reduced authority.
  autonomy: z.enum(["dangerous", "sandboxed"]).default("sandboxed"),
  // VESTIGIAL, parsed for compatibility only. These two switches escaped a
  // misbehaving derived router back to the compiled-in table and the compiled
  // manifest — both of which were removed as route sources by the user's
  // directive (2026-07-12): the binary ships no model knowledge, so there is
  // nothing left for either value to revert to. They remain in the schema so a
  // config.toml written for an older build still parses; setting them changes
  // nothing, and the escape from a bad derivation is an explicit model policy,
  // which is user policy and always wins.
  routingManifest: z.enum(["auto", "off"]).default("auto"),
  router: z.enum(["derived", "shipped"]).default("derived"),
  // VESTIGIAL, parsed for compatibility only. The external benchmark ranker
  // (LiveBench) this switch governed was removed entirely (user directive
  // 2026-07-12: no external ranking dependency). Nothing reads this value; it
  // remains in the schema so a config.toml written for an older build still
  // parses.
  benchmarks: z.strictObject({
    mode: z.enum(["live", "shadow", "off"]).default("live"),
  }).prefault({}),
  resources: ResourceLimitsSchema.prefault({}),
  lifecycle: LifecycleConfigSchema.prefault({}),
  memory: z.strictObject({
    retention: MemoryRetentionConfigSchema.prefault({}),
    // HiveMemory HM-3 WP6 (plan D6): the hard token ceiling for the memory
    // delta injected over the send lane when an agent wakes (message
    // delivery or resume). 300 is the ratified default; changes are loud —
    // the daemon logs the effective budget at start.
    wake_budget_tokens: z.number().int().positive().default(300),
  }).prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
export type MemoryRetentionConfig = z.output<typeof MemoryRetentionConfigSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
