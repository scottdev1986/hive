import type { HiveDatabase } from "./db";
import type { RootProtocolDeliverer } from "./delivery";
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
  canInject?: () => Promise<boolean>;
}

/** The host receipt returned by INPUT_SUBMIT is the only success boundary.
 * Preparing a locator, acquiring a claim, or enqueueing a message is never
 * enough to advance the durable queued/injected ladder. A host that is not
 * running and a host that declines input both return false: adjacent expected
 * non-delivery states share one retain-and-retry contract. Throws are reserved
 * for malformed messages or transport failures. */
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
  ): Promise<boolean> {
    const current = this.dependencies.current();
    if (current?.state !== "running" || !this.dependencies.ready())
      return false;
    if (
      this.dependencies.canInject !== undefined &&
      !(await this.dependencies.canInject())
    ) {
      return false;
    }
    const messageId = meta.message_id;
    if (messageId === undefined)
      throw new Error("root delivery has no message id");
    const run = this.dependencies.db.getActiveProviderRunByTerminal(
      current.locator,
    );
    if (run === null) return false;
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
      return false;
    }
    this.dependencies.db.finishMessageAttempt(attempt.attemptId, {
      outcome: "written",
      terminalReceipt: result.receipt,
    });
    return result.outcome === "injected";
  }
}
