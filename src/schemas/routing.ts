import { z } from "zod";
import { EffortLevelSchema } from "./capability";

export const RoutingTierSchema = z.enum([
  "deep",
  "standard",
  "cheap",
  "review",
]);

export type RoutingTier = z.infer<typeof RoutingTierSchema>;

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

export const DEFAULT_ROUTING: RoutingTable = {
  deep: {
    tool: "claude",
    claude: { model: "best" },
    codex: { model: "default", effort: "high" },
  },
  standard: {
    tool: "codex",
    claude: { model: "sonnet" },
    codex: { model: "default", effort: "medium" },
  },
  cheap: {
    tool: "codex",
    claude: { model: "haiku" },
    codex: { model: "default", effort: "low" },
  },
  review: {
    tool: "claude",
    claude: { model: "sonnet" },
    codex: { model: "default", effort: "medium" },
  },
};

/**
 * The shipped table, with no date in it.
 *
 * It used to carry `FABLE_AUTO_ROUTING_CUTOFF`: on 2026-07-12, deep-tier Claude
 * stopped auto-selecting Fable, because Fable was believed to "move to usage-only
 * billing off the user's plan" on that date. Driving the provider AFTER that date
 * falsified the belief — Fable still sits on a plan-scoped weekly pool with most
 * of it unused, so it costs the user nothing extra and excluding it wasted
 * capacity he already pays for.
 *
 * The constant is gone rather than corrected, because a date was never the right
 * instrument: it is a proxy for a billing fact, and a proxy is wrong silently.
 * What money costs is now MEASURED (`daemon/usage-credits.ts`), and the guard
 * that protects the user's wallet keys on the money, not on a model's name.
 * Fable is an ordinary candidate again: ranked by its own plan pool, gated by
 * capability, downshifted by quota pressure like anything else.
 */
export function defaultRoutingTable(): RoutingTable {
  return DEFAULT_ROUTING;
}
