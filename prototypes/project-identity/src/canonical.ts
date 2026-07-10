import { realpathSync, statSync } from "node:fs";

import type { FsEvidence, VolumeBehavior } from "./types";
import { describeVolume } from "./volume";

export interface CanonicalDirectory {
  canonicalPath: string;
  evidence: FsEvidence;
  volume: VolumeBehavior;
}

export type CanonicalizeError = "NO_SUCH_DIRECTORY" | "NOT_A_DIRECTORY";

export type CanonicalizeResult =
  | { ok: true; value: CanonicalDirectory }
  | { ok: false; error: CanonicalizeError };

export function evidenceOf(path: string): FsEvidence {
  const s = statSync(path);
  return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs };
}

export function evidenceMatches(a: FsEvidence, b: FsEvidence): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

/**
 * Step 1 of the resolver: canonicalize the *existing* invocation directory using
 * the physical path and the volume's case behavior.
 *
 * realpath(2) resolves symlinks, the /tmp -> /private/tmp style firmlinks, and --
 * measured, though not documented by Apple -- rewrites each component to its
 * on-disk case and Unicode normalization on volumes that fold those distinctions.
 * That is why `identityKey` folding is defense in depth rather than the mechanism.
 */
export function canonicalizeDirectory(path: string): CanonicalizeResult {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    return { ok: false, error: "NO_SUCH_DIRECTORY" };
  }
  const stat = statSync(canonicalPath);
  if (!stat.isDirectory()) return { ok: false, error: "NOT_A_DIRECTORY" };

  return {
    ok: true,
    value: {
      canonicalPath,
      evidence: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs },
      volume: describeVolume(canonicalPath),
    },
  };
}

/**
 * The registry's unique constraint. Folding is applied only where the volume is
 * known to ignore the distinction, because a fold can only ever merge two keys,
 * and merging two genuinely distinct directories into one Hive is the worse error.
 */
export function foldIdentityKey(canonicalPath: string, volume: VolumeBehavior): string {
  let key = canonicalPath;
  if (!volume.normalizationSensitive) key = key.normalize("NFC");
  if (!volume.caseSensitive) key = key.toLowerCase();
  return key;
}

/**
 * True when `descendant` is `ancestor` or lies beneath it. Compares folded keys so
 * a case-insensitive volume does not miss `/Users/x/Proj` under `/users/x/proj`.
 */
export function isAtOrBeneath(
  descendant: string,
  ancestor: string,
  volume: VolumeBehavior,
): boolean {
  const d = foldIdentityKey(descendant, volume);
  const a = foldIdentityKey(ancestor, volume);
  return d === a || d.startsWith(a.endsWith("/") ? a : a + "/");
}
