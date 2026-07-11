import { homedir } from "node:os";
import { join } from "node:path";
import { verifyManifest } from "../release/manifest";
import {
  FIRST_ROUTING_MANIFEST,
  RoutingManifestSchema,
  type HiveConfig,
  type RoutingManifest,
} from "../schemas";
import { HIVE_RELEASE_PUBLIC_KEY } from "../version";

/**
 * Trust for the routing manifest.
 *
 * A routing manifest is an instruction about *where the user's code executes*.
 * A fetched one that nobody signed is an injection vector, so it is treated as
 * hostile until proven otherwise, and the proof is the same Ed25519 signature
 * that already authenticates update policy: `release/manifest.ts`'s
 * `verifyManifest`, the offline key whose public half is inlined into the binary
 * at build time, and the same comma-separated key list that makes rotation
 * possible without a flag day. There is deliberately no second signing scheme
 * here — a routing manifest and a release manifest are the same kind of claim
 * (this document is Hive's), and `scripts/signing/sign-manifest.ts` already signs
 * the exact bytes of any file with the offline key, so publishing one needs no
 * new machinery and, notably, need not ride a release.
 *
 * Three states, and no silent ones:
 *
 * - **installed** — a manifest exists in HIVE_HOME, its detached signature
 *   verifies against an embedded key, and it parses. It supplies the candidate
 *   lists.
 * - **built-in** — either no manifest is installed (the ordinary state), or one
 *   is installed and was *rejected*. Either way the compiled-in manifest stands,
 *   which is in-binary judgment carrying the binary's own signature. A rejection
 *   is loud, and it changes nothing on disk: a failed verify never installs.
 * - **off** — the kill switch. No manifest, and nothing derived from one.
 *
 * The failure direction is the whole design. An attacker who can write
 * `routing-manifest.json` gets the built-in manifest, never their models; a build
 * with no embedded key cannot check anything, so it refuses to let an installed
 * manifest govern rather than implying a signature it never verified. Both are
 * fail-closed, and neither is quiet about it.
 */

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export const ROUTING_MANIFEST_FILE = "routing-manifest.json";
export const ROUTING_SIGNATURE_FILE = "routing-manifest.json.sig";

export type ManifestOrigin = "installed" | "built-in" | "kill-switch";

export interface TrustedRoutingManifest {
  /** `null` only under the kill switch: routing reverts to the shipped table. */
  manifest: RoutingManifest | null;
  origin: ManifestOrigin;
  /** The manifest's revision, or why there isn't one. Printed, never inferred. */
  detail: string;
  /** Loud and deduplicated. A rejected manifest never fails quietly. */
  warnings: string[];
}

/**
 * Resolve the manifest that may supply candidate lists, and say where it came
 * from. Never throws: a broken manifest degrades to the built-in one with a
 * warning, because a routing table that cannot be read is a reason to fall back,
 * not a reason to refuse to spawn anything.
 */
export async function loadTrustedRoutingManifest(
  config: Pick<HiveConfig, "routingManifest">,
  publicKey: string | null = HIVE_RELEASE_PUBLIC_KEY,
): Promise<TrustedRoutingManifest> {
  if (config.routingManifest === "off") {
    return {
      manifest: null,
      origin: "kill-switch",
      detail: "kill switch engaged (config.toml: routingManifest = \"off\")",
      warnings: [
        "KILL SWITCH: manifest-derived routing is off. Routing reverts to the " +
        "shipped table; no manifest, and nothing derived from one, is consulted.",
      ],
    };
  }

  const builtIn = (detail: string, warnings: string[] = []) => ({
    manifest: FIRST_ROUTING_MANIFEST,
    origin: "built-in" as const,
    detail,
    warnings,
  });

  const path = join(hiveHome(), ROUTING_MANIFEST_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return builtIn(
      `no manifest installed at ${path}; using the compiled-in manifest`,
    );
  }

  const reject = (reason: string) =>
    builtIn(`installed manifest REJECTED; using the compiled-in manifest`, [
      `REJECTED the installed routing manifest at ${path}: ${reason}. It has ` +
      "not been installed and does not route anything. A routing manifest " +
      "chooses which model runs your code; an unverifiable one is refused, " +
      "never merely distrusted.",
    ]);

  // The exact bytes, never a re-serialization: JSON key order and whitespace are
  // part of what was signed.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signaturePath = join(hiveHome(), ROUTING_SIGNATURE_FILE);
  const signatureFile = Bun.file(signaturePath);
  const signature = (await signatureFile.exists())
    ? (await signatureFile.text()).trim()
    : null;

  const trust = verifyManifest(bytes, signature, publicKey);
  if (!trust.verified) {
    return reject(trust.reason);
  }
  if (!trust.signed) {
    // `verifyManifest` treats a keyless build as "verified, unsigned" because a
    // release manifest still has GitHub and TLS underneath it. A routing manifest
    // sitting on local disk has no such anchor, so the same state is a refusal
    // here: this build cannot check the signature, and a check it cannot perform
    // is not a check it may skip.
    return reject(
      "this build embeds no release key, so nothing can verify the manifest " +
        `(${trust.warning})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return reject(
      `signature verified but the JSON does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const result = RoutingManifestSchema.safeParse(parsed);
  if (!result.success) {
    // An unknown *major* is a deliberate refusal rather than a parse accident:
    // the schema pins major 1, and a manifest written for a newer Hive is a
    // document this Hive is not entitled to interpret. Unknown *fields* are
    // preserved verbatim (the schema is loose), so a newer minor passes through.
    const major = (parsed as { schema?: { major?: unknown } } | null)?.schema
      ?.major;
    return reject(
      typeof major === "number" && major !== 1
        ? `schema major ${major} is newer than this Hive understands (expects 1)`
        : `signature verified but the manifest does not validate: ${
          result.error.issues[0]?.message ?? "invalid"
        }`,
    );
  }

  return {
    manifest: result.data,
    origin: "installed",
    detail: `${result.data.revision} (signed, verified against the embedded release key)`,
    warnings: [],
  };
}
