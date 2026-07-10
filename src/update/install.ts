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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  artifactMatches,
  selectArtifact,
  verifyManifest,
  type HiveArch,
  type ReleaseManifest,
} from "../release/manifest";
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
  /** Fetch a named release asset's bytes. */
  readonly download: (assetName: string) => Promise<Uint8Array>;
  /** Run `<binary> --version` and return stdout. */
  readonly probeVersion: (binaryPath: string) => Promise<string>;
  /** Unpack the Workspace app tarball into a version directory. */
  readonly unpackApp?: (tarball: string, into: string) => Promise<void>;
  readonly publicKey?: string | null;
}

export class UpdateError extends Error {}

export interface StageResult {
  readonly version: string;
  readonly directory: string;
  readonly signed: boolean;
  readonly warning: string | null;
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

  const cliBytes = await deps.download(cli.name);
  if (!artifactMatches(cli, cliBytes)) {
    await rm(staging, { recursive: true, force: true });
    throw new UpdateError(
      `Refusing update: ${cli.name} does not match the SHA-256 in the manifest`,
    );
  }
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
    const appBytes = await deps.download(app.name);
    if (!artifactMatches(app, appBytes)) {
      await rm(staging, { recursive: true, force: true });
      throw new UpdateError(
        `Refusing update: ${app.name} does not match the SHA-256 in the manifest`,
      );
    }
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

export interface ActivationDeps {
  readonly root?: string;
  /** Bounded proof that the activated binary works. */
  readonly healthCheck: (binaryPath: string) => Promise<boolean>;
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
  return { activated: true, version: target, previous: state.active };
}

export { workspaceAppPath };
