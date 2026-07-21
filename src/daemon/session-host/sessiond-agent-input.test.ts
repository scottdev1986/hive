import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../schemas";
import { SessiondViewerAgentInput } from "./sessiond-agent-input";
import type { OrphanDiscardResult } from "./sessiond-host";
import type { SessiondViewerAttachClient } from "./sessiond-viewer-attach";
import type { InputReceipt, SessionInspection } from "./terminal-host-contract";

/**
 * The 2026-07-21 messaging regression, at the layer that has to end it.
 *
 * A human typed into an agent's pane and the viewer transport was then lost.
 * The arbiter orphaned the human claim to protect the unsubmitted draft (#40
 * never-steal), and from that moment every daemon inject was denied
 * HumanOrphaned — with no automated exit and no visible failure. These tests
 * pin the exit: after a bounded grace period the daemon discards the abandoned
 * orphan through the host and retries once, and it does NOT do so before the
 * grace period, does NOT do so when the host refuses, and never touches a LIVE
 * human claim.
 */

const timestamp = "2026-07-21T12:00:00.000Z";

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build delivery",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-delivery",
    tmuxSession: "hive-maya",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "hive-fixture",
      subject: { kind: "agent", agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000401",
      hostKind: "sessiond",
      engineBuildId: "engine-fixture",
    },
  };
}

const receipt: InputReceipt = {
  transactionId: "message-1",
  stage: "written-to-terminal",
  byteRange: { start: "0", endExclusive: "16" },
  orderedAt: "16",
  availableCreditBytes: 4096,
  consumedByProcess: "not-claimed",
  completeness: "complete",
  diagnostic: null,
};

/** A running session whose inspection reports the orphan as owner of record. */
function inspection(): SessionInspection {
  return {
    session: { key: "ses_018f1e90-7b5a-7cc0-8000-000000000401", incarnation: "7" },
    lifecycle: "running",
    completeness: "complete",
    host: null,
    child: null,
    jobControl: null,
    window: {
      value: { columns: 80, rows: 24, widthPixels: 640, heightPixels: 384 },
      revision: "1",
    },
    output: { closed: false, retained: { start: "0", endExclusive: "0" } },
    checkpoints: { retained: 0, newest: null },
    inputOwner: {
      token: "clm_018f1e90-7b5a-7cc0-8000-0000000000aa",
      writer: "workspace-pane",
      kind: "human",
      leaseExpiresAt: "2026-07-21T13:00:00.000Z",
    },
    exit: null,
    reap: {
      authority: "unavailable",
      reaped: false,
      status: null,
      completeness: "complete",
    },
    descendants: [],
    survivors: [],
    evidenceAt: timestamp,
    diagnostics: [],
  };
}

/**
 * A viewer wire whose arbiter denies automation with the arbiter's own
 * HumanOrphaned diagnostic until the orphan is discarded, then grants.
 */
class OrphanedArbiterWire {
  discarded = false;
  readonly attempts: string[] = [];

  client(): SessiondViewerAttachClient {
    return {
      injectAutomated: async (request: { transactionId: string }) => {
        this.attempts.push(request.transactionId);
        if (this.discarded) return { kind: "receipt" as const, receipt };
        return {
          kind: "claim-declined" as const,
          detail: "claim denied: HumanOrphaned",
        };
      },
      close: () => {},
    } as unknown as SessiondViewerAttachClient;
  }
}

function injector(
  wire: OrphanedArbiterWire,
  discard: () => Promise<OrphanDiscardResult>,
  now: () => number,
): SessiondViewerAgentInput {
  const broker = {
    async list() {
      return [inspection()];
    },
    async issueAttach() {
      return {
        schemaVersion: 1 as const,
        locator: agent().sessionLocator!,
        viewerId: "hive-daemon:test",
        token: "grant-token",
        geometry: {
          columns: 80,
          rows: 24,
          widthPx: 640,
          heightPx: 384,
          cellWidthPx: 8,
          cellHeightPx: 16,
        },
        afterSeq: "0",
        expiresAt: "2026-07-21T13:00:00.000Z",
      };
    },
  };
  return new SessiondViewerAgentInput(
    broker as unknown as ConstructorParameters<typeof SessiondViewerAgentInput>[0],
    "hive-daemon:test",
    async () => wire.client(),
    discard,
    now,
  );
}

const GRACE_MS = 120_000;

