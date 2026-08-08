import type { HiveDatabase } from "../src/daemon/database/hive-database";
import { hiveInstanceSuffix } from "../src/hive-home/instance-identity";
import type { MailStore } from "../src/mail-service/store";
import { MAIL_MAX_ATTEMPTS, type MailItem } from "../src/schemas/mail";

/**
 * Everything waiting in a mailbox, oldest first, both lanes.
 *
 * Tests that used to read an agent's inbox read this instead. It goes through
 * the store's own reader rather than SQL of its own, so a test cannot keep
 * passing against a table shape the daemon no longer writes.
 */
export function mailbox(store: MailStore, recipient: string): MailItem[] {
  const now = new Date().toISOString();
  return [
    ...store.listAvailable(recipient, "control", 0, 100, now),
    ...store.listAvailable(recipient, "work", 0, 100, now),
  ].sort((left, right) => left.seq - right.seq);
}

/** Handles and settles a mailbox the way a live agent would, so it empties. */
export function drainMailbox(
  store: MailStore,
  recipient: string,
  generation = 0,
): void {
  for (let item = mailbox(store, recipient)[0]; item !== undefined; ) {
    const now = new Date();
    store.claim({
      itemId: item.itemId,
      recipient,
      ownerGeneration: generation,
      handlerId: "test-handler",
      leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
      now: now.toISOString(),
      maxAttempts: MAIL_MAX_ATTEMPTS,
    });
    store.settle({
      itemId: item.itemId,
      recipient,
      ownerGeneration: generation,
      handlerId: "test-handler",
      disposition: "completed",
      reason: null,
      retryAt: now.toISOString(),
      now: now.toISOString(),
      maxAttempts: MAIL_MAX_ATTEMPTS,
    });
    item = mailbox(store, recipient)[0];
  }
}

/**
 * Binds a root session, which is what gives the root an incarnation to act as.
 *
 * A daemon that has never bound one has no root generation, and mail refuses
 * rather than inventing zero — so a test whose root sends or reads mail needs
 * this, exactly as a live Hive does.
 */
export function bindRootSession(db: HiveDatabase, generation = 1): void {
  db.bindTerminalHostSession({
    locator: {
      schemaVersion: 1,
      instanceId: hiveInstanceSuffix(),
      subject: { kind: "root" },
      generation,
      sessionId: `ses_018f1e90-7b5a-7cc0-8000-0000000009${String(generation).padStart(2, "0")}`,
      hostKind: "sessiond",
      engineBuildId: "engine-test-root",
    },
    visibility: {
      workspaceSessionId: "workspace-test-root",
      workspacePid: 4100,
      workspaceStartToken: "4100:1",
      openTerminalRevision: "7",
    },
  });
}
