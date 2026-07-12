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
  // The routing manifest's kill switch. "auto" lets a *verified* installed
  // manifest supply the candidate lists, falling back to the built-in one when
  // none is installed or one fails to verify. "off" reverts routing to the
  // shipped table entirely — no manifest, and nothing derived from one.
  //
  // It exists because the day the manifest is wrong is the day the user has no
  // patience for editing pins tier by tier, and it is one flag rather than a
  // per-tier retreat for exactly that reason.
  routingManifest: z.enum(["auto", "off"]).default("auto"),
  // The flip itself (design step 5): does the derived router GOVERN live spawns?
  // "derived" (the default) routes every unpinned spawn through manifest ∩
  // discovery, with the fallback ladder beneath it. "shipped" reverts every cell
  // to the compiled-in table, live.
  //
  // This is a SETTING and not a constant on purpose, and the purpose is recent.
  // Tonight we deleted FABLE_AUTO_ROUTING_CUTOFF: a belief frozen into code that
  // could not be changed without a rebuild and went wrong silently. A flip frozen
  // the same way would repeat the mistake with higher stakes — the escape from a
  // misbehaving router must not require the user to rebuild the thing that is
  // misbehaving. Both this switch and `routingManifest` are re-read from
  // config.toml on EVERY spawn (see daemon/routing-resolve.ts), so either one
  // takes effect on the next spawn, with no rebuild and no daemon restart.
  //
  // The two are not redundant. `routingManifest = "off"` disowns the manifest and
  // everything derived from it (including the last-known-good snapshot), which is
  // the hammer for "the manifest is wrong". `router = "shipped"` keeps the
  // manifest — `hive routing` still derives, shadow mode still records — and only
  // stops it governing, which is the hammer for "the ROUTER is wrong". Escaping a
  // bad router should not also blind the instrument that would show why.
  router: z.enum(["derived", "shipped"]).default("derived"),
  resources: ResourceLimitsSchema.prefault({}),
  lifecycle: LifecycleConfigSchema.prefault({}),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
