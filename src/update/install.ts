/**
 * Download, verify, stage, activate, and — when the new binary cannot prove it
 * works — put the old one back.
 *
 * The ordering is the safety property. Nothing is executed before its SHA-256
 * matches the manifest. Nothing is activated before the staged binary reports
 * its own expected version when asked (Bun's updater does exactly this, and it
 * catches the truncated-download and wrong-architecture cases that a hash alone
 * would also catch but a corrupted *manifest* would not). Nothing is retained
 * as active before it survives a health check, and the previous version
 * directory is kept until it does.
 *
 * Activation is one `rename(2)` over the `current` symlink. A rename of a
 * symlink is atomic on macOS, so there is no instant at which `current` names a
 * half-installed tree. It also does not disturb the running daemon: a Unix
 * process keeps executing its already-open image after the link moves, which is
 * useful while staging and exactly why the daemon must be restarted explicitly.
 */
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  artifactMatches,
  selectArtifact,
  verifyManifest,
  type HiveArch,
  type ReleaseArtifact,
  type ReleaseManifest,
} from "../release/manifest";
import type { ProgressCallback, ProgressReporter } from "./progress";
import { HIVE_RELEASE_PUBLIC_KEY } from "../version";
import {
  binLink,
  cliPath,
  currentLink,
  installRoot,
  stagingDir,
  stateFile,
  versionDir,
  versionsDir,
  workspaceAppPath,
} from "./paths";

const StateSchema = z.object({
  active: z.string().nullable().default(null),
  /** Retained for `hive update rollback`; must work offline. */
  previous: z.string().nullable().default(null),
});
export type InstallState = z.infer<typeof StateSchema>;

export function readInstallState(root = installRoot()): InstallState {
  try {
    return StateSchema.parse(JSON.parse(readFileSync(stateFile(root), "utf8")));
  } catch {
    return { active: null, previous: null };
  }
}

export function writeInstallState(state: InstallState, root = installRoot()): void {
  writeFileSync(stateFile(root), `${JSON.stringify(state, null, 2)}\n`);
}

/** Versions present on disk, newest activation last. */
export function isStaged(version: string, root = installRoot()): boolean {
  return existsSync(cliPath(versionDir(version, root)));
}

export interface StageDeps {
  readonly manifest: ReleaseManifest;
  readonly manifestBytes: Uint8Array;
  readonly signature: string | null;
  readonly arch: HiveArch;
  readonly root?: string;
  /** Fetch a named release asset's bytes, reporting progress as they arrive. */
  readonly download: (
    assetName: string,
    onProgress?: ProgressCallback,
  ) => Promise<Uint8Array>;
  /** Run `<binary> --version` and return stdout. */
  readonly probeVersion: (binaryPath: string) => Promise<string>;
  /** Unpack the Workspace app tarball into a version directory. */
  readonly unpackApp?: (tarball: string, into: string) => Promise<void>;
  readonly publicKey?: string | null;
  /**
   * Opens a progress display for one artifact. Staging stays free of rendering:
   * it reports bytes, and whoever owns the terminal decides what that looks
   * like. Absent (the daemon's background staging) means download in silence.
   */
  readonly progress?: (artifact: ReleaseArtifact) => ProgressReporter;
}

export class UpdateError extends Error {}

export interface StageResult {
  readonly version: string;
  readonly directory: string;
  readonly signed: boolean;
  readonly warning: string | null;
  /** The digest that actually matched, so the CLI can name it rather than allude to it. */
  readonly cliSha256: string;
}

/**
 * Verify the manifest, download both artifacts, check their digests, prove the
 * CLI runs, and leave the result in an immutable version directory. Activation
 * is a separate, later decision — this is the half that is always safe to do,
 * even with a team live.
 */
