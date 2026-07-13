/**
 * What can be proven without a certificate: the branch that decides signed vs
 * unsigned, the exact entitlements the CLI slices are signed with, that the
 * offline manifest signature the pipeline produces verifies against the key the
 * binary embeds, and that the workflow wires all of it up and fails on defects.
 *
 * Everything that needs a real Developer ID — the codesign, notarytool, and
 * stapler calls — is proven instead by scripts/signing/dry-run.sh against a real
 * cert, because pretending to test it here would be a test that always passes.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyManifest } from "./manifest";
import { signingConfigFromEnv } from "./sign";
import { signManifest } from "../../scripts/signing/sign-manifest";

const repoRoot = resolve(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const ENTITLEMENTS = "scripts/signing/entitlements.plist";

describe("the signed-vs-unsigned decision", () => {
  test("no signing identity means the unsigned branch, whatever else is set", () => {
    expect(
      signingConfigFromEnv(
        {
          MACOS_NOTARY_KEY_PATH: "/tmp/AuthKey.p8",
          MACOS_NOTARY_KEY_ID: "ABCDE12345",
          MACOS_NOTARY_ISSUER_ID: "issuer-uuid",
        },
        ENTITLEMENTS,
      ),
    ).toBeNull();
  });

  test("an empty identity is treated as unset, not as a certificate", () => {
    expect(signingConfigFromEnv({ MACOS_SIGN_IDENTITY: "   " }, ENTITLEMENTS)).toBeNull();
  });

  test("an identity with no notary credentials signs but does not notarize", () => {
    const config = signingConfigFromEnv(
      { MACOS_SIGN_IDENTITY: "Developer ID Application: X (TEAMID)" },
      ENTITLEMENTS,
    );
    expect(config).not.toBeNull();
    expect(config?.notary).toBeNull();
    expect(config?.entitlements).toBe(ENTITLEMENTS);
  });

  test("partial notary credentials do not half-enable notarization", () => {
    const config = signingConfigFromEnv(
      {
        MACOS_SIGN_IDENTITY: "Developer ID Application: X (TEAMID)",
        MACOS_NOTARY_KEY_ID: "ABCDE12345",
        // key path and issuer missing
      },
      ENTITLEMENTS,
    );
    expect(config?.notary).toBeNull();
  });

  test("a full set enables notarization with all three credentials", () => {
    const config = signingConfigFromEnv(
      {
        MACOS_SIGN_IDENTITY: "Developer ID Application: X (TEAMID)",
        MACOS_TEAM_ID: "TEAMID",
        MACOS_NOTARY_KEY_PATH: "/tmp/AuthKey.p8",
        MACOS_NOTARY_KEY_ID: "ABCDE12345",
        MACOS_NOTARY_ISSUER_ID: "issuer-uuid",
      },
      ENTITLEMENTS,
    );
    expect(config?.notary).toEqual({
      keyPath: "/tmp/AuthKey.p8",
      keyId: "ABCDE12345",
      issuer: "issuer-uuid",
    });
    expect(config?.teamId).toBe("TEAMID");
  });

  test("an explicit entitlements path overrides the default", () => {
    const config = signingConfigFromEnv(
      {
        MACOS_SIGN_IDENTITY: "Developer ID Application: X (TEAMID)",
        HIVE_SIGN_ENTITLEMENTS: "/custom/ent.plist",
      },
      ENTITLEMENTS,
    );
    expect(config?.entitlements).toBe("/custom/ent.plist");
  });
});

describe("the hardened-runtime entitlements", () => {
  const plist = read(ENTITLEMENTS);
  // The granted entitlements are the <key>…</key><true/> pairs, not anything the
  // explanatory comment happens to name.
  const grantedKeys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]);

  test("grant exactly the two JavaScriptCore JIT needs, in order", () => {
    expect(grantedKeys).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ]);
  });

  test("do not grant the broad entitlements Hive deliberately omits", () => {
    // A self-contained --compile binary needs none of these, and each is attack
    // surface. If a future change adds one, it should be a deliberate edit that
    // fails this test first.
    for (const forbidden of [
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.disable-executable-page-protection",
      "com.apple.security.cs.allow-dyld-environment-variables",
    ]) {
      expect(grantedKeys).not.toContain(forbidden);
    }
  });
});

describe("the offline manifest signature", () => {
  test("what sign-manifest produces verifies against the embedded key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const bytes = new TextEncoder().encode('{"schema":1,"version":"0.0.7"}\n');

    const signature = signManifest(bytes, priv);
    expect(verifyManifest(bytes, signature, pub)).toEqual({ verified: true, signed: true });
  });

  test("a signature from the wrong key is refused", () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const priv = signer.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const otherPub = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const bytes = new TextEncoder().encode('{"schema":1}\n');

    expect(verifyManifest(bytes, signManifest(bytes, priv), otherPub))
      .toMatchObject({ verified: false });
  });
});

describe("the release workflow's signing steps", () => {
  const workflow = read(".github/workflows/release.yml");

  test("degrades gracefully: it detects config rather than gating on a flag", () => {
    // No secret configured -> the detect step reports false and signing is
    // skipped; the build path is identical to today's unsigned release.
    expect(workflow).toContain("Detect signing configuration");
    expect(workflow).toMatch(/apple=/);
    expect(workflow).toMatch(/manifest=/);
  });

  test("resolves the signing identity from the imported certificate, not a secret", () => {
    // A hand-typed identity secret can drift from the certificate's common
    // name; codesign's only symptom for that drift is "no identity found".
    expect(workflow).toContain("security find-identity");
    expect(workflow).toContain("steps.keychain.outputs.identity");
    expect(workflow).not.toContain("secrets.MACOS_SIGN_IDENTITY");
  });

  test("builds re-signable Bun binaries only when signing (bun#29120 workaround)", () => {
    expect(workflow).toContain("BUN_NO_CODESIGN_MACHO_BINARY");
  });

  test("passes notarytool credentials through env, never inline", () => {
    expect(workflow).toContain("MACOS_NOTARY_KEY_ID");
    expect(workflow).toContain("MACOS_NOTARY_ISSUER_ID");
  });

  test("signs the manifest with the offline key and publishes the signature", () => {
    expect(workflow).toContain("scripts/signing/sign-manifest.ts");
    expect(workflow).toContain("hive-release.json.sig");
  });

  test("embeds the public key so update verification becomes fail-closed", () => {
    expect(workflow).toContain("--public-key");
    expect(workflow).toContain("HIVE_RELEASE_PUBLIC_KEY");
  });

  test("gates the release on Gatekeeper verification before the tag is pushed", () => {
    const verify = workflow.indexOf("scripts/signing/verify.sh");
    const tag = workflow.indexOf("Publish the tag");
    expect(verify).toBeGreaterThan(0);
    expect(tag).toBeGreaterThan(verify);
    expect(workflow).toContain("--require-notarization");
  });

  test("the verification gate rejects a malformed manifest even when signing is off", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-manifest-gate-"));
    const path = join(root, "hive-release.json");
    try {
      writeFileSync(path, JSON.stringify({
        schema: 1,
        version: "../../invalid",
      }));
      const result = Bun.spawnSync([
        process.execPath,
        "run",
        join(repoRoot, "scripts/signing/verify-manifest.ts"),
        path,
      ], {
        cwd: repoRoot,
        env: { ...process.env, HIVE_RELEASE_PUBLIC_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("invalid release manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
