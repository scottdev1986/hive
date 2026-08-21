import {
  type ProviderPermissionDecision,
  ProviderPermissionDecisionsSchema,
  type ProviderPermissionSettlementOutcome,
} from "../../schemas/provider-permission";
import { definedFields } from "../../shared/defined-fields";
import { decodeJson } from "../daemon-response";
import { PaneDaemonClient } from "./pane-daemon-client";

export type { ProviderPermissionDecision, ProviderPermissionSettlementOutcome };

export class ProviderPermissionClient {
  private readonly daemon: PaneDaemonClient;

  constructor(
    port: number,
    subject: string,
    fetcher?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
  ) {
    this.daemon = new PaneDaemonClient({
      port,
      subject,
      ...definedFields({ fetch: fetcher }),
    });
  }

  async report(requestId: string, description: string): Promise<void> {
    const response = await this.daemon.request("/provider-permission/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, description }),
    });
    if (!response.ok) {
      throw new Error(
        `provider permission report failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
  }

  async poll(): Promise<readonly ProviderPermissionDecision[]> {
    const response = await this.daemon.request(
      "/provider-permission/decisions",
    );
    if (!response.ok) {
      throw new Error(
        `provider permission poll failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
    return ProviderPermissionDecisionsSchema.parse(await decodeJson(response))
      .decisions;
  }

  async settle(
    requestId: string,
    outcome: ProviderPermissionSettlementOutcome,
  ): Promise<void> {
    const response = await this.daemon.request("/provider-permission/settled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, outcome }),
    });
    if (!response.ok) {
      throw new Error(
        `provider permission settlement failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
  }

  async acknowledge(approvalId: string): Promise<void> {
    const response = await this.daemon.request("/provider-permission/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId }),
    });
    if (!response.ok) {
      throw new Error(
        `provider permission ack failed: ${response.status} ${await this.daemon.errorDetail(response)}`,
      );
    }
  }
}
