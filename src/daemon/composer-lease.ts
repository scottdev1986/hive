import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isOrchestratorName,
  orchestratorRecipientNames,
} from "../schemas";
import { getHiveHome } from "./db";

const RECIPIENT = /^[a-z][a-z0-9-]*$/;

/**
 * Workspace creates this instance-scoped marker synchronously before the
 * user's first composer keystroke reaches a terminal. Delivery checks the
 * marker before every transport action, so Hive never pastes over a draft.
 */
export function composerLeasePath(
  recipient: string,
  hiveHome = getHiveHome(),
): string {
  if (!RECIPIENT.test(recipient)) {
    throw new Error(`Invalid composer recipient: ${recipient}`);
  }
  return join(hiveHome, "runtime", "composers", `${recipient}.typing`);
}

export function isComposerLeased(
  recipient: string,
  hiveHome = getHiveHome(),
): boolean {
  try {
    // Root addressing accepts queen (preferred) and orchestrator (synonym);
    // either marker blocks injection into the root pane.
    if (isOrchestratorName(recipient)) {
      return orchestratorRecipientNames().some((name) =>
        existsSync(composerLeasePath(name, hiveHome))
      );
    }
    return existsSync(composerLeasePath(recipient, hiveHome));
  } catch {
    // A malformed recipient must fail closed: do not inject into an unknown
    // terminal while a human may be typing there.
    return true;
  }
}
