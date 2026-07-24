import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../../src/schemas";
import type { SessionLocator } from "../../../src/schemas/session-protocol";
import { SessiondViewerAgentInput } from "../../../src/daemon/session-host/sessiond-agent-input";
import type { OrphanDiscardMode, OrphanDiscardResult } from "../../../src/daemon/session-host/sessiond-host";
import type { SessiondViewerAttachClient } from "../../../src/daemon/session-host/sessiond-viewer-attach";
import type { InputReceipt, SessionInspection } from "../../../src/daemon/session-host/terminal-host-contract";

/**
 * The 2026-07-21 messaging regression, at the layer that has to end it.
 *
 * A human typed into an agent's pane and the viewer transport was then lost.
 * The arbiter orphaned the human claim to protect the unsubmitted draft (#40
 * never-steal), and from that moment every daemon inject was denied
 * HumanOrphaned — with no automated exit and no visible failure. These tests
 * pin the exit: the host immediately resolves an orphan. An actively held
 * human claim wins and automation remains queued instead of preempting it.
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

const rootLocator: SessionLocator = {
  schemaVersion: 1,
  instanceId: "hive-fixture",
  subject: { kind: "root" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000401",
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
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
class HumanClaimArbiterWire {
  discarded = false;
  readonly attempts: string[] = [];

  constructor(private readonly claimState: "HumanOrphaned" | "HumanOwned" = "HumanOrphaned") {}

  client(): SessiondViewerAttachClient {
    return {
      injectAutomated: async (request: { transactionId: string }) => {
        this.attempts.push(request.transactionId);
        if (this.discarded) return { kind: "receipt" as const, receipt };
        return {
          kind: "claim-declined" as const,
          detail: `claim denied: ${this.claimState}`,
        };
      },
      close: () => {},
    } as unknown as SessiondViewerAttachClient;
  }
}

function injector(
  wire: HumanClaimArbiterWire,
  discard: (mode: OrphanDiscardMode) => Promise<OrphanDiscardResult>,
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
    (_, mode) => discard(mode),
  );
}

describe("HumanOrphaned deadlock exit (2026-07-21 messaging regression)", () => {
  test("POSITIVE CONTROL: a free arbiter injects with no discard at all", async () => {
    const wire = new HumanClaimArbiterWire();
    wire.discarded = true; // Nothing is orphaned: the arbiter grants.
    let discards = 0;
    const result = await injector(wire, async () => {
      discards += 1;
      throw new Error("must not be called");
    }).injectIdle(agent(), "hello", { messageId: "message-1" });

    expect(result.outcome).toBe("injected");
    expect(discards).toBe(0);
    expect(wire.attempts).toEqual(["message-1"]);
  });

  test("an orphan is discarded on the next delivery attempt and the host age is surfaced", async () => {
    const wire = new HumanClaimArbiterWire();
    const modes: OrphanDiscardMode[] = [];
    const recovered = await injector(wire, async (mode) => {
      modes.push(mode);
      wire.discarded = true;
      return {
        state: "discarded",
        priorOwnerViewerId: "workspace-pane",
        priorClaimId: "clm_018f1e90-7b5a-7cc0-8000-0000000000aa",
        orphanAgeMilliseconds: "120000",
        diagnostic: "orphaned human claim discarded",
      };
    }).injectIdle(agent(), "hi", { messageId: "message-1" });

    expect(recovered.outcome).toBe("injected");
    expect(modes).toEqual(["orphaned"]);
    expect(recovered.outcome === "injected" && recovered.recovery)
      .toContain("orphaned draft (owner workspace-pane) discarded after 120000ms; retrying");
    expect(wire.attempts).toEqual(["message-1", "message-1"]);
  });

  test("a held human claim is never preempted by automation", async () => {
    const wire = new HumanClaimArbiterWire("HumanOwned");
    const modes: OrphanDiscardMode[] = [];
    const result = await injector(wire, async (mode) => {
      modes.push(mode);
      throw new Error(`unexpected discard mode ${mode}`);
    }).injectIdle(agent(), "hi", { messageId: "message-1" });

    expect(result.outcome).toBe("declined");
    expect(modes).toEqual([]);
    expect(wire.attempts).toEqual(["message-1"]);
  });

  test("the root wake remains queued while the operator owns Queen input", async () => {
    const wire = new HumanClaimArbiterWire("HumanOwned");
    const modes: OrphanDiscardMode[] = [];
    const result = await injector(wire, async (mode) => {
      modes.push(mode);
      throw new Error(`unexpected discard mode ${mode}`);
    }).injectRoot(rootLocator, "wake queen", { messageId: "message-1" });

    expect(result.outcome).toBe("declined");
    expect(modes).toEqual([]);
    expect(wire.attempts).toEqual(["message-1"]);
  });

  test("a host refusal is recorded, not retried", async () => {
    const wire = new HumanClaimArbiterWire();
    const refused = await injector(wire, async () => ({
      state: "refused",
      priorOwnerViewerId: null,
      priorClaimId: null,
      orphanAgeMilliseconds: null,
      diagnostic: "human_owned",
    })).injectIdle(agent(), "hi", { messageId: "message-1" });

    expect(refused.outcome).toBe("declined");
    expect(refused.outcome === "declined" && refused.reason)
      .toContain("input-claim resolution refused: human_owned");
    expect(wire.attempts).toHaveLength(1);
  });

  test("an injector with no discard wire keeps the pre-fix decline-and-queue behaviour", async () => {
    const wire = new HumanClaimArbiterWire();
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
    );
    const result = await input.injectIdle(agent(), "hi", { messageId: "message-1" });
    expect(result.outcome).toBe("declined");
    expect(result.outcome === "declined" && result.reason)
      .toContain("input-claim resolution is not wired on this host");
  });
});
