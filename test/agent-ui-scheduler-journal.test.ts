import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakePrompt } from "../src/cli/agent-ui/agent-ui-exports";
import { OutboundJournal } from "../src/cli/agent-ui/outbound-journal";
import {
  canSubmitUser,
  commitDispatch,
  EMPTY_SCHEDULER,
  enqueueWake,
  nextItem,
  onSubmissionAccepted,
  onTurnBoundary,
  onTurnStarted,
  pendingWakeCount,
} from "../src/cli/agent-ui/turn-scheduler";
import {
  MAIL_WAKE_MAX_ATTEMPTS,
  MAIL_WAKE_MAX_DISPATCHES,
} from "../src/schemas/mail-wake";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-outbound-"));
  path = join(directory, "outbound.jsonl");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const DRAFT = { text: "refactor the parser", attachments: [] as string[] };

test("mail wakes are explicitly silent internal operations", () => {
  const prompt = wakePrompt({
    wakeId: "wake-1",
    lane: "control",
    oldestItemId: "mail-1",
    brokerSeq: 1,
    heldAcrossTurn: false,
  });

  expect(prompt).toContain("internal operations, not a user message");
  expect(prompt).toContain("Do not call SendUserMessage");
  expect(prompt).toContain("finish silently");
  expect(prompt).toContain("the control lane signalled mail for you");
  expect(prompt).not.toContain("mail-1");
});

describe("the durable outbound journal", () => {
  test("a row survives reopening the journal", async () => {
    const journal = await OutboundJournal.open(path);
    await journal.append("input-1", DRAFT, "1970-01-01T00:00:00.000Z");
    await journal.close();

    const reopened = await OutboundJournal.open(path);

    expect(reopened.require("input-1")).toEqual({
      clientInputId: "input-1",
      text: "refactor the parser",
      attachments: [],
      purpose: "user",
      createdAt: "1970-01-01T00:00:00.000Z",
      state: "pending",
      turnId: null,
    });
    await reopened.close();
  });

  test("state transitions replay in order", async () => {
    const journal = await OutboundJournal.open(path);
    await journal.append("input-1", DRAFT, "1970-01-01T00:00:00.000Z");
    await journal.setState("input-1", "submitted");
    await journal.setState("input-1", "observed", "t1");
    await journal.close();

    const reopened = await OutboundJournal.open(path);

    expect(reopened.require("input-1").state).toBe("observed");
    expect(reopened.require("input-1").turnId).toBe("t1");
    await reopened.close();
  });

  test("recovery never replays a submission whose receipt was interrupted", async () => {
    const journal = await OutboundJournal.open(path);
    await journal.append("input-1", DRAFT, "1970-01-01T00:00:00.000Z");
    await journal.close();

    const reopened = await OutboundJournal.open(path);
    await reopened.recoverInterrupted();

    expect(reopened.require("input-1").state).toBe("delivery_unknown");
    await reopened.close();
  });

  test("delivery-unknown is terminal and no code path may resolve it", async () => {
    const journal = await OutboundJournal.open(path);
    await journal.append("input-1", DRAFT, "1970-01-01T00:00:00.000Z");
    await journal.setState("input-1", "delivery_unknown");

    expect(journal.setState("input-1", "observed", "t1")).rejects.toThrow(
      "only a person may resolve it",
    );
    await journal.close();
  });

  test("a duplicate clientInputId is refused rather than overwriting a row", async () => {
    const journal = await OutboundJournal.open(path);
    await journal.append("input-1", DRAFT, "1970-01-01T00:00:00.000Z");

    expect(
      journal.append("input-1", DRAFT, "1970-01-01T00:00:01.000Z"),
    ).rejects.toThrow("already exists");
    await journal.close();
  });

  test("the journal owns a draft snapshot after the caller clears its text", async () => {
    let draft = "ship it";
    const journal = await OutboundJournal.open(path);

    const row = await journal.append(
      "input-1",
      { text: draft, attachments: [] },
      "1970-01-01T00:00:00.000Z",
    );
    draft = "";

    expect(row.text).toBe("ship it");
    expect(draft).toBe("");
    expect(journal.require("input-1").text).toBe("ship it");
    await journal.close();
  });
});

