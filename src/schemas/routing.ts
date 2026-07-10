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
