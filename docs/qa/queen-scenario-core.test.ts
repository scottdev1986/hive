import { describe, expect, test } from "bun:test";
import {
  applyOrphanRefuseTransition,
  bindRetryMessageId,
  catalogDeterminism,
  classifyUserOrphan,
  deliveryEvidenceLabel,
  hasTerminalWriteReceipt,
  planOrphanRefuseTransition,
  Q_CATALOG_ROWS,
  type AttemptEvidence,
} from "./queen-scenario-core";

const writtenClean = (id: string): AttemptEvidence => ({
  outcome: "written",
  terminalReceipt: {
    transactionId: id,
    stage: "written-to-terminal",
    diagnostic: null,
  },
});

const writtenAfterOrphan = (id: string): AttemptEvidence => ({
  outcome: "written",
  terminalReceipt: {
    transactionId: `${id}:after-orphan-discard`,
    stage: "written-to-terminal",
    diagnostic: null,
  },
});

const declinedOrphan: AttemptEvidence = {
  outcome: "input-busy",
  terminalReceipt: {
    transactionId: "attempt-1",
    stage: "rejected",
    diagnostic: "claim denied: UserOrphaned",
  },
};

describe("queen scenario delivery and UserOrphaned evidence", () => {
  test("requires a non-null terminal write receipt, not message-state alone", () => {
    expect(hasTerminalWriteReceipt([])).toBeFalse();
    expect(
      hasTerminalWriteReceipt([{ outcome: "written", terminalReceipt: null }]),
    ).toBeFalse();
    expect(hasTerminalWriteReceipt([writtenClean("a")])).toBeTrue();
  });

  test("classifies recovered UserOrphaned from after-orphan-discard receipt id", () => {
    // Invariant: a written receipt whose transactionId carries the orphan-retry
    // suffix is recovered, even when the outcome enum alone looks clean.
    expect(classifyUserOrphan([writtenAfterOrphan("uuid")])).toBe("recovered");
    expect(classifyUserOrphan([writtenClean("uuid")])).toBe("absent");
  });

  test("classifies retry-refused UserOrphaned from durable diagnostic prose", () => {
    expect(classifyUserOrphan([declinedOrphan])).toBe("refused");
    expect(
      classifyUserOrphan(
        [{ outcome: "pending", terminalReceipt: null }],
        "sessiond inject declined: claim denied: UserOrphaned",
      ),
    ).toBe("refused");
  });

  test("labels both axes for the matrix row", () => {
    expect(deliveryEvidenceLabel("recovered", true)).toBe(
      "writeReceipt=yes UserOrphaned:recovered",
    );
    expect(deliveryEvidenceLabel("absent", false)).toBe(
      "writeReceipt=no UserOrphaned:absent",
    );
  });
});

describe("queen scenario orphan-refuse transition seam", () => {
  test("binds the tracked id to blockedDeliveries.messageId (oldest queued)", () => {
    // Delivery wakes the oldest queued message. A second send would leave
    // diagnostics on message 1 while the tracker follows message 2.
    const stayed = bindRetryMessageId("msg-1", {
      messageId: "msg-1",
      diagnostic: "claim denied: UserOrphaned",
    });
    expect(stayed).toEqual({ messageId: "msg-1", rebound: false });

    const rebound = bindRetryMessageId("msg-2", {
      messageId: "msg-1",
      diagnostic: "claim denied: UserOrphaned",
    });
    expect(rebound).toEqual({ messageId: "msg-1", rebound: true });
  });

  test("first refuse plans rewake of the blocked id with rewakeCount 1", () => {
    const plan = planOrphanRefuseTransition(
      "msg-2",
      { messageId: "msg-1", diagnostic: "claim denied: UserOrphaned" },
      false,
    );
    expect(plan).toEqual({
      kind: "rewake",
      messageId: "msg-1",
      rewakeCount: 1,
    });
  });

  test("second refuse plans give-up with rewakeCount 0", () => {
    const plan = planOrphanRefuseTransition(
      "msg-1",
      { messageId: "msg-1", diagnostic: "claim denied: UserOrphaned" },
      true,
    );
    expect(plan).toEqual({
      kind: "give-up",
      messageId: "msg-1",
      rewakeCount: 0,
    });
  });

  test("apply drives rewake once and retains the blocked messageId", async () => {
    const plan = planOrphanRefuseTransition(
      "msg-2",
      { messageId: "msg-1", diagnostic: "claim denied: UserOrphaned" },
      false,
    );
    let rewakeCount = 0;
    const applied = await applyOrphanRefuseTransition(plan, async () => {
      rewakeCount += 1;
    });
    expect(rewakeCount).toBe(1);
    expect(applied).toEqual({ messageId: "msg-1", rewakeCount: 1 });
  });

  test("apply of give-up invokes no rewake", async () => {
    const plan = planOrphanRefuseTransition(
      "msg-1",
      { messageId: "msg-1", diagnostic: "claim denied: UserOrphaned" },
      true,
    );
    let rewakeCount = 0;
    const applied = await applyOrphanRefuseTransition(plan, async () => {
      rewakeCount += 1;
    });
    expect(rewakeCount).toBe(0);
    expect(applied).toEqual({ messageId: "msg-1", rewakeCount: 0 });
  });
});

describe("Q catalog authority", () => {
  test("SYS-07 is the only Q-owned row and carries catalog determinism", () => {
    expect(Object.keys(Q_CATALOG_ROWS)).toEqual(["SYS-07"]);
    expect(catalogDeterminism("SYS-07")).toBe("bounded");
  });
});
