import { z } from "zod";
import type { DatabaseHost } from "../../shared/database-host";
import { type Approval, ApprovalSchema } from "../../schemas/approval";
import type { AuditRow } from "../../schemas/audit";
import {
  type Hv1CapabilityRecord,
  Hv1CapabilityRecordSchema,
} from "../../schemas/capability";
import { type Escalation, EscalationSchema } from "../../schemas/escalation";

const StoredCapabilityRowSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  role: z
    .enum(["user", "orchestrator", "writer", "reader", "operator"])
    .transform((role) => (role === "operator" ? "user" : role)),
  epoch: z.number().int().nonnegative(),
  constraints: z.string().nullable(),
  subjects: z.string().nullable(),
  secretHash: z.string().min(1),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().nullable(),
});

export type CapabilityRow = Hv1CapabilityRecord;

function parseCapabilityRow(row: unknown): {
  capability: CapabilityRow;
  secretHash: string;
} {
  const stored = StoredCapabilityRowSchema.parse(row);
  // Pre-rename role/scope strings still live in durable rows until the next remint.
  let constraints: { content?: true; scope?: "user" } | undefined;
  if (stored.constraints !== null) {
    const parsed = JSON.parse(stored.constraints) as {
      content?: true;
      scope?: string;
    };
    constraints = {
      ...(parsed.content === true ? { content: true as const } : {}),
      ...(parsed.scope === "user" || parsed.scope === "operator"
        ? { scope: "user" as const }
        : {}),
    };
    if (Object.keys(constraints).length === 0) constraints = undefined;
  }
  return {
    capability: Hv1CapabilityRecordSchema.parse({
      id: stored.id,
      subject: stored.subject,
      role: stored.role,
      epoch: stored.epoch,
      ...(constraints === undefined ? {} : { constraints }),
      ...(stored.subjects === null
        ? {}
        : { subjects: JSON.parse(stored.subjects) }),
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
      revokedAt: stored.revokedAt,
    }),
    secretHash: stored.secretHash,
  };
}

export class AccessStore {
  constructor(private readonly host: DatabaseHost) {}

  private get database() {
    return this.host.database;
  }

