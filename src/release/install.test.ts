import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  activateWithHealthCheck,
  rollback,
  stageRelease,
} from "../update/install";
import type { ReleaseManifest } from "./manifest";

const repoRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const RELEASE_KEY = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString("base64"),
  };
})();

interface InstallerFixture {
  root: string;
  installRoot: string;
  binDir: string;
  fakeBin: string;
  fixtures: string;
  workspaceBytes: Uint8Array;
}

function manifestFor(
  version: string,
  cliBytes: Uint8Array,
  workspaceBytes: Uint8Array,
  sessiondBytes: Uint8Array = new TextEncoder().encode("#!/bin/sh\necho sessiond\n"),
): ReleaseManifest {
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    channel: "stable",
    commit: `commit-${version}`,
    publishedAt: "2026-07-13T00:00:00Z",
    securityCritical: false,
    wireProtocol: { min: 1, max: 1 },
    schemaEpoch: 1,
    artifacts: [
      {
        name: "hive-darwin-arm64",
        kind: "cli",
        platform: "darwin",
        arch: "arm64",
        size: cliBytes.byteLength,
        sha256: sha256(cliBytes),
        buildHash: `hash-${version}`,
      },
      {
        name: "hive-sessiond-darwin-arm64",
        kind: "sessiond",
        platform: "darwin",
        arch: "arm64",
        size: sessiondBytes.byteLength,
        sha256: sha256(sessiondBytes),
        buildHash: `sessiond-hash-${version}`,
      },
      {
        name: "HiveWorkspace.tar.gz",
        kind: "workspace",
        platform: "darwin",
        arch: "arm64",
        size: workspaceBytes.byteLength,
        sha256: sha256(workspaceBytes),
        buildHash: `hash-${version}`,
      },
    ],
  };
}

