import { z } from "zod";
import { definedFields } from "../../shared/defined-fields";
import type { DatabaseHost } from "../../shared/database-host";
import { type HookEvent, HookEventSchema } from "../../schemas/event";
import type { OrchestratorSignalKind } from "../status-service/status-service";

function parseEventRow(row: unknown): HookEvent {
  const value = z
    .object({
      kind: z.string(),
      agentName: z.string(),
      timestamp: z.string(),
      contextPct: z.number().nullable(),
      description: z.string().nullable(),
      usageUnits: z.number().nullable(),
      usageSource: z.string().nullable(),
    })
    .parse(row);

  if (value.kind === "turn-end") {
    return HookEventSchema.parse({
      kind: value.kind,
      agentName: value.agentName,
      timestamp: value.timestamp,
      ...definedFields({
        contextPct: value.contextPct === null ? undefined : value.contextPct,
        usageUnits: value.usageUnits === null ? undefined : value.usageUnits,
        usageSource: value.usageSource === null ? undefined : value.usageSource,
      }),
    });
  }
  if (value.kind === "approval-request" || value.kind === "effort-drift") {
    return HookEventSchema.parse({
      kind: value.kind,
      agentName: value.agentName,
      timestamp: value.timestamp,
      description: value.description,
    });
  }
  return HookEventSchema.parse({
    kind: value.kind,
    agentName: value.agentName,
    timestamp: value.timestamp,
  });
}

export class EventStore {
  constructor(private readonly host: DatabaseHost) {}

  private get database() {
    return this.host.database;
  }

  latestSafePointAt(agentName: string): string | null {
    const row = this.database
      .query(
        `
      SELECT MAX(timestamp) AS value FROM events
      WHERE agentName = ? AND kind IN ('turn-end', 'session-start')
    `,
      )
      .get(agentName) as { value: string | null };
    return row.value;
  }

  latestTurnBoundaryAt(agentName: string): string | null {
    const row = this.database
      .query(
        `
      SELECT MAX(timestamp) AS value FROM events
      WHERE agentName = ? AND kind IN ('turn-start', 'turn-end')
    `,
      )
      .get(agentName) as { value: string | null };
    return row.value;
  }

  latestTurnBoundary(
    agentName: string,
  ): { timestamp: string; kind: "turn-start" | "turn-end" } | null {
    return this.database
      .query(
        `
      SELECT timestamp, kind FROM events
      WHERE agentName = ? AND kind IN ('turn-start', 'turn-end')
      ORDER BY timestamp DESC, rowid DESC LIMIT 1
    `,
      )
      .get(agentName) as {
      timestamp: string;
      kind: "turn-start" | "turn-end";
    } | null;
  }

  recentOrchestratorSignals(
    agentName: string,
    limit = 2,
  ): OrchestratorSignalKind[] {
    const rows = this.database
      .query(
        `
      SELECT kind FROM events
      WHERE agentName = ? AND kind IN ('session-launch', 'session-start', 'session-end', 'turn-start', 'turn-end')
      ORDER BY timestamp DESC, rowid DESC LIMIT ?
    `,
      )
      .all(agentName, limit) as Array<{ kind: OrchestratorSignalKind }>;
    return rows.map((row) => row.kind);
  }

  latestEventAt(agentName: string): string | null {
    const row = this.database
      .query(
        `
      SELECT MAX(timestamp) AS value FROM events
      WHERE agentName = ?
    `,
      )
      .get(agentName) as { value: string | null };
    return row.value;
  }

  insertEvent(event: HookEvent): HookEvent {
    const value = HookEventSchema.parse(event);
    this.database
      .query(
        `
      INSERT INTO events (
        kind, agentName, timestamp, contextPct, description,
        usageUnits, usageSource
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        value.kind,
        value.agentName,
        value.timestamp,
        value.kind === "turn-end" ? (value.contextPct ?? null) : null,
        value.kind === "approval-request" || value.kind === "effort-drift"
          ? value.description
          : null,
        value.kind === "turn-end" ? (value.usageUnits ?? null) : null,
        value.kind === "turn-end" ? (value.usageSource ?? null) : null,
      );
    return value;
  }

  listEvents(agentName?: string): HookEvent[] {
    const rows =
      agentName === undefined
        ? this.database
            .query(
              `
          SELECT kind, agentName, timestamp, contextPct, description,
                 usageUnits, usageSource
          FROM events ORDER BY id
        `,
            )
            .all()
        : this.database
            .query(
              `
          SELECT kind, agentName, timestamp, contextPct, description,
                 usageUnits, usageSource
          FROM events WHERE agentName = ? ORDER BY id
        `,
            )
            .all(agentName);
    return rows.map(parseEventRow);
  }
}
