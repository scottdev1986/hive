// Hive's MCP catalog policy lives here rather than inside 47 handlers. The authenticated role decides which tools are advertised. The handlers still authorize every call because catalog visibility is guidance, not an authority boundary. This layer also gives every structured result a minimal output contract and every tool an explicit risk profile.
import type {
  Icon,
  McpServer,
  ServerContext,
  Tool,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Action,
  type Capability,
  ROLE_GRANTS,
} from "./authorization-service";
import type { ObservabilityService } from "../observability/observability-service";

interface HiveToolPolicy {
  readonly action: Action;
  readonly annotations: ToolAnnotations;
  readonly outputKeys: readonly string[];
  readonly outputSchema: z.ZodType;
}

function structuredOutput(outputKeys: readonly string[]): z.ZodType {
  const structuredValue = z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ]);
  const shape = Object.fromEntries(
    outputKeys.map((outputKey) => [
      outputKey,
      outputKeys.length === 1 ? structuredValue : structuredValue.optional(),
    ]),
  );
  return z
    .object(shape)
    .catchall(z.unknown())
    .describe(`Structured Hive result containing ${outputKeys.join(" or ")}`);
}

function outputKeys(outputKey: string | readonly string[]): readonly string[] {
  return typeof outputKey === "string" ? [outputKey] : outputKey;
}

function readOnly(
  action: Action,
  outputKey: string | readonly string[],
  openWorldHint = false,
): HiveToolPolicy {
  return {
    action,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint,
    },
    outputKeys: outputKeys(outputKey),
    outputSchema: structuredOutput(outputKeys(outputKey)),
  };
}

function additive(
  action: Action,
  outputKey: string | readonly string[],
  options: { idempotent?: boolean; openWorld?: boolean } = {},
): HiveToolPolicy {
  return {
    action,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: options.idempotent ?? false,
      openWorldHint: options.openWorld ?? false,
    },
    outputKeys: outputKeys(outputKey),
    outputSchema: structuredOutput(outputKeys(outputKey)),
  };
}

function destructive(
  action: Action,
  outputKey: string | readonly string[],
  openWorldHint = false,
): HiveToolPolicy {
  return {
    action,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint,
    },
    outputKeys: outputKeys(outputKey),
    outputSchema: structuredOutput(outputKeys(outputKey)),
  };
}

export const HIVE_TOOL_POLICIES = {
  graph_locate: readOnly("status:read", "locate"),
  hive_approvals: readOnly("approval:read", "approvals"),
  hive_approve: destructive("approval:decide", "approval"),
  hive_artifact_get: readOnly("artifact:read", "artifact"),
  hive_artifact_put: additive("artifact:write", "artifact"),
  hive_escalate: additive("message:send", "escalation"),
  hive_grant_issue: destructive("grant:issue", "grant"),
  hive_kill: destructive("agent:kill", "result"),
  hive_knowledge: readOnly("knowledge:read", "knowledge"),
  hive_land: additive("branch:land", "result"),
  hive_mail_claim: additive("message:read", "mail"),
  hive_mail_complete: destructive("message:ack", "mail"),
  hive_mail_poll: readOnly("inbox:read", "mail"),
  hive_mail_publish: additive("message:send", "mail"),
  hive_mail_status: readOnly("inbox:read", "mail"),
  hive_mark_dead: destructive("agent:mark-dead", "agent"),
  hive_models: readOnly("status:read", "inventory", true),
  hive_node_create: additive("node:create", "node"),
  hive_ownership_transfer: destructive(
    "ownership:transfer",
    "ownershipTransfer",
  ),
  hive_pickup_handoff: additive("status:read", "handoff"),
  hive_preserve_branch: additive("agent:kill", "result", {
    idempotent: true,
  }),
  hive_quota_status: readOnly("quota:read", "quotas"),
  // Stewardship over preserved/salvage refs: list is idempotent read-ish but
  // release/keep mutate; keep is additive (meta only), release is destructive
  // at the tool layer when action=release. Catalog risk is the mutation surface.
  hive_salvage: destructive("agent:kill", "result"),
  hive_settlement_decide: destructive("settlement:decide", "decision"),
  hive_settlement_execute: destructive("settlement:execute", "decision"),
  hive_settlement_list: readOnly("status:read", "cases"),
  hive_review_put: additive("review:write", "review"),
  // Idempotent by identity: an instance that already has a live root gets it back rather than a second one.
  hive_run_bootstrap: additive("run:bootstrap", "bootstrap", {
    idempotent: true,
  }),
  hive_run_checkpoint: additive("succession:write", "checkpoint"),
  hive_run_checkpoint_get: readOnly("status:read", "checkpoint"),
  hive_spawn: additive("agent:spawn", "agent", { openWorld: true }),
  hive_spawn_many: additive("agent:spawn", "results", { openWorld: true }),
  hive_status: readOnly("status:read", "agents"),
  hive_succession_attest: destructive("succession:write", "succession"),
  hive_task_create: additive("task:write", "task"),
  // Full TaskDetail (including delegationSpec.objective). Distinct from
  // hive_task_list, which returns compact status-projection summaries only.
  hive_task_get: readOnly("task:read", "task"),
  hive_task_list: readOnly("status:read", "tasks"),
  hive_task_update: destructive("task:write", "task"),
  hive_terminal_observe: readOnly("terminal:observe", "terminalObservation"),
  hive_token_usage: readOnly("token-usage:read", "tokenUsage", true),
  hive_update_status: additive("status:write", "statusReport"),
  memory_delete: destructive("memory:delete", "result"),
  memory_read: readOnly("memory:read", "fact"),
  memory_reindex: additive("memory:write", "result", { idempotent: true }),
  memory_search: readOnly("memory:read", "results"),
  // Additive rather than destructive: it adds a check to an article and rewrites no claim. Idempotent because a second verification on the same day by the same non-author reaches the same state.
  memory_verify: additive("memory:write", "fact", { idempotent: true }),
  memory_write: destructive("memory:write", "fact"),
} as const satisfies Record<string, HiveToolPolicy>;

