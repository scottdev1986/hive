import { z } from "zod";
import { EffortLevelSchema } from "./capability";

export const RoutingTierSchema = z.enum([
  "deep",
  "standard",
  "cheap",
  "review",
]);

export type RoutingTier = z.infer<typeof RoutingTierSchema>;

/**
 * What kind of work a tier's spawns do. Structural, not model knowledge: it
 * classifies the TASK, and the capability floor consults it to decide whether
 * evidence of coding ability is required.
 */
export const TaskKindSchema = z.enum([
  "coding",
  "review",
  "research",
  "mechanical",
]);

export type TaskKind = z.infer<typeof TaskKindSchema>;

export function kindRequiresCodingCapability(kind: TaskKind): boolean {
  return kind === "coding" || kind === "review";
}

export function defaultTaskKind(tier: RoutingTier): TaskKind {
  return tier === "review" ? "review" : "coding";
}

const ModelSchema = z.union([z.literal("default"), z.string().min(1)]);

export const ClaudeRouteSchema = z.strictObject({
  model: ModelSchema,
  effort: EffortLevelSchema.optional(),
});

export type ClaudeRoute = z.infer<typeof ClaudeRouteSchema>;

export const CodexRouteSchema = z.strictObject({
  model: ModelSchema,
  effort: EffortLevelSchema.optional(),
});

export type CodexRoute = z.infer<typeof CodexRouteSchema>;

export const RouteSchema = z.strictObject({
  tool: z.enum(["claude", "codex"]),
  claude: ClaudeRouteSchema,
  codex: CodexRouteSchema,
});

export type Route = z.infer<typeof RouteSchema>;

export const RoutingTableSchema = z.record(RoutingTierSchema, RouteSchema);

export type RoutingTable = z.infer<typeof RoutingTableSchema>;

/**
 * There is no shipped routing table, and that is the design, not an omission.
 *
 * `DEFAULT_ROUTING` used to live here: a compiled-in table naming `best`,
 * `sonnet`, `haiku`, `default` — predetermined model knowledge frozen at build
 * time, exactly the thing SPEC §6 opens by distrusting. The user's directive
 * (2026-07-12) removed it as a route source outright: the binary names no
 * model. Routes derive from live discovery, the user's own `routing.toml`, and
 * the benchmark surface once he activates it — and where none of those can
 * author a route, Hive REFUSES loudly and names the vendor CLI it needs,
 * because a baked-in guess that still parses is not a route, it is a lie with
 * good posture. The `Route` shapes above survive for what remains honest: the
 * user's pins, and the concrete launch decisions derived at spawn time.
 */
