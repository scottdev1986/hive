import type { RootProtocolDeliverer } from "./delivery";
import type { OrchestratorSessiondSnapshot } from "./orchestrator-sessiond";
import type { SessiondRootInput } from "./session-host/sessiond-agent-input";

export interface SessiondOrchestratorRootDeliveryDependencies {
  input: SessiondRootInput;
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
    return this.dependencies.current()?.state === "running" &&
      this.dependencies.ready();
  }

  async deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    const current = this.dependencies.current();
    if (current?.state !== "running" || !this.dependencies.ready()) return false;
    if (
      this.dependencies.canInject !== undefined &&
      !await this.dependencies.canInject()
    ) {
      return false;
    }
    const messageId = meta.message_id;
    if (messageId === undefined) throw new Error("root delivery has no message id");
    const result = await this.dependencies.input.injectRoot(
      current.locator,
      content,
      { messageId },
    );
    return result.outcome === "injected";
  }
}
