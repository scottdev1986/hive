import { execFileSync } from "node:child_process";
import { type Stats, statSync } from "node:fs";
import { isBoolean } from "../../shared/is-record";

import type { Provenance, VolumeBehavior } from "./project-identity-types";

const cache = new Map<number, VolumeBehavior>();

export function clearVolumeCache(): void {
  cache.clear();
}

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
    const out = execFileSync(helperPath, ["volinfo", path], {
      encoding: "utf8",
    });
    // SAFETY: The surrounding code already established this contract.
    const parsed = JSON.parse(out) as {
      caseSensitive?: boolean;
      isLocal?: boolean;
    };
    if (!isBoolean(parsed.caseSensitive)) return null;
    return {
      caseSensitive: parsed.caseSensitive,
      isLocal: parsed.isLocal ?? false,
    };
  } catch {
    return null;
  }
}

function withComponent(
  path: string,
  index: number,
  replacement: string,
): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  parts[index] = replacement;
  return `/${parts.join("/")}`;
}

/** Read-only volume probe: rewrite one component of an existing path and stat the result. If the rewritten path names the same inode, the volume ignores that distinction. Nothing is created, so this is safe on a read-only mount. Returns null when no component of `path` can express the distinction (e.g. an all-ASCII path can never test Unicode normalization). */
function probeInsensitivity(
  path: string,
  flip: (component: string) => string | null,
): boolean | null {
  let self: Stats;
  try {
    self = statSync(path);
  } catch {
    return null;
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    const component = parts[i];
    if (component === undefined) continue;
    const flipped = flip(component);
    if (flipped === null || flipped === component) continue;
    const variant = withComponent(path, i, flipped);
    let other: Stats;
    try {
      other = statSync(variant);
    } catch {
      return false;
    }
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
  const normalizationSensitive =
    normInsensitive === null ? true : !normInsensitive;
  const normalizationProvenance: Provenance =
    normInsensitive === null ? "assumed" : "probed";

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
