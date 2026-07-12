import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTrustedRoutingManifest,
  manifestExpiryAlert,
  ROUTING_MANIFEST_FILE,
  ROUTING_SIGNATURE_FILE,
} from "./routing-manifest";
import { FIRST_ROUTING_MANIFEST } from "../schemas";

/**
 * A real Ed25519 keypair, and real signatures over real bytes. Mocking the
 * verifier would test that the code calls a function; only a genuinely bad
 * signature tests that the check rejects one.
 */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" })
  .toString("base64");
const OTHER = generateKeyPairSync("ed25519");

const sign = (bytes: Uint8Array, key = privateKey): string =>
  edSign(null, bytes, key).toString("base64");

const AUTO = { routingManifest: "auto" } as const;
const OFF = { routingManifest: "off" } as const;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hive-routing-trust-"));
  Bun.env.HIVE_HOME = home;
});

afterEach(async () => {
  delete Bun.env.HIVE_HOME;
  await rm(home, { recursive: true, force: true });
});

/** Install a manifest and (optionally) a detached signature over its exact bytes. */
async function install(
  manifest: unknown,
  options: { signature?: string | null; key?: typeof privateKey } = {},
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await Bun.write(join(home, ROUTING_MANIFEST_FILE), bytes);
  const signature = options.signature === undefined
    ? sign(bytes, options.key ?? privateKey)
    : options.signature;
  if (signature !== null) {
    await Bun.write(join(home, ROUTING_SIGNATURE_FILE), `${signature}\n`);
  }
  return bytes;
}

const REVISED = { ...FIRST_ROUTING_MANIFEST, revision: "2026-07-11.a" };

describe("a correctly signed manifest is accepted", () => {
  test("it verifies against the embedded key and supplies the lists", async () => {
    await install(REVISED);
    const trusted = await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY);
    expect(trusted.origin).toBe("installed");
    expect(trusted.manifest?.revision).toBe("2026-07-11.a");
    expect(trusted.warnings).toEqual([]);
  });

  test("with none installed, the built-in stands and says so quietly", async () => {
    const trusted = await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY);
    expect(trusted.origin).toBe("built-in");
    expect(trusted.manifest).toEqual(FIRST_ROUTING_MANIFEST);
    // Not a warning: shipping without a fetched manifest is the ordinary state,
    // and crying wolf about it would train the user to ignore the real ones.
    expect(trusted.warnings).toEqual([]);
  });
});

describe("an untrustworthy manifest fails closed, loudly", () => {
  const rejected = (trusted: Awaited<ReturnType<typeof loadTrustedRoutingManifest>>) => {
    // Fail CLOSED: the built-in manifest governs, the bad document governs
    // nothing, and the user is told.
    expect(trusted.origin).toBe("built-in");
    expect(trusted.manifest).toEqual(FIRST_ROUTING_MANIFEST);
    expect(trusted.warnings).toHaveLength(1);
    return trusted.warnings[0]!;
  };

  test("TAMPERED content with a valid-but-stale signature is rejected", async () => {
    // The attack this exists to stop: sign an honest manifest, then edit the
    // model the deep tier routes to. The bytes no longer match the signature.
    const bytes = new TextEncoder().encode(JSON.stringify(REVISED, null, 2));
    const honestSignature = sign(bytes);
    const tampered = {
      ...REVISED,
      tiers: {
        ...REVISED.tiers,
        deep: { ...REVISED.tiers.deep!, claude: [{ canonicalId: "evil-model" }] },
      },
    };
    await install(tampered, { signature: honestSignature });

    const warning = rejected(await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY));
    expect(warning).toContain("does not match");
    // And the attacker's model never reaches a candidate list.
    expect(JSON.stringify(FIRST_ROUTING_MANIFEST)).not.toContain("evil-model");
  });

  test("a manifest signed by the WRONG key is rejected", async () => {
    await install(REVISED, { key: OTHER.privateKey });
    expect(rejected(await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY)))
      .toContain("does not match");
  });

  test("a STRIPPED signature is a refusal, not a downgrade", async () => {
    // Deleting the .sig must not be a way to turn verification off. If it were,
    // the attacker would be choosing our verification policy for us.
    await install(REVISED, { signature: null });
    expect(rejected(await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY)))
      .toContain("no");
  });

  test("a build with NO embedded key refuses to let one govern", async () => {
    // A check this build cannot perform is not a check it may skip. (The release
    // manifest tolerates this state because GitHub and TLS sit underneath it; a
    // routing manifest on local disk has no such anchor.)
    await install(REVISED);
    expect(rejected(await loadTrustedRoutingManifest(AUTO, null)))
      .toContain("no release key");
  });

  test("an unknown schema MAJOR is rejected even when properly signed", async () => {
    await install({ ...REVISED, schema: { major: 2, minor: 0 } });
    expect(rejected(await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY)))
      .toContain("major 2");
  });

  test("a signed manifest that does not validate is rejected", async () => {
    await install({ ...REVISED, tiers: "not a table" });
    const warning = rejected(await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY));
    expect(warning).toContain("does not validate");
  });

  test("unknown FIELDS survive, so a newer minor still governs", async () => {
    // Rejecting unknown fields would make every forward-compatible manifest
    // unusable by an older Hive; preserving them is what lets the curator ship
    // one document to every version.
    await install({
      ...REVISED,
      schema: { major: 1, minor: 7 },
      somethingNewerHivesUnderstand: { weights: [1, 2] },
    });
    const trusted = await loadTrustedRoutingManifest(AUTO, PUBLIC_KEY);
    expect(trusted.origin).toBe("installed");
    expect(trusted.manifest).toMatchObject({
      somethingNewerHivesUnderstand: { weights: [1, 2] },
    });
  });
});

describe("the kill switch", () => {
  test("reverts to the shipped table, consulting no manifest at all", async () => {
    // Even a perfectly valid, correctly signed manifest is disowned.
    await install(REVISED);
    const trusted = await loadTrustedRoutingManifest(OFF, PUBLIC_KEY);
    expect(trusted.origin).toBe("kill-switch");
    expect(trusted.manifest).toBeNull();
    expect(trusted.warnings[0]).toContain("KILL SWITCH");
  });
});

describe("the expiry alert the maintenance tick sends", () => {
  test("a current manifest alerts nothing", () => {
    const before = new Date(Date.parse(FIRST_ROUTING_MANIFEST.validUntil) - 1);
    expect(manifestExpiryAlert(FIRST_ROUTING_MANIFEST, before)).toBeNull();
    expect(manifestExpiryAlert(null, before)).toBeNull();
  });

  test("an expired one names the revision, the date, and the remedy", () => {
    const after = new Date(Date.parse(FIRST_ROUTING_MANIFEST.validUntil) + 1);
    const alert = manifestExpiryAlert(FIRST_ROUTING_MANIFEST, after)!;
    expect(alert).toContain(FIRST_ROUTING_MANIFEST.revision);
    expect(alert).toContain(FIRST_ROUTING_MANIFEST.validUntil);
    expect(alert).toContain("last-known-good");
    expect(alert).toContain("update hive");
  });
});
