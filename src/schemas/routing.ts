import { z } from "zod";

export const RoutingTierSchema = z.enum([
  "deep",
  "standard",
  "cheap",
  "review",
]);

export type RoutingTier = z.infer<typeof RoutingTierSchema>;

export const RouteSchema = z.object({
  tool: z.enum(["claude", "codex"]),
  model: z.union([z.literal("default"), z.string().min(1)]),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
});

export type Route = z.infer<typeof RouteSchema>;

export const RoutingTableSchema = z.record(RoutingTierSchema, RouteSchema);

export type RoutingTable = z.infer<typeof RoutingTableSchema>;

export const DEFAULT_ROUTING: RoutingTable = {
  deep: { tool: "claude", model: "opus", effort: "high" },
  standard: { tool: "codex", model: "default", effort: "medium" },
  cheap: { tool: "codex", model: "default", effort: "low" },
  review: { tool: "claude", model: "sonnet", effort: "medium" },
};
