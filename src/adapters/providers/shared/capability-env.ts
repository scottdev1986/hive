import { credentialPath } from "../../../hive-home/home";
import { shellQuote } from "../../../shared/shell-quote";

/** The env var every provider except Claude reads its bearer from. Claude runs `hive credential` as a headers helper instead, which needs no variable. */
export const HIVE_CAPABILITY_TOKEN_ENV = "HIVE_CAPABILITY_TOKEN";

/** Prefixes an agent's launch shell command so its capability reaches the provider through the environment, read at launch from the 0600 credential file the daemon already writes outside every worktree. This exists so no provider config in the worktree has to contain the live token. Hive runs on arbitrary repositories: a secret written into a project file is one `git add -A` away from the user's branch, and an ignore rule cannot help when the project already tracks that path. `$(cat …)` keeps the secret out of argv — `ps` shows this text, not the token — and the command substitution drops the credential file's trailing newline. The variable is inherited by the agent's own child processes, which is the same exposure as the credential file itself: both are readable by any process running as this user, and the capability is the agent's own. */
export function wrapSpawnWithCapabilityEnv(
  command: string,
  agentName: string,
  executable: string,
): string {
  requireCommandToTakeTheAssignment(command, executable);
  const path = shellQuote(credentialPath(agentName));
  return `${HIVE_CAPABILITY_TOKEN_ENV}="$(cat ${path})" ${command}`;
}

const LEADING_ASSIGNMENT =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|"[^"]*"|\S*)\s+/;

/** Refuse a command the capability assignment above would not reach. A leading `NAME=value` binds to one simple command, so it only reaches the provider when the command runs the executable directly — bare, or behind other assignments. Prepending anything that runs first, as a `mkdir … && install … && <launch>` copy step once did, hands the token to that step instead and the provider starts with no bearer at all. Nothing reports it: the launch succeeds and the agent simply has no Hive tools. Throwing is the point. This is the last wrapper applied, so it is the one place that can still see whether the composed command kept its shape. */
function requireCommandToTakeTheAssignment(
  command: string,
  executable: string,
): void {
  let rest = command;
  while (LEADING_ASSIGNMENT.test(rest)) {
    rest = rest.replace(LEADING_ASSIGNMENT, "");
  }
  if (rest.startsWith(executable) || rest.startsWith(shellQuote(executable))) {
    return;
  }
  throw new Error(
    `${HIVE_CAPABILITY_TOKEN_ENV} would not reach ${executable}: the launch ` +
      `command runs something else first (${rest.slice(0, 40)}). Prepare the ` +
      `worktree before launching instead of prefixing a command.`,
  );
}
