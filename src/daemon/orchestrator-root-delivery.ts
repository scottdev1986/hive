import { orchestratorTmuxSession } from "./orchestrator-lifecycle";
import type { RootProtocolDeliverer, TmuxSender } from "./delivery";
import type { OrchestratorSessiondSnapshot } from "./orchestrator-sessiond";
import type { SessiondRootInput } from "./session-host/sessiond-agent-input";

export interface OrchestratorRootDeliveryDependencies {
  tmux: TmuxSender;
}

/**
 * Deliver a root wake through the instance-scoped terminal. The sender pastes
 * and submits as separate operations, while MessageDelivery holds the root
 * composer lease and session lock around this call. This is the one transport
 * all three visible TUIs actually expose concurrently; Codex app-server closes
 * a second client while its remote TUI is attached.
 */
export class OrchestratorRootDelivery implements RootProtocolDeliverer {
  constructor(
    private readonly dependencies: OrchestratorRootDeliveryDependencies,
  ) {}

  isLive(): boolean {
    return true;
  }

  async deliverMessage(
    content: string,
    _meta: Record<string, string>,
  ): Promise<boolean> {
    await this.dependencies.tmux.sendMessage(
      orchestratorTmuxSession(),
      content,
    );
    return true;
  }
}

export interface SessiondOrchestratorRootDeliveryDependencies {
  input: SessiondRootInput;
  current: () => OrchestratorSessiondSnapshot | null;
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
    return this.dependencies.current()?.state === "running";
  }

  async deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    const current = this.dependencies.current();
    if (current?.state !== "running") return false;
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
