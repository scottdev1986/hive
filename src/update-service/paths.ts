/** Where an installed Hive lives, and who owns it. Immutable version directories plus one atomic symlink. Activation is a single `rename(2)` over `current`, which is why a half-finished download can never be the thing that runs. `~/.local/bin/hive` points at `current/hive` forever and is never rewritten after install, so activation touches exactly one path. ~/.local/share/hive/ versions/0.0.6/hive, hive-sessiond, HiveWorkspace.app versions/0.0.7/hive, hive-sessiond, HiveWorkspace.app current -> versions/0.0.7 (the only thing activation moves) state.json (active + retained previous) ~/.local/bin/hive -> ../share/hive/current/hive Ownership matters more than layout. Hive rewrites only an install it created; a release binary elsewhere is unmanaged and is never modified or guessed at. */
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
