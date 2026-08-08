// The agent-ui pane's HTTP boundary to the daemon. It accepts one agent subject and can never select the user credential path. The user CLI intentionally has a separate request client with no shared request helper.
import pRetry, { AbortError } from "p-retry";
import { isDaemonPort } from "../../shared/daemon-port";
import { agentFetch } from "../credential";
import { responseErrorDetail } from "../daemon-response";

export interface PaneDaemonClientOptions {
  readonly port: number;
  readonly subject: string;
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly retries?: number;
}

export class PaneDaemonClient {
  private readonly fetcher: NonNullable<PaneDaemonClientOptions["fetch"]>;

  constructor(private readonly options: PaneDaemonClientOptions) {
    if (!isDaemonPort(options.port)) {
      throw new Error("pane daemon client requires a connectable port");
    }
    this.fetcher = options.fetch ?? agentFetch(options.subject);
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    // Outer poll loops recover a pane after this request has exhausted its retries. They cannot save the launch burst itself, so transport failures and transient daemon responses retry here. Deterministic 4xx refusals surface immediately instead of multiplying rejected work.
    return await pRetry(
      async () => {
        const response = await this.fetcher(
          `http://127.0.0.1:${this.options.port}${path}`,
          init,
        );
        if (response.ok) return response;
        const error = Object.assign(new Error("pane daemon request refused"), {
          response,
        });
        if (response.status !== 429 && response.status < 500) {
          throw new AbortError(error);
        }
        throw error;
      },
      {
        retries: this.options.retries ?? 4,
        minTimeout: 250,
        maxTimeout: 2_000,
      },
    ).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        error.response instanceof Response
      ) {
        return error.response;
      }
      throw error;
    });
  }

  async errorDetail(response: Response): Promise<string> {
    return await responseErrorDetail(response);
  }
}
