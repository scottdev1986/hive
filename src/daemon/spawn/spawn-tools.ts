import type { AgentRecord } from "../../schemas/agent";
import { toolResult } from "../../shared/mcp-tool-result";
import type {
  Action,
  Capability,
} from "../authorization/authorization-service";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import { compactSpawnResult } from "../orchestrator-host/orchestrator-projections";
import {
  type SpawnBatchRequest,
  SpawnBatchRequestSchema,
  type SpawnRequest,
  SpawnRequestSchema,
} from "./spawn-service";

export interface SpawnToolDependencies {
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  spawnAgent: (request: SpawnRequest) => Promise<AgentRecord>;
}

export function registerSpawnTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: SpawnToolDependencies,
): void {
  server.registerTool(
    "hive_spawn",
    {
      title: "Spawn Hive agent",
      description:
        "Start a new Hive agent for a delegated task. Supply the task's " +
        "category; the user's routing policy chain for that category decides " +
        "the model, and the first enabled link that clears the launch gate " +
        "runs. Hive selects and reserves the agent's name; callers cannot " +
        "supply one. Category choice and reuse-vs-spawn are decisions, covered in " +
        "hive_knowledge topic=dispatch, not this schema. Optional: tool/model " +
        "pin an explicit user choice (never substituted); effort overrides " +
        "the link's. The admitted agent returns immediately with " +
        "status=spawning while provider startup is verified in the " +
        "background. For two or more independent tasks, use hive_spawn_many. " +
        "Returns identity and state, not the task brief you just wrote — " +
        "taskDescription comes back truncated (taskDescriptionLength carries " +
        "the full count); read it in full via hive_status if ever needed.",
      inputSchema: SpawnRequestSchema,
    },
    async (request: SpawnRequest) => {
      deps.authorizeTool(capability, "hive_spawn", "agent:spawn");
      return toolResult(
        compactSpawnResult(await deps.spawnAgent(request)),
        "agent",
      );
    },
  );

  server.registerTool(
    "hive_spawn_many",
    {
      title: "Spawn multiple Hive agents",
      description:
        "Admit 1–32 independent Hive agents concurrently. Each returns " +
        "immediately with status=spawning while provider startup and readiness " +
        "verification continue in the background. Results are independent, so " +
        "one refused request does not hide agents already admitted. Use one " +
        "request per non-overlapping delegated task. Hive selects and reserves " +
        "every agent name; callers cannot supply them.",
      inputSchema: SpawnBatchRequestSchema,
    },
    async ({ requests }: SpawnBatchRequest) => {
      deps.authorizeTool(capability, "hive_spawn_many", "agent:spawn");
      const results = await Promise.all(
        requests.map(async (request) => {
          try {
            return {
              ok: true as const,
              agent: compactSpawnResult(await deps.spawnAgent(request)),
            };
          } catch (error) {
            return {
              ok: false as const,
              error:
                error instanceof Error ? error.message : "Agent spawn failed",
            };
          }
        }),
      );
      return toolResult(results, "results");
    },
  );
}
