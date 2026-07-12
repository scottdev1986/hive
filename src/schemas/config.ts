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

export const BenchmarkConfigSchema = z.strictObject({
  // "off" is a hard network and data-use kill switch. No source is registered
  // until the user approves its role; "shadow" permits approved adapters to
  // populate inspection and audit output but can never affect a live route.
  mode: z.enum(["shadow", "off"]).default("shadow"),
});

export const HiveConfigSchema = z.strictObject({
  terminal: z.enum(["iterm2", "terminal", "auto"]).default("auto"),
  headless: z.boolean().default(false),
  layout: z.enum(["auto", "off"]).default("auto"),
  codex: z.strictObject({
    driver: z.enum(["tui", "app-server"]).default("tui"),
  }).default({ driver: "tui" }),
  // Claude Code's Channels research preview. "auto" uses it when the installed
  // CLI is new enough and falls back to tmux injection otherwise; "off" pins
  // every Claude session to the fallback.
  channels: z.enum(["auto", "off"]).default("auto"),
  // Writer-agent autonomy. "sandboxed" (the default) runs writers inside
  // their vendor sandboxes with decision 4's approval queue (acceptEdits
  // allowlist, workspace-write + on-request): a fresh install is safe out of
  // the box, per the 2026-07-11 user decision (SPEC §4). "dangerous" launches
  // writers with no human input required — Claude with
  // permissions.defaultMode "bypassPermissions" in its worktree settings,
  // Codex with approval_policy="never" and sandbox_mode="danger-full-access"
  // — and remains fully available at runtime through the Workspace's Agents
  // menu and `hive autonomy`, both of which persist here. An absent key means
  // this default; an explicit key always means what it says. The read-only
  // orchestrator and read-only control restarts are unaffected by either
  // value.
  autonomy: z.enum(["dangerous", "sandboxed"]).default("sandboxed"),
  // VESTIGIAL, parsed for compatibility only. These two switches escaped a
  // misbehaving derived router back to the compiled-in table and the compiled
  // manifest — both of which were removed as route sources by the user's
  // directive (2026-07-12): the binary ships no model knowledge, so there is
  // nothing left for either value to revert to. They remain in the schema so a
  // config.toml written for an older build still parses; setting them changes
  // nothing, and the escape from a bad derivation is a routing.toml pin, which
  // is user policy and always wins.
  routingManifest: z.enum(["auto", "off"]).default("auto"),
  router: z.enum(["derived", "shipped"]).default("derived"),
  benchmarks: BenchmarkConfigSchema.prefault({}),
  resources: ResourceLimitsSchema.prefault({}),
  lifecycle: LifecycleConfigSchema.prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
