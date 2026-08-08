import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ProviderSession,
  SubmissionReceipt,
} from "../src/adapters/providers/protocol/types";
import { renderSession } from "../src/cli/agent-ui/run";
import { MAIL_WAKE_MAX_ATTEMPTS } from "../src/schemas/mail-wake";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

async function type(text: string): Promise<void> {
  await harness.testRenderer.mockInput.typeText(text);
  await harness.testRenderer.flush();
}

const notice = (
  wakeId: string,
  lane: "control" | "work",
  oldestItemId: string,
) => ({
  wakeId,
  recipient: "maya",
  lane,
  oldestItemId,
  backlogCount: 1,
  cursor: 1,
  brokerSeq: 1,
});

describe("the OpenTUI Agent UI and durable scheduler", () => {
  test("the vendor receives the same id as the durable row", async () => {
    await type("ship it");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");

    const row = harness.journal.all()[0];
    if (row === undefined) throw new Error("missing journal row");
    expect(harness.driver.submissions[0]?.clientInputId).toBe(
      row.clientInputId,
    );
    expect(row.state).toBe("submitted");
    expect(harness.reportedReceipts).toEqual([
      {
        clientInputId: row.clientInputId,
        outcome: "accepted",
        turnId: null,
      },
    ]);
  });

  test("a correlated turn marks an accepted user submission observed", async () => {
    await type("ship it");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    const row = harness.journal.all()[0];
    if (row === undefined) throw new Error("missing journal row");

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "t1",
        clientInputId: row.clientInputId,
      }),
    );
    await harness.ui.settleInput();

    expect(harness.journal.require(row.clientInputId)).toMatchObject({
      state: "observed",
      turnId: "t1",
    });
  });

  test("journal recovery restores the visible fate of prior prompts", async () => {
    await harness.close();
    harness = await createAgentUiHarness({
      prepareJournal: async (journal) => {
        await journal.append(
          "accepted-input",
          { text: "accepted before restart", attachments: [] },
          "1970-01-01T00:00:00.000Z",
        );
        await journal.setState("accepted-input", "submitted");
        await journal.append(
          "interrupted-input",
          { text: "uncertain after restart", attachments: [] },
          "1970-01-01T00:00:01.000Z",
        );
        await journal.recoverInterrupted();
      },
    });

    expect(
      harness.ui
        .snapshot()
        .view.transcript.filter((entry) => entry.kind === "user"),
    ).toEqual([
      {
        kind: "user",
        clientInputId: "accepted-input",
        text: "accepted before restart",
        delivery: "accepted",
      },
      {
        kind: "user",
        clientInputId: "interrupted-input",
        text: "uncertain after restart",
        delivery: "unknown",
      },
    ]);
  });

  test("a lost acknowledgement becomes delivery-unknown", async () => {
    harness.driver.submitOutcome = "unknown";
    await type("risky");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");

    expect(harness.journal.all()[0]?.state).toBe("delivery_unknown");
    expect(harness.reportedReceipts[0]?.outcome).toBe("unknown");
  });

  test("Enter during an active response queues and dispatches at the boundary", async () => {
    await type("first");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await type("second");
    await harness.ui.submitDraft("1970-01-01T00:00:01.000Z");

    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "first",
    ]);
    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.journal.all().map((row) => row.text)).toEqual([
      "first",
      "second",
    ]);
    expect(
      harness.ui
        .snapshot()
        .view.transcript.filter((entry) => entry.kind === "user")
        .map((entry) => ("text" in entry ? entry.text : "")),
    ).toEqual(["first", "second"]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "first",
      "second",
    ]);
  });

  test("an inserted message stays visible while the active response continues", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "response before the inserted message",
      }),
    );
    await type("keep this inserted message visible");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: `\n${Array.from(
          { length: 80 },
          (_, index) => `continued ${index}`,
        ).join("\n")}`,
      }),
    );
    await Bun.sleep(20);
    await harness.testRenderer.flush();

    const frame = harness.testRenderer.captureCharFrame();
    expect(harness.driver.submissions).toEqual([]);
    expect(frame).toContain("continued 79");
    expect(frame).toContain("> keep this inserted message visible");
    expect(frame).not.toContain("queued");
    expect(frame).not.toContain("sending");
    expect(frame.indexOf("continued 79")).toBeLessThan(
      frame.indexOf("keep this inserted message visible"),
    );
    expect(
      harness.ui.snapshot().view.transcript.map((entry) => entry.kind),
    ).toEqual(["agent", "user"]);
    expect(harness.ui.snapshot().view.transcript.at(-1)).toMatchObject({
      kind: "user",
      delivery: "queued",
      text: "keep this inserted message visible",
    });
  });

  test("rapid Enters during a response queue messages in order", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await type("one");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    await type("two");
    await harness.ui.submitDraft("1970-01-01T00:00:01.000Z");
    await type("three");
    await harness.ui.submitDraft("1970-01-01T00:00:02.000Z");

    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all().map((row) => row.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(harness.ui.snapshot().draft).toBe("");

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "one",
    ]);

    for (const [turn, expected] of [
      ["t2", "two"],
      ["t3", "three"],
    ] as const) {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-started", turnId: turn }),
      );
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-idle", turnId: turn }),
      );
      await harness.ui.pump();
      expect(harness.driver.submissions.at(-1)?.text).toBe(expected);
    }
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("each response grows before the next inserted message", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "first response",
      }),
    );
    await type("first inserted message");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    await type("second inserted message");
    await harness.ui.submitDraft("1970-01-01T00:00:01.000Z");
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "tool-1",
        toolName: "Read",
        detail: "finish the first response",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-finished",
        turnId: "t1",
        toolCallId: "tool-1",
        status: "ok",
      }),
    );

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t2" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t2",
        text: "response to the first inserted message",
      }),
    );
    await Bun.sleep(20);
    await harness.testRenderer.flush();

    expect(
      harness.ui
        .snapshot()
        .view.transcript.map((entry) =>
          entry.kind === "user"
            ? `user:${entry.text}`
            : "turnId" in entry
              ? `${entry.kind}:${entry.turnId}`
              : entry.kind,
        ),
    ).toEqual([
      "agent:t1",
      "tool:t1",
      "user:first inserted message",
      "agent:t2",
      "user:second inserted message",
    ]);
    expect(
      harness.ui
        .snapshot()
        .view.transcript.filter((entry) => entry.kind === "user")
        .map((entry) => entry.delivery),
    ).toEqual(["accepted", "queued"]);
    expect(
      harness.ui
        .snapshot()
        .view.transcript.find(
          (entry) => entry.kind === "tool" && entry.toolCallId === "tool-1",
        ),
    ).toMatchObject({ status: "ok" });
    const frame = harness.testRenderer.captureCharFrame();
    expect(
      frame.indexOf("response to the first inserted message"),
    ).toBeLessThan(frame.indexOf("second inserted message"));
    expect(frame).not.toContain("queued");

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t2" }),
    );
    await harness.ui.pump();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "first inserted message",
      "second inserted message",
    ]);
  });

  test("an unsent draft holds mail until the person submits or clears it", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "m1"));
    await type("do this next");
    await harness.testRenderer.flush();

    expect(harness.ui.snapshot().draft).toBe("do this next");
    expect(harness.driver.submissions).toEqual([]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    // Still composing: mail must not steal the turn.
    expect(harness.driver.submissions).toEqual([]);
  });

  test("a submitted user queues ahead of waiting mail", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "m1"));
    await type("do this next");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    await harness.testRenderer.flush();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).not.toContain("response active · draft preserved");
    expect(frame).toContain("do this next");
    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.driver.submissions).toEqual([]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "do this next",
    ]);
  });

  test("provider output and resize leave the textarea untouched", async () => {
    await type("half-typed にほんご thought");
    harness.testRenderer.mockInput.pressArrow("left");
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "a".repeat(400),
      }),
    );
    harness.testRenderer.resize(42, 12);
    await harness.testRenderer.flush();
    harness.testRenderer.resize(120, 40);
    await harness.testRenderer.flush();

    expect(harness.ui.snapshot().draft).toBe("half-typed にほんご thought");
  });

  test("a replayed decision for a settled approval is an idempotent no-op", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "approval-waiting",
        requestId: "permission-1",
        turnId: "t1",
        toolName: "bash",
        summary: "run tests",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "elicitation-settled",
        requestId: "permission-1",
        outcome: "allow",
      }),
    );

    await harness.ui.respondToPermission("permission-1", "allow");

    expect(harness.driver.permissionDecisions).toEqual([]);
  });

  test("separate background failures are not deduplicated by the pane", async () => {
    harness.ui.reportError("provider permission poll failed — disconnected");
    harness.ui.reportError("provider permission poll failed — disconnected");
    await harness.testRenderer.flush();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("! Hive");
    expect(
      frame.match(/provider permission poll failed — disconnected/g),
    ).toHaveLength(2);
  });

  test("production diagnostics are rendered only after daemon canonicalization", async () => {
    await harness.close();
    const reports: Array<{
      severity: string;
      source: string;
      operation: string;
      reason: string;
    }> = [];
    harness = await createAgentUiHarness({
      reportDiagnostic: (report) => reports.push(report),
    });

    harness.ui.reportError("raw provider failure");
    await harness.testRenderer.flush();
    expect(reports).toEqual([
      {
        severity: "error",
        source: "session",
        operation: "agent-ui",
        reason: "raw provider failure",
      },
    ]);
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "raw provider failure",
    );

    harness.ui.renderDiagnostic({
      severity: "error",
      reason: "daemon-redacted failure",
    });
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "daemon-redacted failure",
    );
  });

  test("manual scrolling stays anchored while new output arrives", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: Array.from({ length: 80 }, (_, index) => `line ${index}`).join(
          "\n",
        ),
      }),
    );
    await harness.testRenderer.flush();
    harness.ui.scrollBy(-5);
    await harness.testRenderer.flush();
    const anchored = harness.testRenderer.captureCharFrame();
    expect(anchored).not.toContain("line 79");

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "\nnew output after the anchor",
      }),
    );
    await harness.testRenderer.flush();
    const afterOutput = harness.testRenderer.captureCharFrame();
    expect(afterOutput).not.toContain("new output after the anchor");

    harness.ui.scrollBy(1_000);
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "new output after the anchor",
    );
  });
});