export type HiveToolName = keyof typeof HIVE_TOOL_POLICIES;

interface HiveToolConfig<InputArgs extends z.ZodType> {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: InputArgs;
  readonly icons?: Icon[];
  readonly _meta?: Record<string, unknown>;
}

/** Registers one capability-scoped Hive tool. Every tool remains callable so a direct forbidden request still receives a Hive authorization denial. Only tools/list is filtered; catalog visibility cannot express subject, epoch, revocation, or one-shot constraints. */
export class HiveToolRegistrar {
  private readonly visibleCatalog: Tool[] = [];

  constructor(
    private readonly server: McpServer,
    private readonly capability: Capability,
    private readonly observability?: Pick<
      ObservabilityService,
      "observeMcpTool"
    >,
  ) {}

  registerTool<InputArgs extends z.ZodType>(
    name: HiveToolName,
    config: HiveToolConfig<InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): void {
    const policy = HIVE_TOOL_POLICIES[name];
    const visible = ROLE_GRANTS[this.capability.role].actions.includes(
      policy.action,
    );
    const guardedCallback = (async (
      args: z.output<InputArgs>,
      context: ServerContext,
    ) => {
      // A request cancelled before dispatch must never begin a mutation. Long read paths also receive this signal for mid-flight checks.
      context.mcpReq.signal.throwIfAborted();
      if (this.observability === undefined) {
        return await callback(args, context);
      }
      return await this.observability.observeMcpTool(
        {
          toolName: name,
          subject: this.capability.subject,
          callId:
            context.mcpReq.id === undefined ? null : String(context.mcpReq.id),
        },
        () => callback(args, context),
      );
    }) as ToolCallback<InputArgs>;
    this.server.registerTool<z.ZodType, InputArgs>(
      name,
      {
        ...config,
        annotations: policy.annotations,
        outputSchema: policy.outputSchema,
      },
      guardedCallback,
    );
    if (visible) {
      const inputSchema = this.server.toolInputSchemaJson(name);
      if (inputSchema === undefined) {
        throw new Error(`Could not advertise input schema for ${name}`);
      }
      this.visibleCatalog.push({
        name,
        ...(config.title === undefined ? {} : { title: config.title }),
        ...(config.description === undefined
          ? {}
          : { description: config.description }),
        inputSchema: inputSchema as Tool["inputSchema"],
        outputSchema: z.toJSONSchema(policy.outputSchema, {
          io: "output",
        }) as Tool["outputSchema"],
        annotations: policy.annotations,
        ...(config.icons === undefined ? {} : { icons: config.icons }),
        ...(config._meta === undefined ? {} : { _meta: config._meta }),
      });
    }
  }

  installRoleScopedCatalog(): void {
    this.server.server.removeRequestHandler("tools/list");
    this.server.server.setRequestHandler("tools/list", () => ({
      tools: [...this.visibleCatalog],
    }));
  }
}
