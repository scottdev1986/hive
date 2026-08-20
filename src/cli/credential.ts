// Credential plumbing for every process that talks to the daemon. Claude Code runs `hive credential --agent NAME` at MCP connect time (`headersHelper`) and reads a JSON header map from stdout. Nothing is passed through the environment, so an agent's descendants inherit no token; nothing is passed through argv, so `ps` reveals no secret. The agent name is not a secret and is the only thing on the command line.
import {
  readCredential,
  USER_SUBJECT,
} from "../daemon/authorization/credentials";
import { bindCliHiveHome } from "./bind-hive-home";

export function authorizationHeaders(
  subject: string,
): Record<string, string> | null {
  bindCliHiveHome();
  const token = readCredential(subject);
  return token === null ? null : { Authorization: `Bearer ${token}` };
}

export function userHeaders(): Record<string, string> {
  const headers = authorizationHeaders(USER_SUBJECT);
  if (headers === null) {
    throw new Error(
      "no user credential is available; the daemon mints one at startup\n" +
        "Fix: start a daemon with `hive`",
    );
  }
  return headers;
}

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

/** A fetch that presents the user credential on every request. */
export function userFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, withAuthorization(init, userHeaders()));
}

/** A fetch that presents one agent's credential. */
export function agentFetch(
  agent: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) =>
    fetch(input, withAuthorization(init, authorizationHeaders(agent)));
}

/** `hive credential --agent NAME` — the Claude Code `headersHelper` contract: a JSON object of headers on stdout, exit 0. */
export function runCredentialHelper(subject: string): 0 | 1 {
  const headers = authorizationHeaders(subject);
  if (headers === null) {
    console.error(`no credential for ${subject}`);
    return 1;
  }
  console.log(JSON.stringify(headers));
  return 0;
}
