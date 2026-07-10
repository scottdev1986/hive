/**
 * Who this binary is. One module, imported by everything; nothing else may
 * declare a version string.
 *
 * The values are inlined at release-build time by `bun build --compile
 * --define 'process.env.HIVE_BUILD_VERSION="0.0.7"' ...`. A `--define` rewrites
 * the member expression into a string literal *before* the bundle is written,
 * so a release binary cannot be relabelled by exporting an environment
 * variable at it. That immutability is the point: the build hash below is what
 * a running daemon presents in its handshake, and a value the caller could
 * forge would make the stale-daemon check a decoration.
 *
 * Running from a source checkout (`bun run src/cli.ts`) leaves the defines
 * unset, so the fallbacks below identify the process honestly as a dev build.
 * A dev build never claims a release version, never nags about updates, and
 * refuses to self-update.
 */

/** An unset `--define` reaches us as undefined; an empty one is a build bug. */
const defined = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value;

/** The marketing semver, from the release tag. `0.0.0-dev` in a checkout. */
export const HIVE_VERSION = defined(process.env.HIVE_BUILD_VERSION) ?? "0.0.0-dev";

/** Short commit the release was built from. */
export const HIVE_COMMIT = defined(process.env.HIVE_BUILD_COMMIT) ?? "unknown";

/** ISO timestamp of the build. */
export const HIVE_BUILD_DATE = defined(process.env.HIVE_BUILD_DATE) ?? "unknown";

/**
 * Content address of the compiled artifact. Null in a checkout, where
 * `currentBuildHash()` hashes the source tree instead. Two releases always
 * differ here even when a bad release reuses a version string, which is what
 * lets a new CLI refuse an old daemon.
 */
export const HIVE_BUILD_HASH = defined(process.env.HIVE_BUILD_HASH);

/**
 * Base64 SPKI DER of the offline Ed25519 release key. Absent until Scott
 * generates one. Its absence is not a silent downgrade: `hive update` says out
 * loud that the release is unsigned, and once this is embedded, verification
 * becomes mandatory with no other code change.
 */
export const HIVE_RELEASE_PUBLIC_KEY = defined(process.env.HIVE_RELEASE_PUBLIC_KEY);

/** `owner/repo` the updater reads releases from. */
export const HIVE_UPDATE_REPO = defined(process.env.HIVE_UPDATE_REPO) ?? "scottdev1986/hive";

/** True only for a compiled artifact produced by the release pipeline. */
export const IS_RELEASE_BUILD = HIVE_BUILD_HASH !== null;

export const HIVE_PLATFORM = process.platform;
export const HIVE_ARCH = process.arch;

/** `hive 0.0.7 (abc1234, 2026-07-10, darwin-arm64)` — the line bug reports need. */
export function versionLine(): string {
  const date = HIVE_BUILD_DATE === "unknown" ? "unknown" : HIVE_BUILD_DATE.slice(0, 10);
  return `hive ${HIVE_VERSION} (${HIVE_COMMIT}, ${date}, ${HIVE_PLATFORM}-${HIVE_ARCH})`;
}