describe("the turn scheduler", () => {
  test("an active turn blocks user dispatch and mail", () => {
    let state = onTurnStarted(EMPTY_SCHEDULER, "t1");
    state = enqueueWake(state, {
      wakeId: "w1",
      lane: "control",
      oldestItemId: "m1",
      brokerSeq: 1,
    });

    expect(canSubmitUser(state)).toBe(false);
    expect(nextItem(state)).toBeNull();
  });

  test("an early receipt holds input until its turn appears", () => {
    const state = onSubmissionAccepted(EMPTY_SCHEDULER, "t1");

    expect(canSubmitUser(state)).toBe(false);
    expect(canSubmitUser(onTurnStarted(state, "t1"))).toBe(false);
  });

  test("a late Kimi receipt cannot reopen a completed turn", () => {
    let state = onTurnStarted(EMPTY_SCHEDULER, "turn-1");
    state = onTurnBoundary(state, "turn-1");
    state = onSubmissionAccepted(state, "turn-1");

    expect(canSubmitUser(state)).toBe(true);
    expect(state.awaitingTurn).toBe(false);
  });

  test("control mail runs before work mail at a boundary", () => {
    let state = EMPTY_SCHEDULER;
    state = enqueueWake(state, {
      wakeId: "w-work",
      lane: "work",
      oldestItemId: "m2",
      brokerSeq: 1,
    });
    state = enqueueWake(state, {
      wakeId: "w-control",
      lane: "control",
      oldestItemId: "m1",
      brokerSeq: 2,
    });

    const first = nextItem(state);
    if (first === null) throw new Error("expected control mail");
    state = commitDispatch(state, first);

    expect(first.kind).toBe("control-wake");
    expect(nextItem(state)?.kind).toBe("work-wake");
  });

  test("a repeated wake is idempotent on wakeId", () => {
    const wake = {
      wakeId: "w1",
      lane: "control" as const,
      oldestItemId: "m1",
      brokerSeq: 1,
    };
    let state = enqueueWake(EMPTY_SCHEDULER, wake);
    state = enqueueWake(state, wake);
    state = enqueueWake(state, wake);

    expect(state.controlWakes).toHaveLength(1);
  });

  test("work wakes coalesce to the newest one", () => {
    let state = enqueueWake(EMPTY_SCHEDULER, {
      wakeId: "w1",
      lane: "work",
      oldestItemId: "m1",
      brokerSeq: 1,
    });
    state = enqueueWake(state, {
      wakeId: "w2",
      lane: "work",
      oldestItemId: "m2",
      brokerSeq: 2,
    });

    expect(state.workWake?.wakeId).toBe("w2");
    expect(pendingWakeCount(state)).toBe(1);
  });

  test("control wakes do not coalesce, because each names its own item", () => {
    let state = enqueueWake(EMPTY_SCHEDULER, {
      wakeId: "w1",
      lane: "control",
      oldestItemId: "m1",
      brokerSeq: 1,
    });
    state = enqueueWake(state, {
      wakeId: "w2",
      lane: "control",
      oldestItemId: "m2",
      brokerSeq: 2,
    });

    expect(state.controlWakes).toHaveLength(2);
  });

  test("a spent budget refuses the announcement, not the lane", () => {
    const stuck = {
      wakeId: "w1",
      lane: "control" as const,
      oldestItemId: "m1",
      brokerSeq: 1,
    };
    let state = EMPTY_SCHEDULER;
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      state = enqueueWake(state, stuck);
      const item = nextItem(state);
      if (item === null) throw new Error("expected a wake to dispatch");
      state = commitDispatch(state, item);
    }

    expect(enqueueWake(state, stuck).controlWakes).toHaveLength(0);
    expect(
      enqueueWake(state, { ...stuck, brokerSeq: 2 }).controlWakes,
    ).toHaveLength(1);
  });

  /**
   * Two publishes can land during one turn, and only the first is queued: the
   * second matches a wake id already waiting. Dropping it there would spend the
   * newer publish without ever offering it, and a rejected dispatch would then
   * leave nothing owed for mail that really had arrived.
   */
  test("a second publish during a turn is not lost behind the first", () => {
    const stuck = {
      wakeId: "w1",
      lane: "control" as const,
      oldestItemId: "m1",
      brokerSeq: 1,
    };
    let state = EMPTY_SCHEDULER;
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      state = enqueueWake(state, stuck);
      const item = nextItem(state);
      if (item === null) throw new Error("expected a wake to dispatch");
      state = commitDispatch(state, item);
    }

    state = onTurnStarted(state, "t1");
    state = enqueueWake(state, { ...stuck, brokerSeq: 2 });
    state = enqueueWake(state, { ...stuck, brokerSeq: 3 });
    state = onTurnBoundary(state, "t1");
    const item = nextItem(state);
    if (item === null) throw new Error("expected the held wake");
    state = commitDispatch(state, item);
    // The provider refuses it, so nothing reached the agent and the lane is
    // still owed a wake for the publish that arrived while it was busy.
    state = enqueueWake(state, item.wake);

    expect(pendingWakeCount(state)).toBe(1);
  });

  /**
   * The scheduler keys its budget on a field the daemon supplies. A response
   * that omits it must not read as "newer than everything" and disable the cap.
   */
  test("an announcement with no sequence fails closed onto the cap", () => {
    const malformed = {
      wakeId: "w1",
      lane: "control" as const,
      oldestItemId: "m1",
    } as unknown as {
      wakeId: string;
      lane: "control";
      oldestItemId: string;
      brokerSeq: number;
    };
    let state = EMPTY_SCHEDULER;
    let dispatches = 0;
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS + 7; attempt += 1) {
      state = enqueueWake(state, malformed);
      const item = nextItem(state);
      if (item === null) continue;
      state = commitDispatch(state, item);
      dispatches += 1;
    }

    expect(dispatches).toBe(MAIL_WAKE_MAX_ATTEMPTS);
  });

  /**
   * Renewal forgives attempts, so on its own a stuck item plus a steady stream
   * of mail behind it would interrupt the recipient once per publish forever —
   * always about that same item. The work lane is the sharp end: work publishes
   * are not capacity-capped, so the sequences can keep climbing indefinitely.
   */
  for (const lane of ["control", "work"] as const) {
    test(`a flood of publishes cannot wake the ${lane} lane without end`, () => {
      let state = EMPTY_SCHEDULER;
      let dispatches = 0;
      for (let brokerSeq = 1; brokerSeq <= 100; brokerSeq += 1) {
        state = enqueueWake(state, {
          wakeId: "w1",
          lane,
          oldestItemId: "m1",
          brokerSeq,
        });
        const item = nextItem(state);
        if (item === null) continue;
        state = commitDispatch(state, item);
        dispatches += 1;
      }

      expect(dispatches).toBe(MAIL_WAKE_MAX_DISPATCHES);
      expect(pendingWakeCount(state)).toBe(0);
    });
  }

  /**
   * A sequence outside the domain the mailbox counts in must not become a
   * ceiling nothing real can pass, which would silence the lane for good.
   */
  test("an impossible sequence cannot lock out the ones that follow", () => {
    const stuck = {
      wakeId: "w1",
      lane: "control" as const,
      oldestItemId: "m1",
    };
    let state = EMPTY_SCHEDULER;
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      state = enqueueWake(state, { ...stuck, brokerSeq: 1e300 });
      const item = nextItem(state);
      if (item === null) continue;
      state = commitDispatch(state, item);
    }

    state = enqueueWake(state, { ...stuck, brokerSeq: 100 });

    expect(pendingWakeCount(state)).toBe(1);
  });

  /**
   * Held is "this wake ever waited on a turn", so it survives a merge from
   * either side. A wake queued while idle that is re-announced mid-turn HAS
   * waited, and losing that lets the prompt name an item the turn may have
   * settled.
   */
  for (const lane of ["control", "work"] as const) {
    test(`a mid-turn re-announcement keeps the ${lane} wake held`, () => {
      let state = enqueueWake(EMPTY_SCHEDULER, {
        wakeId: "w1",
        lane,
        oldestItemId: "m1",
        brokerSeq: 1,
      });
      state = onTurnStarted(state, "t1");
      state = enqueueWake(state, {
        wakeId: "w1",
        lane,
        oldestItemId: "m1",
        brokerSeq: 2,
      });
      state = onTurnBoundary(state, "t1");

      const item = nextItem(state);
      if (item === null) throw new Error("expected the merged wake");
      expect(item.wake.brokerSeq).toBe(2);
      expect(item.wake.heldAcrossTurn).toBe(true);
    });
  }

  test("a wake arriving mid-turn waits and becomes generic", () => {
    let state = onTurnStarted(EMPTY_SCHEDULER, "t1");
    state = enqueueWake(state, {
      wakeId: "w1",
      lane: "control",
      oldestItemId: "m1",
      brokerSeq: 1,
    });

    expect(nextItem(state)).toBeNull();
    state = onTurnBoundary(state, "t1");
    const ready = nextItem(state);
    expect(ready?.kind).toBe("control-wake");
    if (ready?.kind === "control-wake") {
      expect(ready.wake.heldAcrossTurn).toBe(true);
    }
  });
});
