/** Who this binary is. One module, imported by everything; nothing else may declare a version string. The values are inlined at release-build time by `bun build --compile --define 'process.env.HIVE_BUILD_VERSION="0.0.7"' ...`. A `--define` rewrites the member expression into a string literal *before* the bundle is written, so a release binary cannot be relabelled by exporting an environment variable at it. That immutability is the point: the build hash below is what a running daemon presents in its handshake, and a value the caller could forge would make that handshake a decoration. Running from a source checkout (`bun run src/cli.ts`) leaves the defines unset, so the fallbacks below identify the process honestly as a dev build. A dev build never claims a release version, never nags about updates, and refuses to self-update. */

const defined = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value;

export const HIVE_VERSION =
  defined(process.env.HIVE_BUILD_VERSION) ?? "0.0.0-dev";

export const HIVE_COMMIT = defined(process.env.HIVE_BUILD_COMMIT) ?? "unknown";

export const HIVE_BUILD_DATE =
  defined(process.env.HIVE_BUILD_DATE) ?? "unknown";

/** Content address of the compiled artifact. Null in a checkout, where `currentBuildHash()` hashes the source tree instead. Two releases always differ here even when a bad release reuses a version string, which is what lets a new CLI refuse an old daemon. */
export const HIVE_BUILD_HASH = defined(process.env.HIVE_BUILD_HASH);

export const HIVE_SOURCE_HASH = defined(process.env.HIVE_SOURCE_HASH);

/** Base64 SPKI DER of the offline Ed25519 release key — or several, comma- separated, which is how a key is rotated without a flag day (see release/manifest.ts). Inlined at build time, so a release binary's trust anchor cannot be changed by exporting an environment variable at it; that immutability is the entire point of pinning rather than trusting on first use. Null only in a source checkout and in releases before 0.0.6, which predate the key. Where it is set, `verifyManifest` is mandatory and fail-closed. Where it is not, `hive update` says out loud that nothing proves the manifest came from us. */
export const HIVE_RELEASE_PUBLIC_KEY = defined(
  process.env.HIVE_RELEASE_PUBLIC_KEY,
);

/** SHA-256 of the embedding runtime's loaded surface, compiled in at build time (see embeddings-runtime/digest.ts). The loader refuses to import a runtime that does not match, so an attacker who can write ~/.hive/tools/embeddings cannot execute code inside this process — they would have to change this constant, which means re-signing the binary. Null in a source checkout and in any build that ships no release key: such a host is itself unsigned and rewritable, so verification there would be theatre, and dev provisioning stages a locally built tree that no build-time constant could match. That split is deliberate and MUST NOT become an override flag or an environment variable — its whole value is that a release binary cannot be talked out of verifying. */
export const HIVE_EMBEDDINGS_DIGEST = defined(
  process.env.HIVE_EMBEDDINGS_DIGEST,
);

export const HIVE_UPDATE_REPO =
  defined(process.env.HIVE_UPDATE_REPO) ?? "scottdev1986/hive";

export const IS_RELEASE_BUILD = HIVE_BUILD_HASH !== null;

export const HIVE_PLATFORM = process.platform;
export const HIVE_ARCH = process.arch;

export function versionLine(): string {
  const date =
    HIVE_BUILD_DATE === "unknown" ? "unknown" : HIVE_BUILD_DATE.slice(0, 10);
  return `hive ${HIVE_VERSION} (${HIVE_COMMIT}, ${date}, ${HIVE_PLATFORM}-${HIVE_ARCH})`;
}
