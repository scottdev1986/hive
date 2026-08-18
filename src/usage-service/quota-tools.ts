import type { HiveToolRegistrar } from "../daemon/authorization/mcp-tool-policy";
import { z } from "zod";
import { formatlessString } from "../schemas/wire-schema";
import { QuotaObservationSchema } from "../schemas/quota";
import type { Action, Capability } from "../schemas/authority";
import type { ModelInventory } from "../daemon/provider-capabilities/model-inventory";
import type { QuotaService } from "./usage-quota";
import type { TokenUsageStore } from "./token-usage";
import { toolResult } from "../shared/mcp-tool-result";

export const QuotaObservationRequestSchema = QuotaObservationSchema.omit({
  observedAt: true,
}).extend({
  observedAt: formatlessString(z.iso.datetime({ offset: true })).optional(),
});

export interface QuotaToolDeps {
  quota: QuotaService | undefined;
  tokenUsage: TokenUsageStore;
  modelInventory: (() => Promise<ModelInventory>) | undefined;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

export function registerQuotaTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: QuotaToolDeps,
): void {
  server.registerTool(
    "hive_quota_status",
    {
      title: "Hive quota status",
      description:
        "Show configured provider/account/model-pool capacity, reservations, telemetry confidence, freshness, and reset estimates.",
      inputSchema: z.object({}),
    },
    async () => {
      deps.authorizeTool(
        capability,
        "hive_quota_status",
        "quota:read",
        undefined,
        false,
      );
      return toolResult(deps.quota?.statuses() ?? [], "quotas");
    },
  );

  server.registerTool(
    "hive_token_usage",
    {
      title: "Hive token usage",
      description:
        "Show provider-reported input/output token totals by Hive session, with exact orchestrator control usage separated from mixed worker-session usage.",
      inputSchema: z.object({
        repoRoot: z.string().min(1).optional(),
      }),
    },
    async ({ repoRoot }) => {
      deps.authorizeTool(
        capability,
        "hive_token_usage",
        "token-usage:read",
        undefined,
        false,
      );
      return toolResult(await deps.tokenUsage.snapshot(repoRoot), "tokenUsage");
    },
  );

  server.registerTool(
    "hive_models",
    {
      title: "Hive model inventory",
      description:
        "List every model discovered from Claude Code, Codex, Grok, Kimi Code, and OpenCode, including hidden and unrouted models, with effort levels, plan status, routing roles, and when Hive would use each one.",
      inputSchema: z.object({}),
    },
    async () => {
      deps.authorizeTool(
        capability,
        "hive_models",
        "status:read",
        undefined,
        false,
      );
      if (deps.modelInventory === undefined) {
        throw new Error("Live model inventory is unavailable");
      }
      return toolResult(await deps.modelInventory(), "inventory");
    },
  );
}
