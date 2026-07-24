import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getHiveHome } from "./db";

const INSTANCE_HASH_LENGTH = 10;

export function resolveHiveHome(hiveHome = getHiveHome()): string {
  return resolve(hiveHome);
}

export function hiveInstanceSuffix(hiveHome = getHiveHome()): string {
  return createHash("sha256")
    .update(resolveHiveHome(hiveHome))
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
}

export function isDefaultHiveHome(hiveHome = getHiveHome()): boolean {
  return resolveHiveHome(hiveHome) === resolve(join(homedir(), ".hive"));
}

export function orchestratorSessionKey(hiveHome = getHiveHome()): string {
  return `hive-orchestrator-${hiveInstanceSuffix(hiveHome)}`;
}
