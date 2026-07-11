import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

import type { Provenance, VolumeBehavior } from "./types";

/** Volume behavior is per-volume, so the cache is keyed by st_dev. */
const cache = new Map<number, VolumeBehavior>();

export function clearVolumeCache(): void {
  cache.clear();
}

/** Path to the compiled Swift helper, or null when it has not been built. */
let helperPath: string | null | undefined;

export function setVolumeHelperPath(path: string | null): void {
  helperPath = path;
  cache.clear();
}

function foundationVolInfo(
  path: string,
): { caseSensitive: boolean; isLocal: boolean } | null {
  if (helperPath === undefined || helperPath === null) return null;
  try {
    const out = execFileSync(helperPath, ["volinfo", path], { encoding: "utf8" });
    const parsed = JSON.parse(out) as { caseSensitive?: boolean; isLocal?: boolean };
    if (typeof parsed.caseSensitive !== "boolean") return null;
    return { caseSensitive: parsed.caseSensitive, isLocal: parsed.isLocal ?? false };
  } catch {
    return null;
  }
}

/**
 * Rebuild `path` with the component at `index` replaced. Components are split
 * from an absolute realpath, so index 0 is the first name below `/`.
 */
function withComponent(path: string, index: number, replacement: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  parts[index] = replacement;
  return "/" + parts.join("/");
}

/**
 * Read-only volume probe: rewrite one component of an existing path and stat the
 * result. If the rewritten path names the same inode, the volume ignores that
 * distinction. Nothing is created, so this is safe on a read-only mount.
 *
 * Returns null when no component of `path` can express the distinction (e.g. an
 * all-ASCII path can never test Unicode normalization).
 */
function probeInsensitivity(
  path: string,
  flip: (component: string) => string | null,
): boolean | null {
  let self;
  try {
    self = statSync(path);
  } catch {
    return null;
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  // Deepest component first: it is the one most likely to be on the target volume.
  for (let i = parts.length - 1; i >= 0; i--) {
    const component = parts[i];
    if (component === undefined) continue;
    const flipped = flip(component);
    if (flipped === null || flipped === component) continue;
    const variant = withComponent(path, i, flipped);
    let other;
    try {
      other = statSync(variant);
    } catch {
      // The rewritten name does not exist: the volume distinguishes it.
      return false;
    }
    // The name exists. Same inode => the volume folds the distinction.
    // Different inode => two real directories, so the volume distinguishes it.
    return other.ino === self.ino && other.dev === self.dev;
  }
  return null;
}

function flipCase(component: string): string | null {
  const upper = component.toUpperCase();
  const lower = component.toLowerCase();
  if (upper === lower) return null; // no cased characters
  return component === lower ? upper : lower;
}

function flipNormalization(component: string): string | null {
  const nfc = component.normalize("NFC");
  const nfd = component.normalize("NFD");
  if (nfc === nfd) return null; // ASCII, or otherwise normalization-invariant
  return component === nfd ? nfc : nfd;
}

/**
 * Determine how `canonicalPath`'s volume treats case and Unicode normalization.
 * `canonicalPath` must exist. Foundation is authoritative for case; the stat
 * probe is the fallback and the only source for normalization.
 */
export function describeVolume(canonicalPath: string): VolumeBehavior {
  const dev = statSync(canonicalPath).dev;
  const cached = cache.get(dev);
  if (cached) return cached;

  let caseSensitive: boolean;
  let caseProvenance: Provenance;
  let isLocal: boolean | null = null;

  const foundation = foundationVolInfo(canonicalPath);
  if (foundation) {
    caseSensitive = foundation.caseSensitive;
    caseProvenance = "foundation";
    isLocal = foundation.isLocal;
  } else {
    const insensitive = probeInsensitivity(canonicalPath, flipCase);
    if (insensitive === null) {
      caseSensitive = true; // undetermined: decline to fold
      caseProvenance = "assumed";
    } else {
      caseSensitive = !insensitive;
      caseProvenance = "probed";
    }
  }

  const normInsensitive = probeInsensitivity(canonicalPath, flipNormalization);
  const normalizationSensitive = normInsensitive === null ? true : !normInsensitive;
  const normalizationProvenance: Provenance = normInsensitive === null ? "assumed" : "probed";

  const behavior: VolumeBehavior = {
    dev,
    caseSensitive,
    caseProvenance,
    normalizationSensitive,
    normalizationProvenance,
    isLocal,
  };
  cache.set(dev, behavior);
  return behavior;
}
