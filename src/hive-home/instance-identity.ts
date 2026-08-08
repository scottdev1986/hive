// The identity a Hive install derives from where it lives, spelled the way its thirty-odd callers already import it. Every name here reads one field of the record in ./variant, which is where the derivation lives; nothing in this file derives anything itself. Keeping the names lets a caller that only wants an instance suffix ask for one without knowing a variant record exists.
import { defaultHiveHome, getHiveHome, resolveHiveHome } from "./home";
import { resolveVariant } from "./variant";

export { resolveHiveHome };

export function hiveInstanceSuffix(hiveHome = getHiveHome()): string {
  return resolveVariant(hiveHome).instanceSuffix;
}

/** Whether the home in effect is the user-level one rather than a redirect. */
export function isDefaultHiveHome(hiveHome = getHiveHome()): boolean {
  return resolveHiveHome(hiveHome) === resolveHiveHome(defaultHiveHome());
}

export function orchestratorSessionKey(hiveHome = getHiveHome()): string {
  return `hive-orchestrator-${hiveInstanceSuffix(hiveHome)}`;
}

export function sessiondRuntimeRoot(hiveHome = getHiveHome()): string {
  return resolveVariant(hiveHome).socketRoot;
}

export function databaseIdentityPath(hiveHome = getHiveHome()): string {
  return resolveVariant(hiveHome).databaseIdentityPath;
}
