import { join, resolve, sep } from "node:path";
import { resolveVariant } from "../hive-home/variant";
import { IS_RELEASE_BUILD } from "../shared/version";

export function installRoot(): string {
  return resolveVariant().installRoot;
}

export const versionsDir = (root = installRoot()): string =>
  join(root, "versions");
export const versionDir = (version: string, root = installRoot()): string =>
  join(versionsDir(root), version);
export const currentLink = (root = installRoot()): string =>
  join(root, "current");
export const stagingDir = (root = installRoot()): string =>
  join(root, "staging");
export const stateFile = (root = installRoot()): string =>
  join(root, "state.json");

export const cliPath = (dir: string): string => join(dir, "hive");
/** The sessiond broker binary inside a version directory. Sits next to `hive` so a release daemon finds it via `dirname(execPath)`. */
export const sessiondPath = (dir: string): string => join(dir, "hive-sessiond");
export const workspaceAppPath = (dir: string): string =>
  join(dir, "HiveWorkspace.app");

export function binLink(): string {
  return resolveVariant().binLink;
}

export type InstallMethod =
  | "native"
  /** `bun run src/cli.ts` from a checkout. Never updates, never nags. */
  | "source"
  /** A release binary somewhere Hive did not put it. Refuse to guess. */
  | "unmanaged";

export function detectInstallMethod(
  executablePath: string,
  root = installRoot(),
  isReleaseBuild = IS_RELEASE_BUILD,
): InstallMethod {
  if (!isReleaseBuild) return "source";
  const path = resolve(executablePath);
  if (path.startsWith(resolve(versionsDir(root)) + sep)) return "native";
  return "unmanaged";
}

export const UPDATE_COMMAND = "hive update";
