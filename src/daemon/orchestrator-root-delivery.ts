import type { HiveDatabase } from "./db";
import type { RootDeliveryOutcome, RootProtocolDeliverer } from "./delivery";
import type { OrchestratorSessiondSnapshot } from "./orchestrator-sessiond";
import type { SessiondRootInput } from "./session-host/sessiond-agent-input";

export interface SessiondOrchestratorRootDeliveryDependencies {
  input: SessiondRootInput;
  db: Pick<
    HiveDatabase,
    | "beginMessageAttempt"
    | "finishMessageAttempt"
    | "getActiveProviderRunByTerminal"
  >;
  current: () => OrchestratorSessiondSnapshot | null;
  ready: () => boolean;
}

/** The host receipt returned by INPUT_SUBMIT is the only success boundary.
 * Preparing a locator, acquiring a claim, or enqueueing a message is never
 * enough to advance the durable queued/injected ladder. A host that is not
 * running and a host that declines input share one retain-and-retry contract —
 * but they are not the same fault, so each returns its own reason rather than a
 * shared `false`. Throws are reserved for malformed messages or transport
 * failures. */
export class SessiondOrchestratorRootDelivery implements RootProtocolDeliverer {
  constructor(
    private readonly dependencies: SessiondOrchestratorRootDeliveryDependencies,
  ) {}

  isLive(): boolean {
    return (
      this.dependencies.current()?.state === "running" &&
      this.dependencies.ready()
    );
  }

  async deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<RootDeliveryOutcome> {
    const current = this.dependencies.current();
    // Each refusal names itself. These three are adjacent expected states that
    // all retain-and-retry, but they are not the same fault, and reporting them
    // as one bit is what left three silent causes indistinguishable on the wire.
    if (current?.state !== "running") {
      return {
        delivered: false,
        reason: `root host is ${current?.state ?? "absent"}, not running`,
      };
    }
    if (!this.dependencies.ready()) {
      return { delivered: false, reason: "root host is not ready for input" };
    }
    const messageId = meta.message_id;
    if (messageId === undefined)
      throw new Error("root delivery has no message id");
    const run = this.dependencies.db.getActiveProviderRunByTerminal(
      current.locator,
    );
    if (run === null) {
      return {
        delivered: false,
        reason: "no active provider run is bound to the root terminal",
      };
    }
    const attempt = this.dependencies.db.beginMessageAttempt({
      attemptId: crypto.randomUUID(),
      messageId,
      expectedProviderRunId: run.runId,
      terminalGeneration: current.locator.generation,
      expectedForeground: {
        pid: run.pid,
        startToken: run.startToken,
        processGroupId: run.foregroundProcessGroupId,
      },
      attemptedAt: new Date().toISOString(),
    });
    let result: Awaited<ReturnType<SessiondRootInput["writeAutomated"]>>;
    try {
      result = await this.dependencies.input.writeAutomated({
        terminal: current.locator,
        expectedForeground: {
          providerRunId: run.runId,
          pid: run.pid,
          startToken: run.startToken,
          processGroupId: run.foregroundProcessGroupId,
        },
        bytes: new TextEncoder().encode(`\x1b[200~${content}\x1b[201~\r`),
        idempotencyKey: attempt.attemptId,
      });
    } catch (error) {
      this.dependencies.db.finishMessageAttempt(attempt.attemptId, {
        outcome:
          error instanceof Error && error.message.includes("timed out")
            ? "timeout"
            : "unknown",
        terminalReceipt: null,
      });
      throw error;
    }
    if (result.outcome === "declined") {
      this.dependencies.db.finishMessageAttempt(attempt.attemptId, {
        outcome: result.reason.includes("foreground-changed")
          ? "foreground-changed"
          : result.reason.startsWith("claim ")
            ? "input-busy"
            : "unknown",
        terminalReceipt: result.receipt ?? null,
      });
      // The host's own words, not the bucket they were sorted into: the
      // attempt outcome above is a coarse enum, and the enum is not the
      // diagnostic. `claim held by <who> until <when>` is the sentence that
      // ends an investigation.
      return { delivered: false, reason: result.reason };
    }
    this.dependencies.db.finishMessageAttempt(attempt.attemptId, {
      outcome: "written",
      terminalReceipt: result.receipt,
    });
    // `declined` is handled above and the outcome union has no third member, so
    // reaching here is the INPUT_SUBMIT receipt itself — the only success
    // boundary this class recognises.
    return { delivered: true };
  }
}
