/**
 * Developer ID signing and Apple notarization for the release artifacts.
 *
 * This is the second of a release's two independent signatures. Apple's
 * Developer ID signature authenticates the executable to macOS so Gatekeeper
 * does not quarantine it; the Ed25519 manifest signature (see manifest.ts)
 * authenticates *update policy* to Hive. Neither substitutes for the other, and
 * this module owns only the first.
 *
 * Everything here is gated on `signingConfigFromEnv` returning non-null. When
 * the CI secrets are absent it returns null, `build.ts` skips every call below,
 * and the pipeline publishes exactly the unsigned artifacts it does today — no
 * flag to flip, no second code path to forget. The moment the secrets exist the
 * same build signs, notarizes, staples, and verifies with no other change.
 *
 * Two facts were verified against real tool behaviour on macOS, not memory, and
 * both are load-bearing:
 *
 *   1. `bun build --compile` writes its own ad-hoc "linker-signed" signature,
 *      and on Bun >= 1.3.12 that signature reserves too little space in
 *      __LINKEDIT for a real one (oven-sh/bun#29120). Re-signing on top of it
 *      produces a truncated signature that fails `codesign --verify --strict`
 *      with "main executable failed strict validation". The fix is to build with
 *      `BUN_NO_CODESIGN_MACHO_BINARY=1` (the workflow sets it only when signing
 *      is on) so codesign can lay down a correct signature. Proven locally: the
 *      no-codesign build signs strict-clean on both arm64 and cross-compiled
 *      x64; the default build does not.
 *
 *   2. A standalone Mach-O cannot have a notarization ticket stapled — `stapler`
 *      and notarytool accept only .zip/.pkg/.dmg and staple only bundles. The
 *      CLI slices are therefore notarized inside a zip (which registers their
 *      cdhash with Apple) and rely on Gatekeeper's online ticket lookup; only
 *      the .app is stapled and works offline.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** App Store Connect API key credentials for `notarytool`. */
export interface NotaryConfig {
  /** Path to the `AuthKey_XXXXXXXXXX.p8` file. */
  readonly keyPath: string;
  /** The 10-character key identifier. */
  readonly keyId: string;
  /** The App Store Connect issuer UUID. */
  readonly issuer: string;
}

export interface SigningConfig {
  /** `Developer ID Application: Name (TEAMID)`, resolved from the keychain. */
  readonly identity: string;
  /** The 10-character Apple Team ID, for verification's requirement check. */
  readonly teamId: string;
  /** Path to the hardened-runtime entitlements for the CLI slices. */
  readonly entitlements: string;
  /** Non-null enables notarization; null signs only (a local dry run). */
  readonly notary: NotaryConfig | null;
}

/**
 * The environment the pipeline and the dry-run script read. Widened to any
 * string map so `process.env` passes without a cast; the keys below are the ones
 * consulted.
 *
 * - `MACOS_SIGN_IDENTITY` — the Developer ID; its presence is the on switch.
 * - `MACOS_TEAM_ID` — the Apple Team ID, for verification's requirement check.
 * - `HIVE_SIGN_ENTITLEMENTS` — override for the CLI entitlements plist path.
 * - `MACOS_NOTARY_KEY_PATH` / `_KEY_ID` / `_ISSUER_ID` — all three enable notary.
 */
export type SigningEnv = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/**
 * Resolve a signing configuration from the environment, or null when the build
 * should stay unsigned. The single decision that selects the signed vs unsigned
 * branch of the whole pipeline, kept pure so a test can pin it.
 *
 * `MACOS_SIGN_IDENTITY` is the switch: without it there is no certificate to
 * sign with, so the build is unsigned regardless of anything else. Notarization
 * layers on top and is independent — an identity with no notary credentials
 * signs and verifies locally but does not submit, which is exactly what a local
 * dry run wants.
 */