describe("mail wakes", () => {
  test("an unsent draft holds an automatic wake without being journaled", async () => {
    await type("half a thought");
    await harness.ui.onMailReady(notice("w1", "control", "mit_one"));

    expect(harness.ui.snapshot().draft).toBe("half a thought");
    expect(harness.ui.snapshot().view.mail).toBe("waiting");
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
  });

  test("a wake waits for an active turn and goes out at its boundary", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "mit_one"));
    expect(harness.driver.submissions).toEqual([]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();
    // Still woken — only the id it can no longer vouch for is dropped.
    expect(harness.driver.submissions).toHaveLength(1);
    expect(harness.driver.submissions[0]?.text).not.toContain("mit_one");
    expect(harness.driver.submissions[0]?.text).toContain(
      "claim at most one control item",
    );
  });

  /**
   * The turn a wake waits out is usually the turn that settles the item it
   * names: the agent is busy handling that very item. The daemon vouched for
   * the id when it served the notice and nothing re-checks it afterwards, so a
   * held wake names a ghost and spends a whole turn proving the mailbox empty.
   */
  test("a wake held across a turn never names the item that turn settled", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "mit_settled"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();

    expect(harness.driver.submissions[0]?.text).not.toContain("mit_settled");
  });

  /**
   * The queue is the other half of the defect: wakes stack up behind a long
   * turn and then drain one per boundary, so an agent that held one turn
   * through eight announcements pays eight turns to be told the same thing.
   */
  test("wakes stacked up behind one turn collapse into a single wake", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "mit_a"));
    await harness.ui.onMailReady(notice("w2", "control", "mit_b"));
    await harness.ui.onMailReady(notice("w3", "control", "mit_c"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();

    // Anything still queued would surface as a turn of its own, so drain.
    for (let turn = 2; turn < 6; turn += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-started", turnId: `t${turn}` }),
      );
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-idle", turnId: `t${turn}` }),
      );
      await harness.ui.pump();
    }
    expect(harness.driver.submissions).toHaveLength(1);
  });

  /**
   * The hazard in dropping a held wake whose item turns out to be settled: the
   * item behind it is real and unread, and dropping the wake it arrived under
   * trades a phantom wake for a silent missed one. A phantom wake costs a turn;
   * a missed wake costs an instruction. Downgrading never drops, so the agent
   * is still sent to the mailbox that still holds something.
   *
   * The assertions discriminate on WHAT the wake says, not that one fired:
   * every wake carries the poll instruction, phantom or not, so instruction
   * text alone cannot tell "woken for the unread item" from "woken by a ghost
   * naming the settled one" — the shape repo memory testing/fake-tests-pass-
   * because-an-earlier-guard-refuses-first warns about. Both assertions fail
   * on the unfixed tree.
   *
   * It also stands as the regression guard blake originally wrote it to be:
   * under a future drop-only implementation no wake fires here at all and the
   * length assertion fails (verified by mutation probe).
   */
  test("a stale-named wake with real mail behind it still wakes the agent", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    // The agent settles mit_settled during this turn; the daemon announces the
    // item now at the head, which is genuinely unread.
    await harness.ui.onMailReady(notice("w1", "control", "mit_settled"));
    await harness.ui.onMailReady(notice("w2", "control", "mit_unread"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.ui.pump();

    // Drain anything still queued: on the unfixed tree the second wake goes
    // out here, so the phantom and the real signal each cost a turn.
    for (let turn = 2; turn < 5; turn += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-started", turnId: `t${turn}` }),
      );
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-idle", turnId: `t${turn}` }),
      );
      await harness.ui.pump();
    }

    // Exactly one wake, and it must not name mit_settled: a wake that waited
    // cannot vouch for any id, so it points at the lane and the agent's poll
    // is what finds mit_unread. Naming mit_unread is not asserted because the
    // correct behaviour names NO item — only the absence of the ghost id and
    // the presence of the poll instruction separate right from phantom.
    expect(harness.driver.submissions).toHaveLength(1);
    expect(harness.driver.submissions[0]?.text).not.toContain("mit_settled");
    expect(harness.driver.submissions[0]?.text).toContain(
      "claim at most one control item",
    );
  });

  /**
   * Collapsing held wakes only holds up if the survivor actually gets
   * delivered. A wake carries its own retry budget, so collapsing into one
   * that is about to exhaust its retries would take the others down with it —
   * the lane still has mail and nothing is left to announce it.
   */
  test("a wake collapsed behind one that exhausts its retries is not stranded", async () => {
    harness.driver.submitOutcome = "rejected";
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("wA", "control", "mit_a"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    // Burn mit_a to one attempt short of the ceiling.
    for (let attempt = 1; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      await harness.ui.pump();
    }

    // mit_b is announced during the next turn. An announcement names the
    // lane's OLDEST available item, so naming mit_b proves mit_a is no longer
    // available: this supersedes mit_a rather than queueing behind it.
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t2" }),
    );
    await harness.ui.onMailReady(notice("wB", "control", "mit_b"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t2" }),
    );
    await harness.ui.pump();
    const spent = harness.driver.submissions.length;

    harness.driver.submitOutcome = "accepted";
    for (let turn = 3; turn < 8; turn += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-started", turnId: `t${turn}` }),
      );
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-idle", turnId: `t${turn}` }),
      );
      await harness.ui.pump();
    }
    expect(harness.driver.submissions.length).toBeGreaterThan(spent);
  });

  test("a held wake that is refused does not regain the id when it retries", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.ui.onMailReady(notice("w1", "control", "mit_settled"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    harness.driver.submitOutcome = "rejected";
    await harness.ui.pump();

    harness.driver.submitOutcome = "accepted";
    await harness.ui.pump();
    expect(harness.driver.submissions).toHaveLength(2);
    for (const submission of harness.driver.submissions) {
      expect(submission.text).not.toContain("mit_settled");
    }
  });

  test("a refused wake remains owed and retries", async () => {
    harness.driver.submitOutcome = "rejected";
    await harness.ui.onMailReady(notice("w1", "control", "mit_one"));
    expect(harness.ui.snapshot().view.mail).toBe("retrying");

    harness.driver.submitOutcome = "accepted";
    await harness.ui.pump();
    expect(harness.driver.submissions).toHaveLength(2);
    expect(harness.ui.snapshot().view.mail).toBe("waking");
  });

  test("a correlated wake turn clears the frontend mail phase", async () => {
    await harness.ui.onMailReady(notice("w1", "control", "mit_one"));
    const submission = harness.driver.submissions[0];
    if (submission === undefined) throw new Error("missing wake submission");

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "t1",
        clientInputId: submission.clientInputId,
      }),
    );

    expect(harness.ui.snapshot().view.mail).toBe("none");
  });

  test("an unclaimed item stops being re-woken after its attempt limit", async () => {
    harness.driver.submitOutcome = "rejected";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.ui.onMailReady(notice("w1", "control", "mit_one"));
    }

    expect(harness.driver.submissions).toHaveLength(MAIL_WAKE_MAX_ATTEMPTS);
  });

  /**
   * An announcement names the lane's oldest available item and the wake id is
   * derived from it, so mail published behind an item nobody settles is
   * announced under that item's exhausted id. Refusing it on the spent budget
   * would let one unclaimed item silence every message queued after it, and
   * nothing else on this path would say the lane still had mail.
   */
  test("mail published behind an exhausted wake is still announced", async () => {
    harness.driver.submitOutcome = "rejected";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.ui.onMailReady(notice("w1", "control", "mit_one"));
    }
    const exhausted = harness.driver.submissions.length;

    harness.driver.submitOutcome = "accepted";
    await harness.ui.onMailReady({
      ...notice("w1", "control", "mit_one"),
      brokerSeq: 2,
    });

    expect(exhausted).toBe(MAIL_WAKE_MAX_ATTEMPTS);
    expect(harness.driver.submissions.length).toBe(MAIL_WAKE_MAX_ATTEMPTS + 1);
  });

  test("a repeated wake id schedules only one turn", async () => {
    const repeated = notice("w1", "control", "m1");
    await harness.ui.onMailReady(repeated);
    await harness.ui.onMailReady({ ...repeated, cursor: 2 });

    expect(harness.driver.submissions).toHaveLength(1);
  });
});

