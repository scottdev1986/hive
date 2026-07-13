/**
 * "Is there a newer Hive?" — answered honestly or not at all.
 *
 * The invariant that drives the shape below: `up-to-date` is a claim about
 * evidence, never a fallback. A failed network call returns `unavailable` with
 * the reason. A cached answer is still evidence — we observed that version
 * exist — so an offline machine keeps telling the truth it last learned, and
 * only a machine that has never successfully checked says "could not check".
 *
 * Checks are cached for a day, jittered nowhere because the CLI check happens
 * on an explicit human command. The daemon-owned background check on a jittered
 * ~24h timer is the design in docs/release/update-experience.md and is not built
 * yet; this module is written so the daemon can call it unchanged.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getHiveHome } from "../daemon/db";
import { parseReleaseTag } from "../release/plan";
import { HIVE_UPDATE_REPO, HIVE_VERSION, IS_RELEASE_BUILD } from "../version";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 2_500;

export const updateCachePath = (): string => join(getHiveHome(), "update-check.json");

const CacheSchema = z.object({
  latestVersion: z.string(),
  checkedAt: z.number(),
  securityCritical: z.boolean().default(false),
  /** Codex's "skip until next version": silences one version, not the feature. */
  dismissedVersion: z.string().nullable().default(null),
});
export type UpdateCache = z.infer<typeof CacheSchema>;

export function readUpdateCache(path = updateCachePath()): UpdateCache | null {
  try {
    return CacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeUpdateCache(cache: UpdateCache, path = updateCachePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

export type UpdateCheck =
  /** A checkout. Never nags, never updates. */
  | { state: "dev-build"; current: string }
  | { state: "disabled"; current: string; reason: string }
  | { state: "up-to-date"; current: string; latest: string }
  | {
    state: "update-available";
    current: string;
    latest: string;
    securityCritical: boolean;
    /** Set when the cache answered because the network did not. */
    stale: boolean;
  }
  /** We do not know. We say we do not know. */
  | { state: "unavailable"; current: string; reason: string };

/** `HIVE_DISABLE_UPDATES` blocks even a manual `hive update`, Claude Code-style. */
export const updatesDisabled = (env = process.env): string | null =>
  env.HIVE_DISABLE_UPDATES === "1" ? "HIVE_DISABLE_UPDATES=1" : null;

/** Background checks and notices off; `hive update` still works. */
export function checksDisabled(env = process.env): string | null {
  if (env.HIVE_DISABLE_UPDATES === "1") return "HIVE_DISABLE_UPDATES=1";
  if (env.HIVE_NO_UPDATE_CHECK === "1") return "HIVE_NO_UPDATE_CHECK=1";
  // The ecosystem-wide variable. Costs one `||` and respects a convention
  // users already export.
  if (env.NO_UPDATE_NOTIFIER !== undefined) return "NO_UPDATE_NOTIFIER";
  return null;
}

/** Compare two 0.0.x versions. Non-conforming input sorts as "not newer". */
export function isNewer(candidate: string, current: string): boolean {
  const left = parseReleaseTag(`v${candidate}`);
  const right = parseReleaseTag(`v${current}`);
  return left !== null && right !== null && left > right;
}

export interface LatestRelease {
  version: string;
  securityCritical: boolean;
}

export interface CheckDeps {
  readonly fetchLatest: () => Promise<LatestRelease>;
  readonly now: () => number;
  readonly cachePath?: string;
  readonly currentVersion?: string;
  readonly isReleaseBuild?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Skip the cache and hit the network. `hive update check` sets this. */
  readonly force?: boolean;
}

/**
 * GitHub's `releases/latest` endpoint. docs/release/distribution.md
 * argues for a signed channel document on a CDN instead, so that channel and
 * rollout policy are not inferred from a mutable API. That endpoint does not
 * exist yet; this reads the tag of the newest non-prerelease and the manifest
 * asset carries the rest. The deviation is recorded in the same doc.
 */
export async function fetchLatestFromGitHub(
  repo = HIVE_UPDATE_REPO,
  fetcher: typeof fetch = fetch,
): Promise<LatestRelease> {
  const response = await fetcher(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`);
  }
  const body = z.object({
    tag_name: z.string(),
    body: z.string().nullish(),
  }).parse(await response.json());
  const patch = parseReleaseTag(body.tag_name);
  if (patch === null) {
    throw new Error(`latest release tag ${body.tag_name} is not a Hive release`);
  }
  return {
    version: `0.0.${patch}`,
    // The release notes carry the flag until a signed channel document can.
    securityCritical: /\bsecurity[- ]critical\b/i.test(body.body ?? ""),
  };
}

function classify(
  current: string,
  latest: string,
  securityCritical: boolean,
  stale: boolean,
): UpdateCheck {
  return isNewer(latest, current)
    ? { state: "update-available", current, latest, securityCritical, stale }
    : { state: "up-to-date", current, latest };
}

export async function checkForUpdate(deps: CheckDeps): Promise<UpdateCheck> {
  const current = deps.currentVersion ?? HIVE_VERSION;
  const env = deps.env ?? process.env;
  const isRelease = deps.isReleaseBuild ?? IS_RELEASE_BUILD;
  const cachePath = deps.cachePath ?? updateCachePath();

  if (!isRelease) return { state: "dev-build", current };
  const disabled = checksDisabled(env);
  if (disabled !== null) return { state: "disabled", current, reason: disabled };

  const cached = readUpdateCache(cachePath);
  const fresh = cached !== null &&
    deps.now() - cached.checkedAt < CHECK_INTERVAL_MS;
  if (fresh && deps.force !== true) {
    return classify(current, cached.latestVersion, cached.securityCritical, false);
  }

  try {
    const latest = await deps.fetchLatest();
    writeUpdateCache({
      latestVersion: latest.version,
      checkedAt: deps.now(),
      securityCritical: latest.securityCritical,
      dismissedVersion: cached?.dismissedVersion ?? null,
    }, cachePath);
    return classify(current, latest.version, latest.securityCritical, false);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached === null) {
      // Never invent "up to date" out of a failed request.
      return { state: "unavailable", current, reason };
    }
    // A stale observation is still an observation. Report it as stale so the
    // caller can say so, but do not upgrade ignorance into reassurance: if the
    // cache says we are current, that is what we last verified, not what is.
    const result = classify(
      current,
      cached.latestVersion,
      cached.securityCritical,
      true,
    );
    return result.state === "up-to-date"
      ? { state: "unavailable", current, reason }
      : result;
  }
}

/** `hive update skip` — silence the offered version until a newer one lands. */
export function dismissVersion(version: string, cachePath = updateCachePath()): void {
  const cache = readUpdateCache(cachePath);
  writeUpdateCache({
    latestVersion: cache?.latestVersion ?? version,
    checkedAt: cache?.checkedAt ?? 0,
    securityCritical: cache?.securityCritical ?? false,
    dismissedVersion: version,
  }, cachePath);
}

export function isDismissed(version: string, cache: UpdateCache | null): boolean {
  return cache?.dismissedVersion === version;
}
