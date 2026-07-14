import { orchestratorTmuxSession } from "./orchestrator-lifecycle";
import type { RootProtocolDeliverer, TmuxSender } from "./delivery";

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
