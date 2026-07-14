import { existsSync } from "node:fs";
import { join } from "node:path";
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
    return existsSync(composerLeasePath(recipient, hiveHome));
  } catch {
    // A malformed recipient must fail closed: do not inject into an unknown
    // terminal while a human may be typing there.
    return true;
  }
}
