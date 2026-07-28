import { credentialPath } from "../../../daemon/credentials";
import { shellQuote } from "../../../daemon/session-host/shell-session";

/**
 * The env var every provider except Claude reads its bearer from. Claude runs
 * `hive credential` as a headers helper instead, which needs no variable.
 */
export const HIVE_CAPABILITY_TOKEN_ENV = "HIVE_CAPABILITY_TOKEN";

/**
 * Prefixes an agent's launch shell command so its capability reaches the
 * provider through the environment, read at launch from the 0600 credential
 * file the daemon already writes outside every worktree.
 *
 * This exists so no provider config in the worktree has to contain the live
 * token. Hive runs on arbitrary repositories: a secret written into a project
 * file is one `git add -A` away from the user's branch, and an ignore rule
 * cannot help when the project already tracks that path.
 *
 * `$(cat …)` keeps the secret out of argv — `ps` shows this text, not the token
 * — and the command substitution drops the credential file's trailing newline.
 * The variable is inherited by the agent's own child processes, which is the
 * same exposure as the credential file itself: both are readable by any process
 * running as this user, and the capability is the agent's own.
 */
export function wrapSpawnWithCapabilityEnv(
  command: string,
  agentName: string,
): string {
  const path = shellQuote(credentialPath(agentName));
  return `${HIVE_CAPABILITY_TOKEN_ENV}="$(cat ${path})" ${command}`;
}
