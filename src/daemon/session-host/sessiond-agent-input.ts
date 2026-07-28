import type { AgentRecord } from "../../schemas";
import type { AutomatedInput, SessionHost, TerminalGeometry } from "./contract";
import { requireSessiondAgentLocator } from "./hive-terminal-host";
import type { OrphanDiscardMode, OrphanDiscardResult } from "./sessiond-host";
import {
  SessiondViewerAttachClient,
  type ViewerAttachDependencies,
} from "./sessiond-viewer-attach";
import type {
  ExpectedForeground,
  InputReceipt,
  SessionInspection,
  TerminalHost,
  WindowSize,
} from "./terminal-host-contract";

const CLAIM_LEASE_MS = 60_000;

/** The arbiter's own name for "a human's abandoned draft owns input". */
const HUMAN_ORPHANED = "HumanOrphaned";

/** Encode one terminal composer submission at the terminal transport boundary. */
export function encodeSubmittedText(text: string): Uint8Array {
  return new TextEncoder().encode(`\x1b[200~${text}\x1b[201~\r`);
}

/**
 * Injects one automated message into an idle sessiond-hosted agent over the
 * Neutral-host viewer wire. Returns the frozen receipt on `INPUT_SUBMIT`
 * acceptance, or a decline naming its cause (a human owns the input arbiter,
 * the session is not injectable right now, the host rejected the receipt) —
 * the caller then leaves the envelope queued AND records the reason on the
 * message row. Never fabricates `applied`.
 *
 * The decline carries a reason because the #68 live proof failed exactly
 * here: a bare null left "claim denied" indistinguishable from "wire broken"
 * with the only diagnostic on a /dev/null stderr.
 */
export type SessiondInjectResult =
  | Readonly<{ outcome: "injected"; receipt: InputReceipt; recovery?: string }>
  | Readonly<{
      outcome: "declined";
      reason: string;
      receipt?: InputReceipt;
    }>;

export interface SessiondAgentInput {
  writeAutomated(input: AutomatedInput): Promise<SessiondInjectResult>;
  /**
   * Send raw keys to a session parked on a vendor prompt. Not a message: no
   * bracketed paste and no submit, because the bytes ARE the keystroke the
   * widget is waiting for. Absent on hosts that predate #102, which means the
   * decision cannot be delivered — never that it was.
   */
  injectKeys?(
    agent: AgentRecord,
    keys: string,
    options: Readonly<{
      transactionId: string;
      isPromptPending: () => boolean;
      expectedForeground: ExpectedForeground;
    }>,
  ): Promise<SessiondInjectResult>;
}

export interface SessiondRootInput {
  writeAutomated(input: AutomatedInput): Promise<SessiondInjectResult>;
}

/** The broker RPCs this injector needs. */
type BrokerFacade = Pick<SessionHost, "issueAttach"> &
  Pick<TerminalHost, "list">;

/** Orphan discard, absent on hosts that predate it — an injector built
 * without it keeps the pre-fix behaviour: decline and stay queued. */
type OrphanDiscarder = (
  locator: AutomatedInput["terminal"],
  mode: OrphanDiscardMode,
) => Promise<OrphanDiscardResult>;

