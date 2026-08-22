import type { DatabaseHost } from "../shared/database-host";
import type { CapabilityProvider } from "../schemas/capability";
import type { RoutingCategory } from "../schemas/routing-policy";

export interface LaunchDecision {
  decisionId: string;
  requestId: string;
  policyRevision: number;
  routeDigest: string | null;
  category: RoutingCategory;
  provider: CapabilityProvider;
  model: string;
  effort: string | null;
  reason: "explicit" | "user-weight" | "hive-equal";
  selectedAt: string;
}

export interface RoutingBalanceRow {
  candidateKey: string;
  current: number;
}

export class RoutingDecisionStore {
  constructor(private readonly host: Pick<DatabaseHost, "database">) {
    host.database.exec(`
      CREATE TABLE IF NOT EXISTS launch_decisions (
        decisionId TEXT PRIMARY KEY,
        requestId TEXT NOT NULL,
        policyRevision INTEGER NOT NULL,
        routeDigest TEXT,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        reason TEXT NOT NULL,
        selectedAt TEXT NOT NULL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS launch_decisions_request
        ON launch_decisions (requestId);
      CREATE TABLE IF NOT EXISTS routing_balance (
        routeDigest TEXT NOT NULL,
        candidateKey TEXT NOT NULL,
        current REAL NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (routeDigest, candidateKey)
      );
    `);
  }

  immediate<T>(operation: () => T): T {
    return this.host.database.transaction(operation).immediate();
  }

  recordLaunchResult(
    decisionId: string,
    result: "started" | "launch-failed",
  ): void {
    this.host.database.run(
      "UPDATE launch_decisions SET result = ? WHERE decisionId = ?",
      [result, decisionId],
    );
  }

  balanceRows(digest: string): RoutingBalanceRow[] {
    // SAFETY: The surrounding code already established this contract.
    return this.host.database
      .query(
        "SELECT candidateKey, current FROM routing_balance WHERE routeDigest = ?",
      )
      .all(digest) as RoutingBalanceRow[];
  }

  writeBalance(
    digest: string,
    candidateKey: string,
    current: number,
    updatedAt: string,
  ): void {
    this.host.database.run(
      `INSERT INTO routing_balance (routeDigest, candidateKey, current, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(routeDigest, candidateKey) DO UPDATE SET
         current = excluded.current,
         updatedAt = excluded.updatedAt`,
      [digest, candidateKey, current, updatedAt],
    );
  }

  decisionForRequest(requestId: string): LaunchDecision | null {
    // SAFETY: The surrounding code already established this contract.
    const row = this.host.database
      .query(
        `SELECT * FROM launch_decisions
         WHERE requestId = ? AND (result IS NULL OR result = 'started')
         ORDER BY selectedAt DESC LIMIT 1`,
      )
      .get(requestId) as
      | (Omit<LaunchDecision, "routeDigest" | "effort"> & {
          routeDigest: string | null;
          effort: string | null;
          result: string | null;
        })
      | null;
    if (row === null) return null;
    const { result: _result, ...decision } = row;
    // SAFETY: The surrounding code already established this contract.
    return decision as LaunchDecision;
  }

  insertDecision(decision: LaunchDecision): void {
    this.host.database.run(
      `INSERT INTO launch_decisions
        (decisionId, requestId, policyRevision, routeDigest, category,
         provider, model, effort, reason, selectedAt, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        decision.decisionId,
        decision.requestId,
        decision.policyRevision,
        decision.routeDigest,
        decision.category,
        decision.provider,
        decision.model,
        decision.effort,
        decision.reason,
        decision.selectedAt,
      ],
    );
  }
}
