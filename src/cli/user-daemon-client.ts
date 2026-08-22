import { verifyDaemonInstance } from "../daemon/lifecycle/handshake";
import { hiveInstanceSuffix } from "../hive-home/home";
import { isDaemonPort } from "../shared/daemon-port";
import { userFetch } from "./credential";
import type { JsonValue } from "../shared/json";
import { daemonErrorDetail, decodeJson } from "./daemon-response";

export { daemonErrorDetail, decodeJson } from "./daemon-response";

export type AuthorizedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DaemonFailurePolicy = "throw" | "return-null";

export interface UserDaemonClientOptions {
  readonly port: number;
  readonly fetch?: AuthorizedFetch;
  readonly verify?: (port: number, instanceId: string) => Promise<void>;
  readonly instanceId?: string;
  readonly verifyIdentity?: boolean;
}

export class UserDaemonClient {
  readonly port: number;
  private readonly fetcher: AuthorizedFetch;
  private readonly verify: () => Promise<void>;
  private verified: Promise<void> | null = null;

  constructor(options: UserDaemonClientOptions) {
    if (!isDaemonPort(options.port)) {
      throw new Error("user daemon client requires a connectable port");
    }
    this.port = options.port;
    this.fetcher = options.fetch ?? userFetch;
    const verify =
      options.verifyIdentity === false
        ? async (): Promise<void> => {}
        : (options.verify ?? verifyDaemonInstance);
    const instanceId = options.instanceId ?? hiveInstanceSuffix();
    this.verify = () => verify(this.port, instanceId);
  }

  async connect(): Promise<void> {
    this.verified ??= this.verify();
    await this.verified;
  }

  async verifyConnection(): Promise<void> {
    await this.verify();
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    await this.connect();
    return await this.fetcher(`http://127.0.0.1:${this.port}${path}`, init);
  }

  async json(
    path: string,
    init: RequestInit | undefined,
    failure: DaemonFailurePolicy,
  ): Promise<JsonValue | null> {
    const response = await this.request(path, init);
    const body = await decodeJson(response);
    if (response.ok) return body;
    if (failure === "return-null") return null;
    throw new Error(
      daemonErrorDetail(body, `daemon request failed (HTTP ${response.status})`)
        .message,
    );
  }
}
