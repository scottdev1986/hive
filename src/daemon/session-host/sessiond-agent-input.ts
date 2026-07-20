import type { AgentRecord } from "../../schemas";
import type { TerminalGeometry } from "../../schemas/session-protocol";
import { requireSessiondAgentLocator } from "./hive-terminal-host";
import type { SessionHost } from "./contract";
import type { SessionInspection, WindowSize, InputReceipt } from "./terminal-host-contract";
import type { TerminalHost } from "./terminal-host-contract";
import {
  SessiondViewerAttachClient,
  type ViewerAttachDependencies,
} from "./sessiond-viewer-attach";

/** Bracketed paste so embedded newlines are captured as one paste, then a
 * carriage return outside the paste submits it — the exact shape the tmux path
 * produces with `paste-buffer -p` followed by `send-keys Enter`. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SUBMIT = "\r";

const CLAIM_LEASE_MS = 60_000;

/**
 * Injects one automated message into an idle sessiond-hosted agent over the
 * §20 neutral-host viewer wire. Returns the frozen receipt on `INPUT_SUBMIT`
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
  | Readonly<{ outcome: "injected"; receipt: InputReceipt }>
  | Readonly<{ outcome: "declined"; reason: string }>;

export interface SessiondAgentInput {
  injectIdle(
    agent: AgentRecord,
    text: string,
    options: Readonly<{ messageId: string }>,
  ): Promise<SessiondInjectResult>;
}

/** The two broker RPCs this injector needs, already landed and tested. */
type BrokerFacade = Pick<SessionHost, "issueAttach"> & Pick<TerminalHost, "list">;

export class SessiondViewerAgentInput implements SessiondAgentInput {
  constructor(
    private readonly broker: BrokerFacade,
    private readonly viewerId: string,
    private readonly attach: (
      deps: ViewerAttachDependencies,
    ) => Promise<SessiondViewerAttachClient> = SessiondViewerAttachClient.attach,
  ) {}

  async injectIdle(
    agent: AgentRecord,
    text: string,
    options: Readonly<{ messageId: string }>,
  ): Promise<SessiondInjectResult> {
    const locator = requireSessiondAgentLocator(agent);
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
        reason: matches.length === 0
          ? `session ${locator.sessionId} not found on the sessiond host`
          : `session ${locator.sessionId} is ambiguous on the sessiond host`,
      };
    }
    const inspection: SessionInspection = matches[0]!;
    if (inspection.lifecycle !== "running") {
      return {
        outcome: "declined",
        reason: `session lifecycle is ${inspection.lifecycle}, not running`,
      };
    }
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

    const client = await this.attach({ locator, grant, geometry, viewerId: this.viewerId });
    try {
      const bytes = new TextEncoder().encode(
        BRACKETED_PASTE_START + text + BRACKETED_PASTE_END + SUBMIT,
      );
      const result = await client.injectAutomated({
        session,
        writer: this.viewerId,
        transactionId: options.messageId,
        idempotencyKey: options.messageId,
        bytes,
        leaseMilliseconds: CLAIM_LEASE_MS,
      });
      if (result.kind === "claim-declined") {
        return { outcome: "declined", reason: result.detail };
      }
      const receipt = result.receipt;
      if (receipt.stage === "rejected" || receipt.stage === "unknown") {
        return {
          outcome: "declined",
          reason: `input receipt stage ${receipt.stage}` +
            (receipt.diagnostic === null ? "" : `: ${receipt.diagnostic}`),
        };
      }
      return { outcome: "injected", receipt };
    } finally {
      client.close();
    }
  }
}

/**
 * A §20 `AttachRequest`/`HOST_ATTACH` geometry derived from the host's inspected
 * window. Cell pixel sizes are recovered from the window pixels; a zero-pixel
 * (headless) window falls back to conventional 8×16 cells so the geometry stays
 * schema-valid.
 */
function geometryFromWindow(window: WindowSize): TerminalGeometry {
  const cellWidthPx = window.widthPixels > 0 ? window.widthPixels / window.columns : 8;
  const cellHeightPx = window.heightPixels > 0 ? window.heightPixels / window.rows : 16;
  const widthPx = window.widthPixels > 0
    ? window.widthPixels
    : Math.round(window.columns * cellWidthPx);
  const heightPx = window.heightPixels > 0
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