export class SessiondViewerAgentInput
  implements SessiondAgentInput, SessiondRootInput
{
  constructor(
    private readonly broker: BrokerFacade,
    private readonly viewerId: string,
    private readonly attach: (
      deps: ViewerAttachDependencies,
    ) => Promise<SessiondViewerAttachClient> = SessiondViewerAttachClient.attach,
    private readonly discardOrphan: OrphanDiscarder = async () => ({
      state: "refused",
      priorOwnerViewerId: null,
      priorClaimId: null,
      orphanAgeMilliseconds: null,
      diagnostic: "input-claim resolution is not wired on this host",
    }),
  ) {}

  async writeAutomated(input: AutomatedInput): Promise<SessiondInjectResult> {
    return this.submit(
      input.terminal,
      input.bytes,
      input.idempotencyKey,
      undefined,
      {
        pid: input.expectedForeground.pid,
        startToken: input.expectedForeground.startToken,
        processGroupId: input.expectedForeground.processGroupId,
      },
    );
  }

  async injectKeys(
    agent: AgentRecord,
    keys: string,
    options: Readonly<{
      transactionId: string;
      isPromptPending: () => boolean;
      expectedForeground: ExpectedForeground;
    }>,
  ): Promise<SessiondInjectResult> {
    return this.submit(
      requireSessiondAgentLocator(agent),
      new TextEncoder().encode(keys),
      options.transactionId,
      options.isPromptPending,
      options.expectedForeground,
    );
  }

  private async submit(
    locator: AutomatedInput["terminal"],
    bytes: Uint8Array,
    transactionId: string,
    isPromptPending?: () => boolean,
    expectedForeground?: ExpectedForeground,
  ): Promise<SessiondInjectResult> {
    // TWO SessionRef incarnation semantics meet here, and confusing them is
    // exactly how the #68 live proof failed silently on every tick:
    //   - BROKER RPCs (list/inspect) address sessions by the ENGINE-assigned
    //     incarnation. A locator-generation ref gets NOT_FOUND.
    //   - VIEWER-WIRE frames (CLAIM_ACQUIRE/INPUT_SUBMIT/CLAIM_RELEASE) map
    //     generation→incarnation (session_host.zig, and the Swift reference
    //     client AttachReplayClient sends String(locator.generation)). An
    //     engine-assigned ref gets GENERATION_MISMATCH.
    // So: discover lifecycle via the broker's own list, but speak to the
    // host with the locator-derived ref. Both proven against the real engine
    // in native/sessiond/test/ts-live-create.ts.
    const sessions = await this.broker.list();
    const matches = sessions.filter(
      (candidate) => candidate.session.key === locator.sessionId,
    );
    if (matches.length !== 1) {
      return {
        outcome: "declined",
        reason:
          matches.length === 0
            ? `session ${locator.sessionId} not found on the sessiond host`
            : `session ${locator.sessionId} is ambiguous on the sessiond host`,
      };
    }
    const inspection = matches[0];
    if (inspection === undefined) {
      return { outcome: "declined", reason: "session inspection disappeared" };
    }
    if (inspection.lifecycle !== "running") {
      return {
        outcome: "declined",
        reason: `session lifecycle is ${inspection.lifecycle}, not running`,
      };
    }
    const first = await this.submitOnce(
      locator,
      inspection,
      bytes,
      transactionId,
      isPromptPending,
      expectedForeground,
    );
    if (first.outcome !== "declined") return first;
    if (!first.reason.includes(HUMAN_ORPHANED)) return first;
    return this.resolveOrphanedHumanClaim(
      locator,
      inspection,
      bytes,
      transactionId,
      first.reason,
      isPromptPending,
      expectedForeground,
    );
  }

  /**
   * Discard an abandoned draft, then retry exactly once. A live human claim
   * never reaches this path: automation stays queued until the operator's turn
   * ends.
   *
   * Run-bound writes retry here too. They used to return the orphan decline
   * untouched, which left every real caller — both of them pass an
   * `expectedForeground` — permanently deadlocked behind a departed human's
   * draft. Run-binding is not weakened by retrying: the host revalidates
   * `expectedForeground` at INPUT_SUBMIT and rejects `foreground-changed`.
   */
  private async resolveOrphanedHumanClaim(
    locator: ReturnType<typeof requireSessiondAgentLocator>,
    inspection: SessionInspection,
    bytes: Uint8Array,
    transactionId: string,
    declineReason: string,
    isPromptPending?: () => boolean,
    expectedForeground?: ExpectedForeground,
  ): Promise<SessiondInjectResult> {
    let discard: OrphanDiscardResult;
    try {
      discard = await this.discardOrphan(locator, "orphaned");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        outcome: "declined",
        reason: `${declineReason}; input-claim resolution failed: ${detail}`,
      };
    }
    if (discard.state === "refused") {
      return {
        outcome: "declined",
        reason: `${declineReason}; input-claim resolution refused: ${discard.diagnostic}`,
      };
    }
    if (discard.state !== "discarded") {
      return {
        outcome: "declined",
        reason: `${declineReason}; orphan discard returned unexpected state ${discard.state}`,
      };
    }
    const recovery = `orphaned draft (owner ${discard.priorOwnerViewerId}) discarded after ${discard.orphanAgeMilliseconds}ms; retrying`;
    const retried = await this.submitOnce(
      locator,
      inspection,
      bytes,
      transactionId,
      isPromptPending,
      expectedForeground,
    );
    if (retried.outcome === "declined") {
      return {
        outcome: "declined",
        reason: `${recovery}; retry declined: ${retried.reason}`,
      };
    }
    return { ...retried, recovery };
  }

  /** One attach → claim → submit → close cycle. */
  private async submitOnce(
    locator: AutomatedInput["terminal"],
    inspection: SessionInspection,
    bytes: Uint8Array,
    transactionId: string,
    isPromptPending?: () => boolean,
    expectedForeground?: ExpectedForeground,
  ): Promise<SessiondInjectResult> {
    const session = {
      key: locator.sessionId,
      incarnation: String(locator.generation),
    };

    const geometry = geometryFromWindow(inspection.window.value);
    const grant = await this.broker.issueAttach(locator, {
      viewerId: this.viewerId,
      geometry,
      operations: ["view", "human-input"],
    });

    const client = await this.attach({
      locator,
      grant,
      geometry,
      viewerId: this.viewerId,
    });
    try {
      const result = await client.injectAutomated({
        session,
        writer: this.viewerId,
        transactionId,
        idempotencyKey: transactionId,
        bytes,
        leaseMilliseconds: CLAIM_LEASE_MS,
        ...(expectedForeground === undefined ? {} : { expectedForeground }),
        isPromptPending,
      });
      if (result.kind === "stale") {
        return { outcome: "declined", reason: "approval prompt is stale" };
      }
      if (result.kind === "claim-declined") {
        return { outcome: "declined", reason: result.detail };
      }
      const receipt = result.receipt;
      if (receipt.stage === "rejected" || receipt.stage === "unknown") {
        return {
          outcome: "declined",
          reason:
            `input receipt stage ${receipt.stage}` +
            (receipt.diagnostic === null ? "" : `: ${receipt.diagnostic}`),
          receipt,
        };
      }
      return { outcome: "injected", receipt };
    } finally {
      client.close();
    }
  }
}

/**
 * An `AttachRequest`/`HOST_ATTACH` geometry derived from the host's inspected
 * window. Cell pixel sizes are recovered from the window pixels; a zero-pixel
 * (headless) window falls back to conventional 8×16 cells so the geometry stays
 * schema-valid.
 */
function geometryFromWindow(window: WindowSize): TerminalGeometry {
  const cellWidthPx =
    window.widthPixels > 0 ? window.widthPixels / window.columns : 8;
  const cellHeightPx =
    window.heightPixels > 0 ? window.heightPixels / window.rows : 16;
  const widthPx =
    window.widthPixels > 0
      ? window.widthPixels
      : Math.round(window.columns * cellWidthPx);
  const heightPx =
    window.heightPixels > 0
      ? window.heightPixels
      : Math.round(window.rows * cellHeightPx);
  return {
    columns: window.columns,
    rows: window.rows,
    widthPx,
    heightPx,
    cellWidthPx,
    cellHeightPx,
  };
}
