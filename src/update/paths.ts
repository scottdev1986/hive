/**
 * Where an installed Hive lives, and who owns it.
 *
 * Immutable version directories plus one atomic symlink. Activation is a single
 * `rename(2)` over `current`, which is why a half-finished download can never
 * be the thing that runs. `~/.local/bin/hive` points at `current/hive` forever
 * and is never rewritten after install, so activation touches exactly one path.
 *
 *   ~/.local/share/hive/
 *     versions/0.0.6/hive, HiveWorkspace.app
 *     versions/0.0.7/hive, HiveWorkspace.app
 *     current -> versions/0.0.7        (the only thing activation moves)
 *     state.json                        (active + retained previous)
 *   ~/.local/bin/hive -> ../share/hive/current/hive
 *
 * Ownership matters more than layout. Hive rewrites an install it created and
 * never one Homebrew created: two owners for one install is how a package
 * receipt starts lying. Codex verifiably does the same thing, dispatching to
 * `brew upgrade --cask codex` when it detects a cask install.
 */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { IS_RELEASE_BUILD } from "../version";

export function installRoot(): string {
  return process.env.HIVE_INSTALL_ROOT ??
    join(homedir(), ".local", "share", "hive");
}

export const versionsDir = (root = installRoot()): string => join(root, "versions");
export const versionDir = (version: string, root = installRoot()): string =>
  join(versionsDir(root), version);
export const currentLink = (root = installRoot()): string => join(root, "current");
export const stagingDir = (root = installRoot()): string => join(root, "staging");
export const stateFile = (root = installRoot()): string => join(root, "state.json");

/** The compiled CLI inside a version directory. */
export const cliPath = (dir: string): string => join(dir, "hive");
/** The release Workspace application inside a version directory. */
export const workspaceAppPath = (dir: string): string => join(dir, "HiveWorkspace.app");

export function binLink(): string {
  return process.env.HIVE_BIN_LINK ?? join(homedir(), ".local", "bin", "hive");
}

export type InstallMethod =
  /** Installed by Hive's own installer into `installRoot()`. Self-updating. */
  | "native"
  /** Owned by Homebrew. Hive tells the user the brew command; it never writes. */
  | "homebrew"
  /** `bun run src/cli.ts` from a checkout. Never updates, never nags. */
  | "source"
  /** A release binary somewhere Hive did not put it. Refuse to guess. */
  | "unmanaged";

const HOMEBREW_MARKERS = ["/Cellar/", "/homebrew/", "/Caskroom/"];

/**
 * `executablePath` is `process.execPath`: the compiled `hive` for a release
 * build, and the `bun` binary itself when run from a checkout. A source build
 * is therefore identified by what it *is*, not by where it sits — a dev binary
 * dropped into the install root is still a dev binary.
 */
export function detectInstallMethod(
  executablePath: string,
  root = installRoot(),
  isReleaseBuild = IS_RELEASE_BUILD,
): InstallMethod {
  if (!isReleaseBuild) return "source";
  const path = resolve(executablePath);
  if (path.startsWith(resolve(versionsDir(root)) + sep)) return "native";
  if (HOMEBREW_MARKERS.some((marker) => path.includes(marker))) return "homebrew";
  return "unmanaged";
}

/** The command a user of this install actually types to update. */
export function updateCommand(method: InstallMethod): string {
  return method === "homebrew" ? "brew upgrade hive" : "hive update";
}
