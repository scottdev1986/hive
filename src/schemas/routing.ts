import { z } from "zod";

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
});

export type ClaudeRoute = z.infer<typeof ClaudeRouteSchema>;

export const CodexRouteSchema = z.strictObject({
  model: ModelSchema,
  effort: z.enum([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]).optional(),
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

// Fable draws heavy shared capacity and moves to usage-only billing off the
// user's plan on this date. Before this instant, default routing keeps
// resolving the deep tier's "best" alias to Fable (see CLAUDE_BEST_MODEL in
// adapters/tools/models.ts). On/after this instant, default routing stops
// auto-selecting Fable — nothing is removed: explicit selection (pinning
// "best" or "claude-fable-5" in routing.toml) keeps working forever, and
// quota pressure can already route a deep-tier Claude spawn to Opus 4.8
// before this date too. UTC boundary, matching this codebase's other
// date handling defaults.
export const FABLE_AUTO_ROUTING_CUTOFF = "2026-07-12T00:00:00Z";

// Duplicated from CLAUDE_OPUS_MODEL in adapters/tools/models.ts rather than
// imported: schemas has no dependency on the adapters layer. A models.test.ts
// check cross-verifies the two stay equal.
const POST_FABLE_CUTOFF_DEEP_MODEL = "claude-opus-4-8";

const POST_FABLE_CUTOFF_ROUTING: RoutingTable = {
  ...DEFAULT_ROUTING,
  deep: {
    ...DEFAULT_ROUTING.deep,
    claude: { model: POST_FABLE_CUTOFF_DEEP_MODEL },
  },
};

export function defaultRoutingTable(now: Date): RoutingTable {
  return now.getTime() >= Date.parse(FABLE_AUTO_ROUTING_CUTOFF)
    ? POST_FABLE_CUTOFF_ROUTING
    : DEFAULT_ROUTING;
}
