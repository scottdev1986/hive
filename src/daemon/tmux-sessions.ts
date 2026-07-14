import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getHiveHome } from "./db";

const INSTANCE_HASH_LENGTH = 10;
const SCOPED_SUFFIX = /-[0-9a-f]{10}$/;

export function resolveHiveHome(hiveHome = getHiveHome()): string {
  return resolve(hiveHome);
}

export function hiveInstanceSuffix(hiveHome = getHiveHome()): string {
  return createHash("sha256")
    .update(resolveHiveHome(hiveHome))
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
}

/** The tmux server is part of an instance's control plane, not a machine-wide
 * singleton. A distinct `-L` name gives every HIVE_HOME its own Unix socket,
 * server environment, clients, and lifecycle. Session-name suffixes remain a
 * second ownership check; they cannot isolate the environment of a shared
 * tmux server on their own. */
export function hiveTmuxSocketName(hiveHome = getHiveHome()): string {
  return `hive-${hiveInstanceSuffix(hiveHome)}`;
}

export function agentTmuxSession(
  agentName: string,
  hiveHome = getHiveHome(),
): string {
  return `hive-${agentName}-${hiveInstanceSuffix(hiveHome)}`;
}

export function orchestratorTmuxSession(hiveHome = getHiveHome()): string {
  return `hive-orchestrator-${hiveInstanceSuffix(hiveHome)}`;
}

export function isDefaultHiveHome(hiveHome = getHiveHome()): boolean {
  return resolveHiveHome(hiveHome) === resolve(join(homedir(), ".hive"));
}

export function isLegacyHiveSession(session: string): boolean {
  return /^hive-[A-Za-z0-9_-]+$/.test(session) && !SCOPED_SUFFIX.test(session);
}

export function isTmuxSessionForInstance(
  session: string,
  hiveHome = getHiveHome(),
): boolean {
  if (session.endsWith(`-${hiveInstanceSuffix(hiveHome)}`)) {
    return /^hive-[A-Za-z0-9_-]+$/.test(session);
  }
  return isDefaultHiveHome(hiveHome) && isLegacyHiveSession(session);
}