async function createInstallerFixture(
  version: string,
  withSignature = true,
): Promise<InstallerFixture> {
  const root = await mkdtemp(join(tmpdir(), "hive-installer-provenance-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const binDir = join(root, "bin");
  const fixtures = join(root, "fixtures");
  const fakeBin = join(root, "fake-bin");
  const workspaceRoot = join(root, "workspace-archive");
  await mkdir(fixtures, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(workspaceRoot, "HiveWorkspace.app"), { recursive: true });
  await writeFile(join(workspaceRoot, "HiveWorkspace.app", "fixture"), "workspace\n");

  const archive = join(fixtures, "HiveWorkspace.tar.gz");
  const tar = Bun.spawn([
    "tar",
    "-czf",
    archive,
    "-C",
    workspaceRoot,
    "HiveWorkspace.app",
  ]);
  expect(await tar.exited).toBe(0);
  const workspaceBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const cliBytes = new TextEncoder().encode(
    `#!/bin/sh\necho 'hive ${version}'\n`,
  );
  const sessiondBytes = new TextEncoder().encode("#!/bin/sh\necho sessiond\n");
  await writeFile(join(fixtures, "hive-darwin-arm64"), cliBytes);
  await writeFile(join(fixtures, "hive-sessiond-darwin-arm64"), sessiondBytes);

  const manifest = manifestFor(version, cliBytes, workspaceBytes, sessiondBytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(join(fixtures, "hive-release.json"), manifestBytes);
  if (withSignature) {
    await writeFile(
      join(fixtures, "hive-release.json.sig"),
      `${RELEASE_KEY.sign(manifestBytes)}\n`,
    );
  }
  await writeFile(
    join(fixtures, "release.json"),
    `{"tag_name":"v${version}"}\n`,
  );

  const curl = join(fakeBin, "curl");
  await writeFile(
    curl,
    `#!/bin/sh
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  cp "$HIVE_INSTALL_FIXTURES/\${url##*/}" "$out"
else
  cat "$HIVE_INSTALL_FIXTURES/release.json"
fi
`,
  );
  await chmod(curl, 0o755);
  return { root, installRoot, binDir, fakeBin, fixtures, workspaceBytes };
}

async function runInstaller(
  fixture: InstallerFixture,
  version: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["sh", join(repoRoot, "install.sh"), version], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
      HIVE_INSTALL_FIXTURES: fixture.fixtures,
      HIVE_INSTALL_ROOT: fixture.installRoot,
      HIVE_BIN_DIR: fixture.binDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function selfUpdate(
  fixture: InstallerFixture,
  version: string,
): Promise<void> {
  const cliBytes = new TextEncoder().encode(
    `#!/bin/sh\necho 'hive ${version}'\n`,
  );
  const sessiondBytes = new TextEncoder().encode("#!/bin/sh\necho sessiond\n");
  const manifest = manifestFor(version, cliBytes, fixture.workspaceBytes, sessiondBytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await stageRelease({
    manifest,
    manifestBytes,
    signature: RELEASE_KEY.sign(manifestBytes),
    arch: "arm64",
    root: fixture.installRoot,
    publicKey: RELEASE_KEY.publicKey,
    download: async (name) => {
      if (name === "hive-sessiond-darwin-arm64") return sessiondBytes;
      if (name !== "hive-darwin-arm64") throw new Error(`unexpected asset ${name}`);
      return cliBytes;
    },
    probeVersion: async () => `hive ${version}`,
  });
  const outcome = await activateWithHealthCheck(version, {
    root: fixture.installRoot,
    healthCheck: async () => true,
  });
  expect(outcome.activated).toBe(true);
}

describe("the standalone installer", () => {
  test("a fresh signed install remains a fully verified rollback target", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const installed = await runInstaller(fixture, "1.2.3");
    expect(installed.exitCode).toBe(0);

    await selfUpdate(fixture, "1.2.4");
    const outcome = await rollback({
      root: fixture.installRoot,
      arch: "arm64",
      publicKey: RELEASE_KEY.publicKey,
      healthCheck: async () => true,
    });

    expect(outcome).toMatchObject({ activated: true, version: "1.2.3" });
    expect(await readlink(join(fixture.installRoot, "current")))
      .toBe("versions/1.2.3");
  });

  test("rollback refuses a shell-installed version whose bytes were changed", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const installed = await runInstaller(fixture, "1.2.3");
    expect(installed.exitCode).toBe(0);
    await selfUpdate(fixture, "1.2.4");
    await writeFile(
      join(fixture.installRoot, "versions", "1.2.3", "hive"),
      "#!/bin/sh\necho tampered\n",
    );

    await expect(rollback({
      root: fixture.installRoot,
      arch: "arm64",
      publicKey: RELEASE_KEY.publicKey,
      healthCheck: async () => true,
    })).rejects.toThrow(/does not match its signed release manifest/);
    expect(await readlink(join(fixture.installRoot, "current")))
      .toBe("versions/1.2.4");
  });

  test("a release without a signature is refused before installation", async () => {
    const fixture = await createInstallerFixture("1.2.3", false);
    const installed = await runInstaller(fixture, "1.2.3");

    expect(installed.exitCode).toBe(1);
    expect(installed.stderr).toContain("release has no Hive manifest signature");
    expect(
      await Bun.file(join(fixture.installRoot, "versions", "1.2.3")).exists(),
    ).toBe(false);
  });

  test("a release with an empty signature is refused before installation", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    await writeFile(join(fixture.fixtures, "hive-release.json.sig"), "\n");

    const installed = await runInstaller(fixture, "1.2.3");

    expect(installed.exitCode).toBe(1);
    expect(installed.stderr).toContain("release manifest signature is empty");
    expect(
      await Bun.file(join(fixture.installRoot, "versions", "1.2.3")).exists(),
    ).toBe(false);
  });

  test("a replacement that fails validation cannot erase the active release", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-installer-"));
    roots.push(root);
    const installRoot = join(root, "install");
    const binDir = join(root, "bin");
    const versionDir = join(installRoot, "versions", "1.2.3");
    const fixtures = join(root, "fixtures");
    const fakeBin = join(root, "fake-bin");
    await mkdir(join(versionDir, "HiveWorkspace.app"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(fixtures, { recursive: true });
    await mkdir(fakeBin, { recursive: true });

    const workingBinary = join(versionDir, "hive");
    await writeFile(workingBinary, "#!/bin/sh\necho 'hive 1.2.3'\n");
    await chmod(workingBinary, 0o755);
    await writeFile(join(versionDir, "HiveWorkspace.app", "known-good"), "kept\n");
    await symlink("versions/1.2.3", join(installRoot, "current"));
    await symlink(join(installRoot, "current", "hive"), join(binDir, "hive"));

    const badBinary = new TextEncoder().encode("#!/bin/sh\necho 'hive 9.9.9'\n");
    const sessiondBytes = new TextEncoder().encode("#!/bin/sh\necho sessiond\n");
    await writeFile(join(fixtures, "hive-darwin-arm64"), badBinary);
    await writeFile(join(fixtures, "hive-sessiond-darwin-arm64"), sessiondBytes);
    const workspaceRoot = join(root, "workspace-archive");
    await mkdir(join(workspaceRoot, "HiveWorkspace.app"), { recursive: true });
    await writeFile(join(workspaceRoot, "HiveWorkspace.app", "replacement"), "new\n");
    const tar = Bun.spawn([
      "tar", "-czf", join(fixtures, "HiveWorkspace.tar.gz"),
      "-C", workspaceRoot, "HiveWorkspace.app",
    ]);
    expect(await tar.exited).toBe(0);
    const workspaceBytes = new Uint8Array(
      await Bun.file(join(fixtures, "HiveWorkspace.tar.gz")).arrayBuffer(),
    );
    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      artifacts: [
        {
          name: "hive-darwin-arm64",
          sha256: sha256(badBinary),
        },
        {
          name: "hive-sessiond-darwin-arm64",
          sha256: sha256(sessiondBytes),
        },
        {
          name: "HiveWorkspace.tar.gz",
          sha256: sha256(workspaceBytes),
        },
      ],
    }));
    await writeFile(join(fixtures, "hive-release.json"), manifestBytes);
    await writeFile(
      join(fixtures, "hive-release.json.sig"),
      `${RELEASE_KEY.sign(manifestBytes)}\n`,
    );
    await writeFile(join(fixtures, "release.json"), '{"tag_name":"v1.2.3"}\n');

    const curl = join(fakeBin, "curl");
    await writeFile(
      curl,
      `#!/bin/sh
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  cp "$HIVE_INSTALL_FIXTURES/\${url##*/}" "$out"
else
  cat "$HIVE_INSTALL_FIXTURES/release.json"
fi
`,
    );
    await chmod(curl, 0o755);

    const install = Bun.spawn(["sh", join(repoRoot, "install.sh"), "1.2.3"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HIVE_INSTALL_FIXTURES: fixtures,
        HIVE_INSTALL_ROOT: installRoot,
        HIVE_BIN_DIR: binDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(install.stderr).text(),
      install.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("expected 1.2.3");
    expect(await readlink(join(installRoot, "current"))).toBe("versions/1.2.3");
    expect(await Bun.file(join(versionDir, "HiveWorkspace.app", "known-good")).text())
      .toBe("kept\n");
    expect(await Bun.$`${workingBinary} --version`.text()).toBe("hive 1.2.3\n");
  });
});