export function signingConfigFromEnv(
  env: SigningEnv,
  defaultEntitlements: string,
): SigningConfig | null {
  const identity = nonEmpty(env.MACOS_SIGN_IDENTITY);
  if (identity === null) return null;

  const keyPath = nonEmpty(env.MACOS_NOTARY_KEY_PATH);
  const keyId = nonEmpty(env.MACOS_NOTARY_KEY_ID);
  const issuer = nonEmpty(env.MACOS_NOTARY_ISSUER_ID);
  const notary: NotaryConfig | null =
    keyPath !== null && keyId !== null && issuer !== null
      ? { keyPath, keyId, issuer }
      : null;

  return {
    identity,
    teamId: nonEmpty(env.MACOS_TEAM_ID) ?? "",
    entitlements: nonEmpty(env.HIVE_SIGN_ENTITLEMENTS) ?? defaultEntitlements,
    notary,
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string[]): Promise<RunResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function runOrThrow(command: string[]): Promise<string> {
  const result = await run(command);
  if (result.code !== 0) {
    throw new Error(
      `${command[0]} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Sign one `bun --compile` CLI slice: Developer ID, hardened runtime, a secure
 * timestamp, and the JIT entitlements JavaScriptCore needs. `--force` replaces
 * the ad-hoc signature Bun left behind. The secure timestamp reaches out to
 * Apple's timestamp server, so this step needs network.
 */
export async function signCliSlice(path: string, config: SigningConfig): Promise<void> {
  await runOrThrow([
    "codesign", "--force",
    "--sign", config.identity,
    "--options", "runtime",
    "--timestamp",
    "--entitlements", config.entitlements,
    path,
  ]);
}

/**
 * Sign the Workspace .app: Developer ID, hardened runtime, secure timestamp, no
 * entitlements. It is a plain AppKit binary that neither JITs nor loads foreign
 * code, so it gets the strictest runtime with nothing relaxed.
 */
export async function signAppBundle(path: string, config: SigningConfig): Promise<void> {
  await runOrThrow([
    "codesign", "--force",
    "--sign", config.identity,
    "--options", "runtime",
    "--timestamp",
    path,
  ]);
}

/**
 * Notarize every path in one submission and return once Apple has ruled. A
 * combined zip means one round trip rather than one per artifact. notarytool's
 * exit status is not a contract we lean on: we parse the JSON `status` and treat
 * anything but `Accepted` as failure, fetching the log so the reason lands in CI
 * output instead of a bare "Invalid".
 */
export async function notarize(paths: string[], notary: NotaryConfig): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "hive-notarize-"));
  try {
    const bundle = join(staging, "artifacts");
    await runOrThrow(["mkdir", "-p", bundle]);
    for (const path of paths) {
      await runOrThrow(["cp", "-R", path, join(bundle, basename(path))]);
    }
    const zip = join(staging, "submission.zip");
    await runOrThrow(["ditto", "-c", "-k", "--keepParent", bundle, zip]);

    const key = ["--key", notary.keyPath, "--key-id", notary.keyId, "--issuer", notary.issuer];
    const submit = await run([
      "xcrun", "notarytool", "submit", zip, ...key, "--output-format", "json", "--wait",
    ]);
    const parsed = safeJson(submit.stdout);
    const status = typeof parsed?.status === "string" ? parsed.status : "unknown";
    const id = typeof parsed?.id === "string" ? parsed.id : null;

    if (status !== "Accepted") {
      let detail = submit.stdout.trim() || submit.stderr.trim();
      if (id !== null) {
        const log = await run(["xcrun", "notarytool", "log", id, ...key]);
        detail += `\n--- notarization log ---\n${log.stdout.trim() || log.stderr.trim()}`;
      }
      throw new Error(`Notarization returned ${status}, not Accepted:\n${detail}`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function safeJson(text: string): { status?: string; id?: string } | null {
  try {
    return JSON.parse(text) as { status?: string; id?: string };
  } catch {
    return null;
  }
}

/** Staple the ticket into a bundle so Gatekeeper needs no network. Bundles only. */
export async function staple(bundlePath: string): Promise<void> {
  await runOrThrow(["xcrun", "stapler", "staple", bundlePath]);
}

/**
 * The whole Developer ID dance for a release: sign the CLI slices and the app,
 * notarize them together, then staple the app. The CLI slices are deliberately
 * left un-stapled — a standalone Mach-O cannot carry a ticket, so they rely on
 * Gatekeeper's online lookup, which the notarization above registered.
 *
 * Called by `build.ts` after every artifact is built and before any digest is
 * taken, because stapling changes the app's bytes and the manifest must record
 * the final, stapled bytes.
 */
export async function signRelease(
  artifacts: { cliSlices: string[]; appBundle: string | null },
  config: SigningConfig,
): Promise<void> {
  for (const slice of artifacts.cliSlices) {
    await signCliSlice(slice, config);
  }
  if (artifacts.appBundle !== null) {
    await signAppBundle(artifacts.appBundle, config);
  }

  if (config.notary !== null) {
    const toNotarize = [
      ...artifacts.cliSlices,
      ...(artifacts.appBundle !== null ? [artifacts.appBundle] : []),
    ];
    await notarize(toNotarize, config.notary);
    if (artifacts.appBundle !== null) {
      await staple(artifacts.appBundle);
    }
  }
}
