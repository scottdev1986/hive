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
 * acceptance, or `null` when the inject was declined (a human owns the input
 * arbiter, or the session is not injectable right now) — the caller then leaves
 * the envelope queued. Never fabricates `applied`.
 */
export interface SessiondAgentInput {
  injectIdle(
    agent: AgentRecord,
    text: string,
    options: Readonly<{ messageId: string }>,
  ): Promise<InputReceipt | null>;
}

/** The two broker RPCs this injector needs, already landed and tested. */
type BrokerFacade = Pick<SessionHost, "issueAttach"> & Pick<TerminalHost, "inspect">;

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
  ): Promise<InputReceipt | null> {
    const locator = requireSessiondAgentLocator(agent);
    const session = {
      key: locator.sessionId,
      incarnation: String(locator.generation),
    };
    const inspection: SessionInspection = await this.broker.inspect(session);
    if (inspection.lifecycle !== "running") return null;

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
      return await client.injectAutomated({
        session,
        writer: this.viewerId,
        transactionId: options.messageId,
        idempotencyKey: options.messageId,
        bytes,
        leaseMilliseconds: CLAIM_LEASE_MS,
      });
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
