import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  artifactLabel,
  assertIdentityUnchanged,
  baselineMetadata,
  binaryIdentity,
  copyDetachedTree,
  detachedTreeEvidence,
  makeDetachedTreeRemovable,
  metadataDigest,
  verifyDetachedTree,
} from "../../test/live/mail-vendor-rig";

const vendors = {
  claude: {
    binary: ".local/bin/claude",
    artifacts: [],
    baselines: [".claude", ".claude.json"],
  },
  codex: {
    binary: ".local/bin/codex",
    artifacts: [{ source: ".codex/auth.json", destination: ".codex/auth.json" }],
    baselines: [".codex"],
  },
  grok: {
    binary: ".opencode/bin/grok",
    artifacts: [{ source: ".grok/auth.json", destination: ".grok/auth.json" }],
    baselines: [".grok"],
  },
  kimi: {
    binary: ".kimi-code/bin/kimi",
    artifacts: [
      {
        source: ".kimi-code/credentials",
        destination: ".kimi-code/credentials",
      },
      // Kimi's CLI opens its OAuth file O_RDWR at startup to take the refresh
      // lock, and Hive installs its turn-status hook into the user-level
      // config.toml at every spawn; a read-only borrow of either cannot
      // launch at all. The private copies are detached, so owner-writability
      // there cannot reach the user tree — post-run node metadata records
      // what was written (containment).
      {
        source: ".kimi-code/oauth",
        destination: ".kimi-code/oauth",
        writable: true,
      },
      {
        source: ".kimi-code/config.toml",
        destination: ".kimi-code/config.toml",
        writable: true,
      },
    ],
    baselines: [".kimi-code"],
  },
  opencode: {
    binary: ".opencode/bin/opencode",
    artifacts: [
      {
        source: ".local/share/opencode/auth.json",
        destination: ".local/share/opencode/auth.json",
      },
    ],
    baselines: [".config/opencode", ".local/share/opencode"],
  },
} as const;

type Vendor = keyof typeof vendors;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function makePrivateTreeWritable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) {
      await makePrivateTreeWritable(join(path, name));
    }
  } else {
    await chmod(path, 0o600);
  }
}

function isWritableArtifact(artifact: unknown): boolean {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    "writable" in artifact &&
    artifact.writable === true
  );
}

async function baseline(paths: readonly string[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const relativePath of paths) {
    const path = join(homedir(), relativePath);
    result[relativePath] = (await exists(path))
      ? await baselineMetadata(path)
      : { digest: "ABSENT", nodes: [] };
  }
  return result;
}

/** Claude keeps its credential in the login keychain, which a separate HOME
 * cannot reach: the keychain search list is resolved from HOME, so the rig sees
 * only the System keychain and the CLI reports "Not logged in". */
async function keychainCredential(): Promise<string> {
  const child = Bun.spawn(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [credential, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`claude keychain credential is unreadable: ${error.trim()}`);
  }
  return credential;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function baselineDigests(
  value: Record<string, { digest: string }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([path, measurement]) => [path, measurement.digest]),
  );
}

const mode = process.argv[2];
const vendor = process.argv[3] as Vendor;
if (!(vendor in vendors)) throw new Error(`unknown vendor: ${vendor}`);
const descriptor = vendors[vendor];
const vendorHome = required("M3_VENDOR_HOME");
const evidence = required("M3_ISOLATION_EVIDENCE");
const userBaseline = required("M3_USER_BASELINE");
const originalHome = required("M3_USER_HOME");
if (homedir() !== originalHome) {
  throw new Error("run the isolation instrument with the user HOME");
}