describe("the provider event stream drives the surface and scheduler", () => {
  function unacknowledged(): ProviderSession {
    return {
      capabilities: harness.driver.capabilities,
      adapterChild: harness.driver.adapterChild,
      get events() {
        return harness.driver.events;
      },
      newSession: (input) => harness.driver.newSession(input),
      resumeSession: (input) => harness.driver.resumeSession(input),
      submit: () => new Promise<SubmissionReceipt>(() => {}),
      cancel: (turnId) => harness.driver.cancel(turnId),
      respondToPermission: (decision) =>
        harness.driver.respondToPermission(decision),
      listCommands: () => harness.driver.listCommands(),
      snapshot: () => harness.driver.snapshot(),
      close: () => harness.driver.close(),
    };
  }

  test("the first turn renders while kickoff acknowledgement is pending", async () => {
    const rendering = renderSession(
      harness.ui,
      unacknowledged(),
      {
        session: { vendorSessionId: "fake-1", replayedHistory: false },
        text: "Begin the assigned task.",
      },
      () => {},
      () => {},
    );
    harness.driver.emit({ kind: "runtime-ready" });
    harness.driver.emit({ kind: "turn-started", turnId: "t1" });
    harness.driver.emit({
      kind: "tool-started",
      turnId: "t1",
      toolCallId: "c1",
      toolName: "rg",
      detail: "rg -n pump src/",
    });
    await Bun.sleep(10);
    await harness.testRenderer.flush();

    expect(harness.ui.snapshot().view.runtime).toBe("ready");
    expect(harness.ui.snapshot().view.turn).toBe("working");
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "rg -n pump src/",
    );

    await harness.driver.close();
    await rendering;
  });

  test("a message submitted mid-turn dispatches when the turn goes idle", async () => {
    const rendering = renderSession(
      harness.ui,
      harness.driver,
      null,
      () => {},
      () => {},
    );
    harness.driver.emit({ kind: "turn-started", turnId: "t1" });
    await Bun.sleep(5);
    await type("a message someone typed");
    await harness.ui.submitDraft("1970-01-01T00:00:00.000Z");
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("");

    harness.driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(5);
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "a message someone typed",
    ]);

    await harness.driver.close();
    await rendering;
  });
});
