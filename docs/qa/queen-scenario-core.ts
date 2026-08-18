// Pure Q-scenario decisions: delivery receipt, UserOrphaned classification,
// retry message binding, and catalog row shape. Free of rig state so fixtures
// pin recovered/refused orphan paths and the retry id-binding machine without
// a daemon.

export type UserOrphanClass = "absent" | "recovered" | "refused";

export interface AttemptEvidence {
  outcome: string;
  terminalReceipt: {
    transactionId: string;
    stage?: string;
    diagnostic?: string | null;
  } | null;
}

export interface BlockedDelivery {
  messageId: string;
  diagnostic: string;
}

/** Terminal-write RECEIPT is the Q success boundary — not message.state alone. */
export function hasTerminalWriteReceipt(
  attempts: readonly AttemptEvidence[],
): boolean {
  return attempts.some(
    (attempt) =>
      attempt.outcome === "written" && attempt.terminalReceipt !== null,
  );
}

/**
 * UserOrphaned is not a message-attempt outcome enum. Durable evidence lives
 * in receipt.transactionId suffix `:after-orphan-discard` (recovery retry after
 * discard) and/or receipt.diagnostic / blockedDeliveries prose.
 */
export function classifyUserOrphan(
  attempts: readonly AttemptEvidence[],
  blockedDiagnostic: string | null = null,
): UserOrphanClass {
  const recovered = attempts.some(
    (attempt) =>
      attempt.outcome === "written" &&
      attempt.terminalReceipt !== null &&
      attempt.terminalReceipt.transactionId.includes("after-orphan-discard"),
  );
  if (recovered) return "recovered";

  const texts = [
    ...attempts.flatMap((attempt) => [
      attempt.terminalReceipt?.transactionId ?? "",
      attempt.terminalReceipt?.diagnostic ?? "",
    ]),
    blockedDiagnostic ?? "",
  ]
    .join("\n")
    .toLowerCase();

  if (
    texts.includes("userorphaned") ||
    texts.includes("after-orphan-discard") ||
    texts.includes("orphaned draft") ||
    texts.includes("orphan discard")
  ) {
    return "refused";
  }
  return "absent";
}

/**
 * Delivery always wakes the oldest queued message. A retry that mints a second
 * send reads attempts for message 2 while diagnostics still name message 1.
 * Bind the tracked id to the blocked delivery's messageId and re-wake — never
 * send a new body.
 */
export function bindRetryMessageId(
  trackedMessageId: string,
  blocked: BlockedDelivery | null,
): { messageId: string; rebound: boolean } {
  if (blocked === null) {
    return { messageId: trackedMessageId, rebound: false };
  }
  return {
    messageId: blocked.messageId,
    rebound: blocked.messageId !== trackedMessageId,
  };
}

/**
 * Orphan-refuse transition: re-wake the blocked message only. A second send is
 * not an effect here — the live caller block-scopes sendOnce so a miswired
 * second send fails at tsc, not at runtime counting.
 */
export type OrphanRefuseTransition =
  | { kind: "rewake"; messageId: string; rewakeCount: 1 }
  | { kind: "give-up"; messageId: string; rewakeCount: 0 };

export function planOrphanRefuseTransition(
  trackedMessageId: string,
  blocked: BlockedDelivery | null,
  alreadyRetried: boolean,
): OrphanRefuseTransition {
  const { messageId } = bindRetryMessageId(trackedMessageId, blocked);
  if (alreadyRetried) {
    return { kind: "give-up", messageId, rewakeCount: 0 };
  }
  return { kind: "rewake", messageId, rewakeCount: 1 };
}

/** Drive planned rewakes only; there is no send effect to mislabel. */
export async function applyOrphanRefuseTransition(
  plan: OrphanRefuseTransition,
  rewake: () => Promise<void>,
): Promise<{ messageId: string; rewakeCount: number }> {
  let rewakeCount = 0;
  for (let i = 0; i < plan.rewakeCount; i += 1) {
    await rewake();
    rewakeCount += 1;
  }
  return { messageId: plan.messageId, rewakeCount };
}

export function deliveryEvidenceLabel(
  orphan: UserOrphanClass,
  hasReceipt: boolean,
): string {
  return `writeReceipt=${hasReceipt ? "yes" : "no"} UserOrphaned:${orphan}`;
}

/**
 * Catalog authority for the Q leg. Only rows whose owner is Q may appear in
 * queen-scenario.jsonl; determinism is per-row from the catalog, never a
 * blanket value.
 */
export const Q_CATALOG_ROWS = {
  "SYS-07": "bounded",
} as const satisfies Record<string, "yes" | "bounded" | "calibrated">;

export type QCatalogRowId = keyof typeof Q_CATALOG_ROWS;

export function catalogDeterminism(
  id: QCatalogRowId,
): "yes" | "bounded" | "calibrated" {
  return Q_CATALOG_ROWS[id];
}
