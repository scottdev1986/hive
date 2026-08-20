import { z } from "zod";
import { getHiveHome, hiveInstanceSuffix } from "../../hive-home/home";
import {
  type AgentRecord,
  AgentRecordObjectSchema,
  AgentRecordSchema,
  ExecutionIdentitySchema,
  isTerminalAgentStatus,
} from "../../schemas/agent";
import type { DatabaseHost } from "../../shared/database-host";
import { mintSessionLocator } from "../session-host/locators";
import type { RuntimeStore } from "./runtime-store";

const AgentDatabaseRowSchema = AgentRecordObjectSchema.extend({
  sessionLocator: z.string().min(1),
  closedAt: z.string().nullable(),
  holdReason: z.string().nullable().default(null),
  holdResetAt: z.string().nullable().default(null),
  holdProviderRunId: z.string().nullable().default(null),
  liveModel: z.string().nullable().default(null),
  quotaReservationId: z.string().nullable(),
  controlQuotaReservationId: z.string().nullable(),
  controlMessageId: z.string().nullable(),
  executionIdentity: z.string().nullable(),
  toolSessionId: z.string().nullable(),
  landedCommit: z.string().nullable(),
  landedAt: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable().default(null),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  readOnly: z.union([z.boolean(), z.number().int()]).default(0),
  writeRevoked: z.union([z.boolean(), z.number().int()]).default(0),
});

function parseAgentRow(row: unknown): AgentRecord {
  const value = AgentDatabaseRowSchema.parse(row);
  return AgentRecordSchema.parse({
    ...value,
    closedAt: value.closedAt ?? undefined,
    liveModel: value.liveModel ?? undefined,
    quotaReservationId: value.quotaReservationId ?? undefined,
    controlQuotaReservationId: value.controlQuotaReservationId ?? undefined,
    controlMessageId: value.controlMessageId ?? undefined,
    toolSessionId: value.toolSessionId ?? undefined,
    landedCommit: value.landedCommit ?? undefined,
    landedAt: value.landedAt ?? undefined,
    sessionLocator: JSON.parse(value.sessionLocator),
    contextWindow: value.contextWindow ?? undefined,
    executionIdentity:
      value.executionIdentity === null
        ? undefined
        : ExecutionIdentitySchema.parse(JSON.parse(value.executionIdentity)),
    readOnly: value.readOnly === true || value.readOnly === 1,
    writeRevoked: value.writeRevoked === true || value.writeRevoked === 1,
  });
}

/** Persistence for agents and spawn-name reservations. */
export class AgentStore {
  constructor(
    private readonly host: DatabaseHost,
    private readonly runtime: RuntimeStore,
  ) {}

  private get database() {
    return this.host.database;
  }

  private transaction<T>(operation: () => T): T {
    return this.host.transaction(operation);
  }

  upsertAgent(agent: AgentRecord): AgentRecord {
    const parsed = AgentRecordSchema.parse(agent);
    const existingLocator = this.database
      .query("SELECT sessionLocator FROM agents WHERE id = ?")
      .get(parsed.id) as { sessionLocator: string | null } | null;
    const value =
      parsed.sessionLocator === undefined
        ? AgentRecordSchema.parse({
            ...parsed,
            sessionLocator: existingLocator?.sessionLocator
              ? JSON.parse(existingLocator.sessionLocator)
              : mintSessionLocator(
                  hiveInstanceSuffix(getHiveHome()),
                  { kind: "agent", agentId: parsed.id },
                  1,
                  "unbound",
                ),
          })
        : parsed;
    const closedAt = this.resolveClosedAt(value);
    this.database
      .query(
        `
      INSERT INTO agents (
        id, name, tool, model, liveModel, category, status, taskDescription,
        worktreePath, branch, sessionLocator, contextPct,
        createdAt, lastEventAt, landedCommit, landedAt,
        quotaReservationId, controlQuotaReservationId, controlMessageId,
        executionIdentity, toolSessionId, contextWindow,
        capabilityEpoch, readOnly, writeRevoked, closedAt, holdReason, holdResetAt,
        holdProviderRunId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tool = excluded.tool,
        model = excluded.model,
        liveModel = excluded.liveModel,
        category = excluded.category,
        status = excluded.status,
        taskDescription = excluded.taskDescription,
        worktreePath = excluded.worktreePath,
        branch = excluded.branch,
        sessionLocator = excluded.sessionLocator,
        contextPct = excluded.contextPct,
        createdAt = excluded.createdAt,
        lastEventAt = excluded.lastEventAt,
        landedCommit = excluded.landedCommit,
        landedAt = excluded.landedAt,
        quotaReservationId = excluded.quotaReservationId,
        controlQuotaReservationId = excluded.controlQuotaReservationId,
        controlMessageId = excluded.controlMessageId,
        executionIdentity = excluded.executionIdentity,
        toolSessionId = excluded.toolSessionId,
        contextWindow = excluded.contextWindow,
        capabilityEpoch = excluded.capabilityEpoch,
        readOnly = excluded.readOnly,
        writeRevoked = excluded.writeRevoked,
        closedAt = excluded.closedAt,
        holdReason = excluded.holdReason,
        holdResetAt = excluded.holdResetAt,
        holdProviderRunId = excluded.holdProviderRunId
    `,
      )
      .run(
        value.id,
        value.name,
        value.tool,
        value.model,
        value.liveModel ?? null,
        value.category,
        value.status,
        value.taskDescription,
        value.worktreePath,
        value.branch,
        JSON.stringify(value.sessionLocator),
        value.contextPct,
        value.createdAt,
        value.lastEventAt,
        value.landedCommit ?? null,
        value.landedAt ?? null,
        value.quotaReservationId ?? null,
        value.controlQuotaReservationId ?? null,
        value.controlMessageId ?? null,
        value.executionIdentity === undefined
          ? null
          : JSON.stringify(value.executionIdentity),
        value.toolSessionId ?? null,
        value.contextWindow ?? null,
        value.capabilityEpoch,
        value.readOnly ? 1 : 0,
        value.writeRevoked ? 1 : 0,
        closedAt,
        value.holdReason ?? null,
        value.holdResetAt ?? null,
        value.holdProviderRunId ?? null,
      );
    const result = this.getAgentById(value.id);
    if (result === null) {
      throw new Error(`Agent disappeared after upsert: ${value.id}`);
    }
    return result;
  }