export async function stageRelease(deps: StageDeps): Promise<StageResult> {
  const root = deps.root ?? installRoot();
  const publicKey = deps.publicKey === undefined
    ? HIVE_RELEASE_PUBLIC_KEY
    : deps.publicKey;

  const trust = verifyManifest(deps.manifestBytes, deps.signature, publicKey);
  if (!trust.verified) throw new UpdateError(`Refusing update: ${trust.reason}`);

  const cli = selectArtifact(deps.manifest, "cli", deps.arch);
  if (cli === null) {
    throw new UpdateError(
      `Release ${deps.manifest.version} has no CLI build for darwin-${deps.arch}`,
    );
  }
  const app = selectArtifact(deps.manifest, "workspace", deps.arch);

  const version = deps.manifest.version;
  const staging = join(stagingDir(root), version);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  /**
   * Fetch one artifact, show it arriving, and refuse it if the bytes are not the
   * bytes the signed manifest named. The digest check is the gate every byte
   * passes through; the progress display is what makes the wait honest.
   */
  const fetchArtifact = async (artifact: ReleaseArtifact): Promise<Uint8Array> => {
    const reporter = deps.progress?.(artifact);
    let downloaded: Uint8Array;
    try {
      downloaded = await deps.download(artifact.name, reporter?.onProgress);
    } catch (error) {
      // Retire the bar before the error reaches a terminal, or the message
      // lands on top of a half-drawn line.
      reporter?.finish();
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    reporter?.finish();
    if (!artifactMatches(artifact, downloaded)) {
      await rm(staging, { recursive: true, force: true });
      throw new UpdateError(
        `Refusing update: ${artifact.name} does not match the SHA-256 in the manifest`,
      );
    }
    return downloaded;
  };

  const cliBytes = await fetchArtifact(cli);
  const stagedCli = cliPath(staging);
  await writeFile(stagedCli, cliBytes);
  await chmod(stagedCli, 0o755);

  // Execute the candidate before it can ever be `current`. A binary that will
  // not say its own name is not a binary we activate.
  const reported = await deps.probeVersion(stagedCli).catch(async (error: unknown) => {
    await rm(staging, { recursive: true, force: true });
    throw new UpdateError(
      `Refusing update: staged hive ${version} did not run (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  });
  if (!reported.includes(version)) {
    await rm(staging, { recursive: true, force: true });
    throw new UpdateError(
      `Refusing update: staged binary reported "${reported.trim()}", expected ${version}`,
    );
  }

  if (app !== null && deps.unpackApp !== undefined) {
    const appBytes = await fetchArtifact(app);
    const tarball = join(staging, app.name);
    await writeFile(tarball, appBytes);
    await deps.unpackApp(tarball, staging);
    await rm(tarball, { force: true });
  }

  const target = versionDir(version, root);
  await mkdir(versionsDir(root), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);

  return {
    version,
    directory: target,
    signed: trust.signed,
    warning: trust.signed ? null : trust.warning,
    cliSha256: cli.sha256,
  };
}

/** Atomically point `current` at a staged version directory. */
export async function activate(version: string, root = installRoot()): Promise<void> {
  const target = versionDir(version, root);
  if (!existsSync(cliPath(target))) {
    throw new UpdateError(`hive ${version} is not staged at ${target}`);
  }
  const link = currentLink(root);
  const temporary = `${link}.tmp`;
  await rm(temporary, { force: true });
  // Relative target keeps the tree movable and the link readable.
  await symlink(join("versions", version), temporary);
  await rename(temporary, link);
}

/** `~/.local/bin/hive` -> `current/hive`, written once at install time. */
export async function ensureBinLink(root = installRoot()): Promise<void> {
  const link = binLink();
  await mkdir(dirname(link), { recursive: true });
  const temporary = `${link}.tmp`;
  await rm(temporary, { force: true });
  await symlink(cliPath(currentLink(root)), temporary);
  await rename(temporary, link);
}

/** Patch number of a `versions/` directory name, or -1 for anything malformed. */
function patchNumber(version: string): number {
  const match = /^\d+\.\d+\.(\d+)$/.exec(version);
  return match?.[1] === undefined ? -1 : Number.parseInt(match[1], 10);
}

/** Every staged version directory, most recent first. Empty if none exist yet. */
function installedVersions(root: string): string[] {
  try {
    return readdirSync(versionsDir(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => patchNumber(b) - patchNumber(a));
  } catch {
    return [];
  }
}

/**
 * Staged versions outside the retention budget: the active version, the
 * rollback target, and the next most recent — three by default, fewer only
 * when fewer than three are staged. `active` and `previous` are never in the
 * result, whether or not they are actually present on disk.
 */
export function versionsToPrune(
  root: string,
  active: string | null,
  previous: string | null,
): string[] {
  const installed = installedVersions(root);
  const keep = new Set<string>();
  if (active !== null) keep.add(active);
  if (previous !== null) keep.add(previous);
  for (const version of installed) {
    if (keep.size >= 3) break;
    keep.add(version);
  }
  return installed.filter((version) => !keep.has(version));
}

export interface PruneDeps {
  readonly root?: string;
  /** Where the prune report goes; defaults to `console.log`. */
  readonly log?: (message: string) => void;
  /** Injectable for tests; defaults to removing the version directory. */
  readonly remove?: (dir: string) => Promise<void>;
}

/**
 * Remove staged versions past the retention budget so `versions/` does not
 * grow forever. Never throws: pruning is disk hygiene, not part of the
 * update's success, so a removal error is logged and swallowed rather than
 * surfaced as a failed update.
 */
export async function pruneOldVersions(
  active: string | null,
  previous: string | null,
  deps: PruneDeps = {},
): Promise<readonly string[]> {
  const root = deps.root ?? installRoot();
  const log = deps.log ?? ((message: string) => console.log(message));
  const remove = deps.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

  const pruned: string[] = [];
  for (const version of versionsToPrune(root, active, previous)) {
    try {
      await remove(versionDir(version, root));
      pruned.push(version);
      log(`hive update: pruned hive ${version} (retaining the active version, the rollback target, and the next most recent)`);
    } catch (error) {
      log(
        `hive update: could not prune hive ${version}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return pruned;
}

export interface ActivationDeps {
  readonly root?: string;
  /** Bounded proof that the activated binary works. */
  readonly healthCheck: (binaryPath: string) => Promise<boolean>;
  /** Where prune reports go; forwarded to `pruneOldVersions`. */
  readonly log?: (message: string) => void;
}

export type ActivationOutcome =
  | { activated: true; version: string; previous: string | null }
  | { activated: false; version: string; revertedTo: string | null; reason: string };

/**
 * Activate, then prove it. On failure, put `current` back and keep the staged
 * version on disk for diagnosis rather than deleting the evidence.
 *
 * None of the surveyed updaters — rustup, Deno, Bun, Claude Code — does a
 * post-activation revert. They verify before activation and leave recovery to
 * an explicit `install <old-version>`. Hive goes further because it can: the
 * thing being activated has a health check, and the cost of a broken control
 * plane is a stranded team rather than a failed command.
 */
export async function activateWithHealthCheck(
  version: string,
  deps: ActivationDeps,
): Promise<ActivationOutcome> {
  const root = deps.root ?? installRoot();
  const state = readInstallState(root);
  const previous = state.active;

  await activate(version, root);
  const healthy = await deps.healthCheck(cliPath(currentLink(root)))
    .catch(() => false);

  if (healthy) {
    writeInstallState({ active: version, previous }, root);
    await pruneOldVersions(version, previous, { root, log: deps.log });
    return { activated: true, version, previous };
  }

  if (previous !== null && isStaged(previous, root)) {
    await activate(previous, root);
    writeInstallState(state, root);
    return {
      activated: false,
      version,
      revertedTo: previous,
      reason: `hive ${version} failed its health check`,
    };
  }
  // Nothing to revert to. Leave `current` pointing at the new version rather
  // than at nothing; a broken hive beats an absent one, and the message says so.
  return {
    activated: false,
    version,
    revertedTo: null,
    reason: `hive ${version} failed its health check and there is no retained ` +
      "previous version to revert to",
  };
}

export async function rollback(deps: ActivationDeps): Promise<ActivationOutcome> {
  const root = deps.root ?? installRoot();
  const state = readInstallState(root);
  if (state.previous === null) {
    throw new UpdateError("No retained previous version to roll back to");
  }
  if (!isStaged(state.previous, root)) {
    throw new UpdateError(
      `Retained version ${state.previous} is missing from ${versionsDir(root)}`,
    );
  }
  const target = state.previous;
  await activate(target, root);
  const healthy = await deps.healthCheck(cliPath(currentLink(root))).catch(() => false);
  if (!healthy) {
    // Symmetric with activateWithHealthCheck: never leave `current` pointing at
    // a binary that just failed its own health check, rollback included. The
    // version we came from got here by having already passed a health check
    // (its own activation or an earlier rollback), so it is the thing to trust.
    const canRevert = state.active !== null && isStaged(state.active, root);
    if (canRevert) {
      await activate(state.active as string, root);
    }
    return {
      activated: false,
      version: target,
      revertedTo: canRevert ? state.active : null,
      reason: `hive ${target} failed its health check`,
    };
  }
  // The version we just left becomes the rollback target, so a bad rollback is
  // itself reversible.
  writeInstallState({ active: target, previous: state.active }, root);
  await pruneOldVersions(target, state.active, { root, log: deps.log });
  return { activated: true, version: target, previous: state.active };
}

export { workspaceAppPath };