if (mode === "prepare") {
  await rm(vendorHome, { force: true, recursive: true });
  await mkdir(vendorHome, { recursive: true, mode: 0o700 });
  await chmod(vendorHome, 0o700);
  const parent = await lstat(vendorHome);
  if ((parent.mode & 0o077) !== 0) throw new Error("vendor home is not private");

  const binary = await realpath(join(originalHome, descriptor.binary));
  const artifacts = [];
  const borrowedArtifacts =
    process.env.M3_SKIP_BORROW === "1" ? [] : descriptor.artifacts;
  for (const artifact of borrowedArtifacts) {
    const source = join(originalHome, artifact.source);
    const destination = join(vendorHome, artifact.destination);
    await copyDetachedTree(source, destination);
    if (isWritableArtifact(artifact)) await makePrivateTreeWritable(destination);
    artifacts.push({
      label: artifactLabel(source),
      sourceMetadata: await metadataDigest(source),
      destinationMetadata: await metadataDigest(destination),
      verification: isWritableArtifact(artifact)
        ? await detachedTreeEvidence(source, destination)
        : await verifyDetachedTree(source, destination),
    });
  }
  if (vendor === "codex") {
    const config = join(vendorHome, ".codex", "config.toml");
    await mkdir(join(vendorHome, ".codex"), { recursive: true, mode: 0o700 });
    await writeFile(config, "check_for_update_on_startup = false\n", {
      mode: 0o600,
    });
  }
  let claudeCredentialDigest: string | null = null;
  if (vendor === "claude") {
    // The CLI gates the composer behind first-run onboarding, and Hive adds the
    // per-worktree trust entry to this same file at spawn time. Both phases get
    // it, so the credential is the only thing the borrow-free phase withholds.
    await writeFile(
      join(vendorHome, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" })}\n`,
      { mode: 0o600 },
    );
    if (process.env.M3_SKIP_BORROW !== "1") {
      const credential = await keychainCredential();
      claudeCredentialDigest = digest(credential);
      await mkdir(join(vendorHome, ".claude"), { recursive: true, mode: 0o700 });
      await writeFile(join(vendorHome, ".claude", ".credentials.json"), credential, {
        mode: 0o400,
      });
    }
  }
  const userAdjustments: string[] = [];
  if (
    vendor === "kimi" &&
    borrowedArtifacts.some((artifact) =>
      artifact.destination.endsWith("config.toml"),
    )
  ) {
    // Unattended QA agents cannot answer Kimi's manual-mode approval
    // prompts, and the user's config names no default. The private copy
    // gets one; the user's file is never touched. Prepended, because a
    // bare key appended after the last table would nest inside it.
    const config = join(vendorHome, ".kimi-code", "config.toml");
    const existing = await readFile(config, "utf8");
    await writeFile(config, `default_permission_mode = "yolo"\n\n${existing}`, {
      mode: 0o600,
    });
    userAdjustments.push(
      '.kimi-code/config.toml: prepended default_permission_mode = "yolo" so the unattended QA agent can call tools',
    );
  }
  const userBefore = await baseline(descriptor.baselines);
  await writeJson(userBaseline, userBefore);
  await writeJson(evidence, {
    vendor,
    phase: "prepared",
    binary,
    binaryBefore: await binaryIdentity(binary),
    claudeCredentialDigest,
    userBefore: baselineDigests(
      userBefore as Record<string, { digest: string }>,
    ),
    borrowed: borrowedArtifacts.map((artifact) => artifact.destination),
    userAdjustments,
    artifacts,
  });
} else if (mode === "verify") {
  const prepared = await Bun.file(evidence).json();
  const userBeforeNodes = await Bun.file(userBaseline).json();
  const binaryAfter = await binaryIdentity(prepared.binary);
  const userAfterNodes = await baseline(descriptor.baselines);
  const changedOperatorPaths = descriptor.baselines.filter(
    (path) =>
      prepared.userBefore[path] !==
      (userAfterNodes[path] as { digest: string }).digest,
  );
  const changedOperatorNodes = Object.fromEntries(
    changedOperatorPaths.map((path) => {
      const before = new Map(
        userBeforeNodes[path].nodes.map((node: { relativePath: string }) => [
          node.relativePath,
          node,
        ]),
      );
      const after = new Map(
        (userAfterNodes[path] as { nodes: Array<{ relativePath: string }> }).nodes.map(
          (node) => [node.relativePath, node],
        ),
      );
      const relativePaths = new Set([...before.keys(), ...after.keys()]);
      return [
        path,
        [...relativePaths]
          .sort()
          .filter(
            (relativePath) =>
              JSON.stringify(before.get(relativePath)) !==
              JSON.stringify(after.get(relativePath)),
          )
          .map((relativePath) => ({
            relativePath,
            before: before.get(relativePath) ?? null,
            after: after.get(relativePath) ?? null,
          })),
      ];
    }),
  );
  const artifacts = [];
  const artifactErrors: string[] = [];
  for (const artifact of descriptor.artifacts.filter((artifact) =>
    prepared.borrowed.includes(artifact.destination),
  )) {
    const source = join(originalHome, artifact.source);
    const destination = join(vendorHome, artifact.destination);
    const evidence = await detachedTreeEvidence(source, destination);
    artifacts.push({
      label: artifactLabel(source),
      sourceMetadata: await metadataDigest(source),
      destinationMetadata: await metadataDigest(destination),
      ...evidence,
    });
    if (
      evidence.error !== null &&
      !(
        isWritableArtifact(artifact) &&
        evidence.error.startsWith("detached credential node is writable")
      )
    )
      artifactErrors.push(evidence.error);
  }
  const claudeCredentialDigestAfter =
    prepared.claudeCredentialDigest === null
      ? null
      : digest(await keychainCredential());
  await writeJson(evidence, {
    ...prepared,
    phase: "verified",
    binaryAfter,
    claudeCredentialDigestAfter,
    userAfter: baselineDigests(
      userAfterNodes as Record<string, { digest: string }>,
    ),
    changedOperatorPaths,
    changedOperatorNodes,
    artifactsAfter: artifacts,
  });
  assertIdentityUnchanged(prepared.binaryBefore, binaryAfter);
  if (claudeCredentialDigestAfter !== prepared.claudeCredentialDigest) {
    throw new Error("CREDENTIAL_WRITE_BACK");
  }
  if (artifactErrors.length > 0) throw new Error(artifactErrors.join("; "));
  if (changedOperatorPaths.length > 0) throw new Error("ISOLATION_BREACH");
} else if (mode === "release") {
  const prepared = await Bun.file(evidence).json();
  for (const artifact of descriptor.artifacts.filter((artifact) =>
    prepared.borrowed.includes(artifact.destination),
  )) {
    const destination = join(vendorHome, artifact.destination);
    if (await exists(destination)) await makeDetachedTreeRemovable(destination);
  }
} else {
  throw new Error("usage: mail-vendor-isolation.ts prepare|verify|release <vendor>");
}
