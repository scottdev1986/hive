import { describe, expect, test } from "bun:test";
import { OrchestratorRootDelivery } from "./orchestrator-root-delivery";
import { orchestratorTmuxSession } from "./orchestrator-lifecycle";

function tmux() {
  return {
    calls: [] as Array<{ session: string; text: string }>,
    async sendMessage(session: string, text: string) {
      this.calls.push({ session, text });
    },
  };
}

describe("OrchestratorRootDelivery", () => {
  for (const tool of ["claude", "codex", "grok"] as const) {
    test(`submits agent reports into the live ${tool} root`, async () => {
      const sender = tmux();
      const delivery = new OrchestratorRootDelivery({ tmux: sender });

      expect(await delivery.deliverMessage("agent report", {})).toEqual(true);
      expect(sender.calls).toEqual([{
        session: orchestratorTmuxSession(),
        text: "agent report",
      }]);
      expect(delivery.isLive()).toEqual(true);
    });
  }
});
