import { z } from "zod";

// Defaults sized against the 2026-07-10 OOM incident: the runaway test
// processes that took the machine down crossed 12 GB within their first
// minute, while no legitimate hive workload (agent CLIs, test suites,
// typechecks) has been observed above ~2 GB. The floor keeps enough headroom
// that the daemon, the orchestrator, and macOS itself stay responsive while
// hive refuses to add load.
export const ResourceLimitsSchema = z.object({
  enabled: z.boolean().default(true),
  perProcessMemoryMb: z.number().int().positive().default(12_288),
  minSystemAvailableMb: z.number().int().positive().default(4_096),
});

export const HiveConfigSchema = z.object({
  terminal: z.enum(["iterm2", "terminal", "auto"]).default("auto"),
  headless: z.boolean().default(false),
  layout: z.enum(["auto", "off"]).default("auto"),
  codex: z.object({
    driver: z.enum(["tui", "app-server"]).default("tui"),
  }).default({ driver: "tui" }),
  // Claude Code's Channels research preview. "auto" uses it when the installed
  // CLI is new enough and falls back to tmux injection otherwise; "off" pins
  // every Claude session to the fallback.
  channels: z.enum(["auto", "off"]).default("auto"),
  resources: ResourceLimitsSchema.prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
