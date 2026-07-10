/**
 * The versioning contract, as executable code.
 *
 * One push to `main` bumps the patch by exactly one, whatever the push
 * contains. A hundred local commits arriving in a single push produce one
 * release, because the bump is a function of the *tip commit* and the existing
 * tags — never of the commit count.
 *
 * Idempotency comes from one rule: a commit that already carries a release tag
 * is never released again. Re-running a workflow, re-pushing the same tip, or
 * a force-push that lands nothing new all resolve to `skip`. Publishing the tag
 * is a compare-and-swap against the remote (`git push` of a new ref fails if
 * the ref exists), so two concurrent runs cannot both mint the same version.
 *
 * Hive is 0.0.x, patch-only, on purpose. We are a long way from deciding what
 * a minor bump would mean, and a scheme with one moving part cannot drift. A
 * conventional-commits scheme was the alternative: it reads intent from commit
 * messages, which makes the version a function of prose that nobody proofreads,
 * and it would silently mint 0.1.0 the first time someone typed `feat:`. This
 * module refuses any tag outside the series rather than guess what it meant.
 */

/** `v0.0.7` — the only tag shape this project publishes. */
const RELEASE_TAG = /^v0\.0\.(\d+)$/;

/** Anything semver-tag-shaped, so we can tell "not a version" from "wrong version". */
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export const PATCH_SERIES = "0.0";

export class VersioningContractError extends Error {}

/** The patch number of a release tag, or null if the tag is not one of ours. */
export function parseReleaseTag(tag: string): number | null {
  const match = RELEASE_TAG.exec(tag.trim());
  if (match?.[1] === undefined) return null;
  const patch = Number.parseInt(match[1], 10);
  // `v0.0.007` parses as 7 but is a second name for one release; refuse it.
  return Number.isSafeInteger(patch) && String(patch) === match[1] ? patch : null;
}

/**
 * Version tags that are not in the 0.0.x series are a contract violation, not
 * noise to skip. Silently ignoring a `v0.1.0` would mint a `v0.0.N` *behind* it
 * and hand two different builds a descending version order.
 */
function assertInSeries(tags: readonly string[]): void {
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length === 0 || parseReleaseTag(trimmed) !== null) continue;
    if (VERSION_TAG.test(trimmed)) {
      throw new VersioningContractError(
        `Tag ${trimmed} is outside the ${PATCH_SERIES}.x patch series. Hive is ` +
          "patch-only; a minor or major bump is a deliberate decision that must " +
          "update docs/versioning-and-release.md and src/release/plan.ts together.",
      );
    }
  }
}

/** Highest published patch, or 0 when nothing has ever been released. */
export function highestPatch(tags: readonly string[]): number {
  assertInSeries(tags);
  return tags.reduce((highest, tag) => {
    const patch = parseReleaseTag(tag);
    // Numeric max, not lexicographic: `v0.0.9` must not outrank `v0.0.10`.
    return patch === null || patch <= highest ? highest : patch;
  }, 0);
}

/** The version the next release takes: exactly one patch above the highest. */
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
  /** Every tag in the repository. */
  readonly tags: readonly string[];
  /** Tags already pointing at the commit being considered. */
  readonly headTags: readonly string[];
}

export function planRelease({ tags, headTags }: ReleasePlanInput): ReleasePlan {
  assertInSeries(tags);
  assertInSeries(headTags);

  // The idempotency key is the commit. This is what makes a re-run a no-op.
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
    reason: highestPatch(tags) === 0
      ? "no release exists yet; this is the first"
      : `one patch above v${PATCH_SERIES}.${highestPatch(tags)}`,
  };
}