  private resolveClosedAt(value: AgentRecord): string | null {
    if (!isTerminalAgentStatus(value.status)) return null;
    if (value.closedAt !== undefined) return value.closedAt;
    const existing = this.database
      .query("SELECT closedAt FROM agents WHERE id = ?")
      .get(value.id) as { closedAt: string | null } | null;
    return existing?.closedAt ?? value.lastEventAt;
  }

  insertAgent(agent: AgentRecord): AgentRecord {
    return this.upsertAgent(agent);
  }

  discardSpawn(
    agentId: string,
    terminalDisposition: "never-created" | "verified-stopped",
  ): boolean {
    return this.transaction(() => {
      const current = this.getAgentById(agentId);
      if (current === null) return true;
      if (current.status !== "dead") return false;
      const locator = current.sessionLocator;
      if (locator?.hostKind === "sessiond") {
        const binding = this.runtime.getTerminalHostBindingByLocator({
          ...locator,
          hostKind: "sessiond",
        });
        if (
          binding?.createEvidence !== undefined &&
          terminalDisposition !== "verified-stopped"
        ) {
          return false;
        }
        this.database
          .query(
            `
          DELETE FROM terminal_host_bindings
          WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
        `,
          )
          .run(locator.instanceId, locator.sessionId, locator.generation);
      }
      return (
        this.database.query("DELETE FROM agents WHERE id = ?").run(agentId)
          .changes > 0
      );
    });
  }

  markAgentDead(agentId: string, timestamp: string): AgentRecord | null {
    return this.transaction(() => {
      const current = this.getAgentById(agentId);
      if (current === null) return null;
      return this.upsertAgent({
        ...current,
        status: "dead",
        lastEventAt: timestamp,
      });
    });
  }

  getAgentById(id: string): AgentRecord | null {
    const row = this.database
      .query("SELECT * FROM agents WHERE id = ?")
      .get(id);
    return row === null ? null : parseAgentRow(row);
  }

  getAgentByName(name: string): AgentRecord | null {
    const row = this.database
      .query(
        `
      SELECT * FROM agents WHERE name = ?
      ORDER BY (status IN ('done', 'dead')) ASC, createdAt DESC
      LIMIT 1
    `,
      )
      .get(name);
    return row === null ? null : parseAgentRow(row);
  }

  getLiveAgentByName(name: string): AgentRecord | null {
    const row = this.database
      .query(
        `
      SELECT * FROM agents
      WHERE name = ? AND status NOT IN ('done', 'dead')
      LIMIT 1
    `,
      )
      .get(name);
    return row === null ? null : parseAgentRow(row);
  }

  listAgents(): AgentRecord[] {
    return this.database
      .query("SELECT * FROM agents ORDER BY createdAt, name")
      .all()
      .map(parseAgentRow);
  }

  reserveAgentName(
    name: string,
    createdAt = new Date().toISOString(),
  ): boolean {
    return (
      this.database
        .query(
          `
      INSERT OR IGNORE INTO agent_name_reservations (name, createdAt)
      VALUES (?, ?)
    `,
        )
        .run(name, createdAt).changes === 1
    );
  }

  isAgentNameReserved(name: string): boolean {
    return (
      this.database
        .query("SELECT 1 FROM agent_name_reservations WHERE name = ?")
        .get(name) !== null
    );
  }

  releaseAgentName(name: string): boolean {
    return (
      this.database
        .query("DELETE FROM agent_name_reservations WHERE name = ?")
        .run(name).changes === 1
    );
  }

  clearAgentNameReservations(): number {
    return this.database.query("DELETE FROM agent_name_reservations").run()
      .changes;
  }

  revokeAgentCapabilities(name: string, timestamp: string): AgentRecord | null {
    return this.transaction(() => {
      this.database
        .query(
          `
        UPDATE agents SET capabilityEpoch = capabilityEpoch + 1,
          writeRevoked = 1, status = 'control-paused', lastEventAt = ?
        WHERE name = ? AND status NOT IN ('dead', 'done', 'failed')
      `,
        )
        .run(timestamp, name);
      this.database
        .query(
          `
        UPDATE approvals SET status = 'denied', resolvedAt = ?
        WHERE agentName = ? AND status = 'pending'
      `,
        )
        .run(timestamp, name);
      return this.getAgentByName(name);
    });
  }
}
