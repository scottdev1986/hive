import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface NotaryConfig {
  readonly keyPath: string;
  readonly keyId: string;
  readonly issuer: string;
}

export interface SigningConfig {
  readonly identity: string;
  readonly teamId: string;
  readonly entitlements: string;
  readonly notary: NotaryConfig | null;
}

export type SigningEnv = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

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

export async function signCliSlice(
  path: string,
  config: SigningConfig,
): Promise<void> {
  await runOrThrow([
    "codesign",
    "--force",
    "--sign",
    config.identity,
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    config.entitlements,
    path,
  ]);
}

/** Sign the Workspace .app: Developer ID, hardened runtime, secure timestamp, no entitlements. It is a plain AppKit binary that neither JITs nor loads foreign code, so it gets the strictest runtime with nothing relaxed. */
export async function signAppBundle(
  path: string,
  config: SigningConfig,
): Promise<void> {
  await runOrThrow([
    "codesign",
    "--force",
    "--sign",
    config.identity,
    "--options",
    "runtime",
    "--timestamp",
    path,
  ]);
}

/** Notarize every path in one submission and return once Apple has ruled. A combined zip means one round trip rather than one per artifact. notarytool's exit status is not a contract we lean on: we parse the JSON `status` and treat anything but `Accepted` as failure, fetching the log so the reason lands in CI output instead of a bare "Invalid". */
export async function notarize(
  paths: string[],
  notary: NotaryConfig,
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "hive-notarize-"));
  try {
    const bundle = join(staging, "artifacts");
    await runOrThrow(["mkdir", "-p", bundle]);
    for (const path of paths) {
      await runOrThrow(["cp", "-R", path, join(bundle, basename(path))]);
    }
    const zip = join(staging, "submission.zip");
    await runOrThrow(["ditto", "-c", "-k", "--keepParent", bundle, zip]);

    const key = [
      "--key",
      notary.keyPath,
      "--key-id",
      notary.keyId,
      "--issuer",
      notary.issuer,
    ];
    const submit = await run([
      "xcrun",
      "notarytool",
      "submit",
      zip,
      ...key,
      "--output-format",
      "json",
      "--wait",
    ]);
    const parsed = safeJson(submit.stdout);
    const status =
      typeof parsed?.status === "string" ? parsed.status : "unknown";
    const id = typeof parsed?.id === "string" ? parsed.id : null;

    if (status !== "Accepted") {
      let detail = submit.stdout.trim() || submit.stderr.trim();
      if (id !== null) {
        const log = await run(["xcrun", "notarytool", "log", id, ...key]);
        detail += `\n--- notarization log ---\n${log.stdout.trim() || log.stderr.trim()}`;
      }
      throw new Error(
        `Notarization returned ${status}, not Accepted:\n${detail}`,
      );
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

export async function staple(bundlePath: string): Promise<void> {
  await runOrThrow(["xcrun", "stapler", "staple", bundlePath]);
}

/** The whole Developer ID dance for a release: sign the CLI slices and the app, notarize them together, then staple the app. The CLI slices are deliberately left un-stapled — a standalone Mach-O cannot carry a ticket, so they rely on Gatekeeper's online lookup, which the notarization above registered. Called by `build.ts` after every artifact is built and before any digest is taken, because stapling changes the app's bytes and the manifest must record the final, stapled bytes. */
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
