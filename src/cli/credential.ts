// Credential plumbing for every process that talks to the daemon.
//
// Claude Code runs `hive credential --agent NAME` at MCP connect time
// (`headersHelper`) and reads a JSON header map from stdout. Nothing is passed
// through the environment, so an agent's descendants inherit no token; nothing
// is passed through argv, so `ps` reveals no secret. The agent name is not a
// secret and is the only thing on the command line.
import { OPERATOR_SUBJECT, readCredential } from "../daemon/credentials";

export function authorizationHeaders(
  subject: string,
): Record<string, string> | null {
  const token = readCredential(subject);
  return token === null ? null : { Authorization: `Bearer ${token}` };
}

/** Headers for the human's `hive` CLI. */
export function operatorHeaders(): Record<string, string> {
  const headers = authorizationHeaders(OPERATOR_SUBJECT);
  if (headers === null) {
    throw new Error(
      "No Hive operator credential is available. The daemon mints it at " +
        "startup; start one with `hive claude` or `hive codex`.",
    );
  }
  return headers;
}

// `init.headers` is often a Headers instance (the MCP client builds one), and
// spreading a Headers instance yields an empty object — silently dropping the
// caller's Accept and Content-Type. Merge through the Headers API instead.
function withAuthorization(
  init: RequestInit | undefined,
  authorization: Record<string, string> | null,
): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(authorization ?? {})) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

/** A fetch that presents the operator credential on every request. */
export function operatorFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, withAuthorization(init, operatorHeaders()));
}

/** A fetch that presents one agent's credential. */
export function agentFetch(
  agent: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) =>
    fetch(input, withAuthorization(init, authorizationHeaders(agent)));
}

/** `hive credential --agent NAME` — the Claude Code `headersHelper` contract:
 * a JSON object of headers on stdout, exit 0. */
export function runCredentialHelper(subject: string): 0 | 1 {
  const headers = authorizationHeaders(subject);
  if (headers === null) {
    console.error(`No Hive credential for ${subject}`);
    return 1;
  }
  console.log(JSON.stringify(headers));
  return 0;
}
