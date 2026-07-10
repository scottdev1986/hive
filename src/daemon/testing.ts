// Test-only credential plumbing for embedded daemons.
//
// A production caller reads its token from a 0600 credential file the daemon
// wrote at spawn. An in-process test has no such file, so it mints directly
// against the daemon's store and presents the token exactly as a real client
// would: an `Authorization: Bearer` header on every request.
import type { Role } from "./capabilities";
import type { HiveDaemon } from "./server";

export type AuthorizedFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Returns a fetch bound to one subject's freshly minted capability. Use the
 * role the real caller would hold: `writer` for an agent, `orchestrator` for
 * the root, `operator` for the human's CLI. */
export function actingAs(
  daemon: HiveDaemon,
  subject: string,
  role: Role = "operator",
  options: { epoch?: number } = {},
): AuthorizedFetch {
  const { token } = daemon.capabilities.mint(subject, role, {
    epoch: options.epoch ?? 0,
  });
  return (input, init) => {
    // Headers must merge through the Headers API: spreading a Headers instance
    // yields {} and would strip the MCP client's Accept header.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };
}
