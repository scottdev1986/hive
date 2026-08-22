const RELEASE_TAG = /^v0\.0\.(\d+)$/;

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export const PATCH_SERIES = "0.0";

export class VersioningContractError extends Error {}

export function parseReleaseTag(tag: string): number | null {
  const match = RELEASE_TAG.exec(tag.trim());
  if (match?.[1] === undefined) return null;
  const patch = Number.parseInt(match[1], 10);
  // `v0.0.007` parses as 7 but is a second name for one release; refuse it.
  return Number.isSafeInteger(patch) && String(patch) === match[1]
    ? patch
    : null;
}

function assertInSeries(tags: readonly string[]): void {
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length === 0 || parseReleaseTag(trimmed) !== null) continue;
    if (VERSION_TAG.test(trimmed)) {
      throw new VersioningContractError(
        `Tag ${trimmed} is outside the ${PATCH_SERIES}.x patch series. Hive is ` +
          "patch-only; this release planner does not define minor or major bumps.",
      );
    }
  }
}

export function highestPatch(tags: readonly string[]): number {
  assertInSeries(tags);
  return tags.reduce((highest, tag) => {
    const patch = parseReleaseTag(tag);
    // Numeric max, not lexicographic: `v0.0.9` must not outrank `v0.0.10`.
    return patch === null || patch <= highest ? highest : patch;
  }, 0);
}

export function nextVersion(tags: readonly string[]): string {
  return `${PATCH_SERIES}.${highestPatch(tags) + 1}`;
}

export interface ReleasePlan {
  readonly action: "release" | "skip";
  readonly version: string;
  readonly tag: string;
  readonly reason: string;
}

export interface ReleasePlanInput {
  readonly tags: readonly string[];
  readonly headTags: readonly string[];
}

export function planRelease({ tags, headTags }: ReleasePlanInput): ReleasePlan {
  assertInSeries(tags);
  assertInSeries(headTags);

  const alreadyReleased = headTags
    .map((tag) => parseReleaseTag(tag))
    .filter((patch): patch is number => patch !== null)
    .sort((left, right) => right - left)[0];
  if (alreadyReleased !== undefined) {
    const version = `${PATCH_SERIES}.${alreadyReleased}`;
    return {
      action: "skip",
      version,
      tag: `v${version}`,
      reason: `this commit is already released as v${version}`,
    };
  }

  const version = nextVersion(tags);
  return {
    action: "release",
    version,
    tag: `v${version}`,
    reason:
      highestPatch(tags) === 0
        ? "no release exists yet; this is the first"
        : `one patch above v${PATCH_SERIES}.${highestPatch(tags)}`,
  };
}