  insertCapability(capability: CapabilityRow, secretHash: string): void {
    this.database
      .query(
        `
      INSERT INTO capabilities (
        id, subject, role, epoch, constraints, subjects, secretHash,
        issuedAt, expiresAt, revokedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        capability.id,
        capability.subject,
        capability.role,
        capability.epoch,
        capability.constraints === undefined
          ? null
          : JSON.stringify(capability.constraints),
        !("subjects" in capability) || capability.subjects === undefined
          ? null
          : JSON.stringify(capability.subjects),
        secretHash,
        capability.issuedAt,
        capability.expiresAt,
        capability.revokedAt,
      );
  }

  getCapability(
    id: string,
  ): { capability: CapabilityRow; secretHash: string } | null {
    const row = this.database
      .query("SELECT * FROM capabilities WHERE id = ?")
      .get(id);
    return row === null ? null : parseCapabilityRow(row);
  }

  consumeOneShot(
    capabilityId: string,
    action: string,
    consumedAt: string,
  ): boolean {
    const result = this.database
      .query(
        `
      INSERT OR IGNORE INTO capability_consumptions (
        capabilityId, action, consumedAt
      ) VALUES (?, ?, ?)
    `,
      )
      .run(capabilityId, action, consumedAt);
    return result.changes === 1;
  }

  releaseOneShot(capabilityId: string, action: string): void {
    this.database
      .query(
        `
      DELETE FROM capability_consumptions
      WHERE capabilityId = ? AND action = ?
    `,
      )
      .run(capabilityId, action);
  }

  releaseOneShotForSubject(subject: string, action: string): number {
    return this.database
      .query(
        `
      DELETE FROM capability_consumptions
      WHERE action = ? AND capabilityId IN (
        SELECT id FROM capabilities WHERE subject = ? AND revokedAt IS NULL
      )
    `,
      )
      .run(action, subject).changes;
  }

  isOneShotConsumed(capabilityId: string, action: string): boolean {
    return (
      this.database
        .query(
          `
      SELECT 1 AS present FROM capability_consumptions
      WHERE capabilityId = ? AND action = ?
    `,
        )
        .get(capabilityId, action) !== null
    );
  }

  revokeCapabilitiesForSubject(subject: string, timestamp: string): number {
    return this.database
      .query(
        `
      UPDATE capabilities SET revokedAt = ?
      WHERE subject = ? AND revokedAt IS NULL
    `,
      )
      .run(timestamp, subject).changes;
  }

  insertAuditEntry(entry: AuditRow): void {
    this.database
      .query(
        `
      INSERT INTO audit_log (
        at, route, action, callerSubject, callerRole, capabilityId,
        requestedSubject, epoch, decision, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        entry.at,
        entry.route,
        entry.action,
        entry.callerSubject,
        entry.callerRole,
        entry.capabilityId,
        entry.requestedSubject,
        entry.epoch,
        entry.decision,
        entry.reason,
      );
  }

  countAuditEntries(
    callerSubject: string,
    action: string,
    reason: string,
  ): number {
    const row = z.object({ total: z.number() }).parse(
      this.database
        .query(
          `
        SELECT COUNT(*) AS total FROM audit_log
        WHERE callerSubject = ? AND action = ? AND reason = ?
      `,
        )
        .get(callerSubject, action, reason),
    );
    return row.total;
  }

  insertApproval(approval: z.input<typeof ApprovalSchema>): Approval {
    const value = ApprovalSchema.parse(approval);
    this.database
      .query(
        `
      INSERT INTO approvals (
        id, agentName, kind, description, status, createdAt, resolvedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        value.id,
        value.agentName,
        value.kind,
        value.description,
        value.status,
        value.createdAt,
        value.resolvedAt,
      );
    const stored = this.getApproval(value.id);
    if (stored === null) {
      throw new Error(`Approval disappeared after insert: ${value.id}`);
    }
    return stored;
  }

  getApproval(id: string): Approval | null {
    const row = this.database
      .query("SELECT * FROM approvals WHERE id = ?")
      .get(id);
    return row === null ? null : ApprovalSchema.parse(row);
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows =
      status === undefined
        ? this.database
            .query("SELECT * FROM approvals ORDER BY createdAt, id")
            .all()
        : this.database
            .query(
              "SELECT * FROM approvals WHERE status = ? ORDER BY createdAt, id",
            )
            .all(status);
    return rows.map((row) => ApprovalSchema.parse(row));
  }

  insertEscalation(escalation: Escalation): Escalation {
    const value = EscalationSchema.parse(escalation);
    this.database
      .query(
        `
      INSERT INTO escalations (
        id, agentId, agentName, model, category, reason, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        value.id,
        value.agentId,
        value.agentName,
        value.model,
        value.category,
        value.reason,
        value.createdAt,
      );
    return value;
  }

  listEscalations(): Escalation[] {
    return this.database
      .query("SELECT * FROM escalations ORDER BY createdAt, id")
      .all()
      .map((row) => EscalationSchema.parse(row));
  }

  countEscalationsForAgent(agentId: string): number {
    const row = this.database
      .query("SELECT COUNT(*) AS count FROM escalations WHERE agentId = ?")
      .get(agentId) as { count: number };
    return row.count;
  }

  resolveApproval(
    id: string,
    status: "approved" | "denied",
    resolvedAt: string,
  ): Approval | null {
    const result = this.database
      .query(
        `
      UPDATE approvals SET status = ?, resolvedAt = ?
      WHERE id = ? AND status = 'pending'
    `,
      )
      .run(status, resolvedAt, id);
    return result.changes === 0 ? null : this.getApproval(id);
  }

  staleApproval(id: string, resolvedAt: string): Approval | null {
    const result = this.database
      .query(
        `
      UPDATE approvals SET status = 'stale', resolvedAt = ?
      WHERE id = ? AND status = 'pending'
    `,
      )
      .run(resolvedAt, id);
    return result.changes === 0 ? null : this.getApproval(id);
  }

  stalePendingToolApprovals(agentName: string, resolvedAt: string): number {
    return this.database
      .query(
        `
      UPDATE approvals SET status = 'stale', resolvedAt = ?
      WHERE agentName = ? AND kind = 'tool-permission' AND status = 'pending'
    `,
      )
      .run(resolvedAt, agentName).changes;
  }
}
