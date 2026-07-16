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

/**
 * Model what a real pane does with a paste, so a fake TmuxSender is a working
 * TUI rather than a broken one.
 *
 * An idle TUI handed a paste submits it and the model starts a turn, and that
 * turn-start — reported by the agent's own hook stream — is the only evidence
 * Hive ever gets that a message reached a mind. A fake whose `sendMessage` just
 * resolves is not a simplified TUI; it is a pane that silently drops every
 * message while `tmux send-keys` exits 0, which is the defect under test. Call
 * this from a fake sender to say "and then the agent actually woke up".
 *
 * Turns are strictly ordered in time, so this advances its own clock: two
 * events stamped in the same millisecond are indistinguishable from "no new
 * turn started".
 */
let turnClock = Date.parse("2026-07-09T12:30:00.000Z");

export function submitPaste(db: HiveDatabase, session: string): void {
  const agent = db.listAgents().find(
    (record) => record.tmuxSession === session,
  );
  if (agent === undefined) return;
  turnClock += 1_000;
  db.insertEvent({
    kind: "turn-start",
    agentName: agent.name,
    timestamp: new Date(turnClock).toISOString(),
  });
}

export function actingAs(
  daemon: HiveDaemon,
  subject: string,
  role: Role = "operator",
  options: { epoch?: number } = {},
): AuthorizedFetch {
  const agent = daemon.db.getAgentByName(subject);
  const { token } = daemon.capabilities.mint(subject, role, {
    epoch: options.epoch ?? agent?.capabilityEpoch ?? 0,
    ...(agent === null
      ? {}
      : {
        holder: {
          agentId: agent.id,
          processIncarnation: agent.processIncarnation ?? 0,
        },
      }),
  });
  return (input, init) => {
    // Headers must merge through the Headers API: spreading a Headers instance
    // yields {} and would strip the MCP client's Accept header.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };
}
