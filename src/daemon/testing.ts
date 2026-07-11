// Test-only credential plumbing for embedded daemons.
//
// A production caller reads its token from a 0600 credential file the daemon
// wrote at spawn. An in-process test has no such file, so it mints directly
// against the daemon's store and presents the token exactly as a real client
// would: an `Authorization: Bearer` header on every request.
import type { AgentRecord } from "../schemas";
import type { Role } from "./capabilities";
import { AuditRowSchema, type AuditRow, type HiveDatabase } from "./db";
import type { HiveDaemon } from "./server";

export type AuthorizedFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Returns a fetch bound to one subject's freshly minted capability. Use the
 * role the real caller would hold: `writer` for an agent, `orchestrator` for
 * the root, `operator` for the human's CLI. */
// Test-only row surgery. Production code never deletes individual agents,
// messages, events, or approvals (history is pruned wholesale by
// pruneHistory), and never lists a name's full holder history or the audit
// log — so these live here, off HiveDatabase's production surface, using its
// public `database` handle directly.

export function deleteAgentRow(db: HiveDatabase, id: string): boolean {
  return db.database.query("DELETE FROM agents WHERE id = ?").run(id)
    .changes > 0;
}

export function deleteMessageRow(db: HiveDatabase, id: string): boolean {
  return db.database.query("DELETE FROM messages WHERE id = ?").run(id)
    .changes > 0;
}

export function deleteApprovalRow(db: HiveDatabase, id: string): boolean {
  return db.database.query("DELETE FROM approvals WHERE id = ?").run(id)
    .changes > 0;
}

export function deleteEventRows(db: HiveDatabase, agentName?: string): number {
  if (agentName === undefined) {
    return db.database.query("DELETE FROM events").run().changes;
  }
  return db.database.query("DELETE FROM events WHERE agentName = ?")
    .run(agentName).changes;
}

/** Every holder a name has ever had, oldest first. */
export function listAgentsNamed(
  db: HiveDatabase,
  name: string,
): AgentRecord[] {
  return db.listAgents().filter((agent) => agent.name === name);
}

export function listAuditEntries(db: HiveDatabase, limit = 100): AuditRow[] {
  return db.database.query(`
    SELECT at, route, action, callerSubject, callerRole, capabilityId,
           requestedSubject, epoch, decision, reason
    FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(limit).map((row) => AuditRowSchema.parse(row));
}

export function actingAs(
  daemon: HiveDaemon,
  subject: string,
  role: Role = "operator",
  options: { epoch?: number } = {},
): AuthorizedFetch {
  const { token } = daemon.capabilities.mint(subject, role, {
    epoch: options.epoch ?? 0,
  });
  return (input, init) => {
    // Headers must merge through the Headers API: spreading a Headers instance
    // yields {} and would strip the MCP client's Accept header.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };
}