describe("HumanOrphaned deadlock exit (2026-07-21 messaging regression)", () => {
  test("POSITIVE CONTROL: a free arbiter injects with no discard at all", async () => {
    const wire = new OrphanedArbiterWire();
    wire.discarded = true; // Nothing is orphaned: the arbiter grants.
    let discards = 0;
    const result = await injector(wire, async () => {
      discards += 1;
      throw new Error("must not be called");
    }, () => 0).injectIdle(agent(), "hello", { messageId: "message-1" });

    expect(result.outcome).toBe("injected");
    expect(discards).toBe(0);
    expect(wire.attempts).toEqual(["message-1"]);
  });

  test("inside the grace period the orphan is left alone and the message stays queued", async () => {
    const wire = new OrphanedArbiterWire();
    let discards = 0;
    let clock = 1_000_000;
    const input = injector(wire, async () => {
      discards += 1;
      return {
        discarded: true,
        priorOwnerViewerId: "workspace-pane",
        priorClaimId: "clm",
        diagnostic: "orphaned human claim discarded",
      };
    }, () => clock);

    const first = await input.injectIdle(agent(), "hello", { messageId: "message-1" });
    expect(first.outcome).toBe("declined");
    expect(first.outcome === "declined" && first.reason).toContain("HumanOrphaned");
    expect(first.outcome === "declined" && first.reason).toContain("grace period");
    expect(discards).toBe(0);

    // Still inside the window one second before it closes.
    clock += GRACE_MS - 1_000;
    const second = await input.injectIdle(agent(), "hello", { messageId: "message-1" });
    expect(second.outcome).toBe("declined");
    expect(discards).toBe(0);
  });

  test("past the grace period the orphan is discarded and the inject retried once", async () => {
    const wire = new OrphanedArbiterWire();
    let discards = 0;
    let clock = 1_000_000;
    const input = injector(wire, async () => {
      discards += 1;
      wire.discarded = true;
      return {
        discarded: true,
        priorOwnerViewerId: "workspace-pane",
        priorClaimId: "clm_018f1e90-7b5a-7cc0-8000-0000000000aa",
        diagnostic: "orphaned human claim discarded",
      };
    }, () => clock);

    // First observation starts the clock; it does not discard.
    expect((await input.injectIdle(agent(), "hi", { messageId: "message-1" })).outcome)
      .toBe("declined");
    expect(discards).toBe(0);

    clock += GRACE_MS;
    const recovered = await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    expect(recovered.outcome).toBe("injected");
    expect(discards).toBe(1);
    expect(recovered.outcome === "injected" && recovered.recovery)
      .toContain("orphaned draft (owner workspace-pane) discarded after 120s; retrying");
    // Exactly one retry: the declined first attempt, then the post-discard one.
    expect(wire.attempts).toEqual(["message-1", "message-1", "message-1"]);
  });

  test("a host refusal is recorded, not retried — never-steal stays the host's call", async () => {
    const wire = new OrphanedArbiterWire();
    let clock = 1_000_000;
    const input = injector(wire, async () => ({
      discarded: false,
      priorOwnerViewerId: null,
      priorClaimId: null,
      diagnostic: "human_owned",
    }), () => clock);

    await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    clock += GRACE_MS;
    const refused = await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    expect(refused.outcome).toBe("declined");
    expect(refused.outcome === "declined" && refused.reason)
      .toContain("orphan discard refused: human_owned");
    // The retry never ran: two declined attempts, no third.
    expect(wire.attempts).toHaveLength(2);
  });

  test("an injector with no discard wire keeps the pre-fix decline-and-queue behaviour", async () => {
    const wire = new OrphanedArbiterWire();
    let clock = 1_000_000;
    const broker = {
      async list() {
        return [inspection()];
      },
      async issueAttach() {
        return {
          schemaVersion: 1 as const,
          locator: agent().sessionLocator!,
          viewerId: "hive-daemon:test",
          token: "grant-token",
          geometry: {
            columns: 80,
            rows: 24,
            widthPx: 640,
            heightPx: 384,
            cellWidthPx: 8,
            cellHeightPx: 16,
          },
          afterSeq: "0",
          expiresAt: "2026-07-21T13:00:00.000Z",
        };
      },
    };
    const input = new SessiondViewerAgentInput(
      broker as unknown as ConstructorParameters<typeof SessiondViewerAgentInput>[0],
      "hive-daemon:test",
      async () => wire.client(),
      undefined,
      () => clock,
    );
    await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    clock += GRACE_MS;
    const result = await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    expect(result.outcome).toBe("declined");
    expect(result.outcome === "declined" && result.reason)
      .toContain("orphan discard is not wired on this host");
  });
});
