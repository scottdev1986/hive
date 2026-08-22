import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
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
import type { ReleaseManifest } from "../../src/release/manifest";
import {
  activateWithHealthCheck,
  rollback,
  stageRelease,
} from "../../src/update-service/install";

const repoRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

/** Owner-path installs do not carry an agent credential. extraEnv can put one back. */
function ownerEnv(extra: Record<string, string | undefined>) {
  const env = { ...process.env, ...extra } satisfies Record<
    string,
    string | undefined
  >;
  if (extra.HIVE_CAPABILITY_TOKEN === undefined) {
    delete env.HIVE_CAPABILITY_TOKEN;
  }
  return env;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const RELEASE_KEY = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    sign: (bytes: Uint8Array) =>
      sign(null, bytes, privateKey).toString("base64"),
  };
})();

interface InstallerFixture {
  root: string;
  installRoot: string;
  binDir: string;
  fakeBin: string;
  fixtures: string;
  workspaceBytes: Uint8Array;
  terminfoBytes: Uint8Array;
}

async function writeTerminfoTarball(path: string): Promise<Uint8Array> {
  const tree = join(path, "..", "terminfo-tree");
  await mkdir(join(tree, "resources", "terminfo", "x"), { recursive: true });
  await writeFile(
    join(tree, "resources", "terminfo", "x", "xterm-ghostty"),
    "xterm-ghostty\n",
  );
  const tar = Bun.spawn([
    "tar",
    "-czf",
    path,
    "-C",
    tree,
    "resources/terminfo",
  ]);
  expect(await tar.exited).toBe(0);
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function manifestFor(
  version: string,
  cliBytes: Uint8Array,
  workspaceBytes: Uint8Array,
  sessiondBytes: Uint8Array = new TextEncoder().encode(
    "#!/bin/sh\necho sessiond\n",
  ),
  terminfoBytes: Uint8Array = new Uint8Array(),
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
      {
        name: "hive-terminfo.tar.gz",
        kind: "terminfo",
        platform: "darwin",
        arch: "arm64",
        size: terminfoBytes.byteLength,
        sha256: sha256(terminfoBytes),
        buildHash: `terminfo-hash-${version}`,
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
  await writeFile(
    join(workspaceRoot, "HiveWorkspace.app", "fixture"),
    "workspace\n",
  );

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
  const terminfoBytes = await writeTerminfoTarball(
    join(fixtures, "hive-terminfo.tar.gz"),
  );

  const manifest = manifestFor(
    version,
    cliBytes,
    workspaceBytes,
    sessiondBytes,
    terminfoBytes,
  );
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
  return {
    root,
    installRoot,
    binDir,
    fakeBin,
    fixtures,
    workspaceBytes,
    terminfoBytes,
  };
}

async function runInstaller(
  fixture: InstallerFixture,
  version: string,
  args: string[] = [],
  options: {
    cwd?: string;
    script?: string;
    extraEnv?: Record<string, string>;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ["sh", options.script ?? join(repoRoot, "install.sh"), ...args, version],
    {
      // Fixture root is not an agent worktree. The installer refuses those, so
      // a checkout under .hive/worktrees/ cannot be the cwd of a successful run.
      cwd: options.cwd ?? fixture.root,
      env: ownerEnv({
        PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
        HIVE_INSTALL_FIXTURES: fixture.fixtures,
        HIVE_INSTALL_ROOT: fixture.installRoot,
        HIVE_BIN_DIR: fixture.binDir,
        ...options.extraEnv,
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function stageLocalBuild(
  fixture: InstallerFixture,
  version: string,
): Promise<string> {
  const build = join(fixture.root, "build");
  await mkdir(build);
  for (const name of ["hive-darwin-arm64", "hive-sessiond-darwin-arm64"]) {
    await Bun.write(
      join(build, name),
      name.startsWith("hive-darwin-")
        ? `#!/bin/sh\nif [ "$1" = --version ]; then echo 'hive ${version}'; fi\n`
        : "#!/bin/sh\n",
    );
    await chmod(join(build, name), 0o755);
  }
  await Bun.write(
    join(build, "HiveWorkspace.tar.gz"),
    Bun.file(join(fixture.fixtures, "HiveWorkspace.tar.gz")),
  );
  await Bun.write(
    join(build, "hive-terminfo.tar.gz"),
    Bun.file(join(fixture.fixtures, "hive-terminfo.tar.gz")),
  );
  return build;
}

async function assertProdCommandsAbsent(binDir: string): Promise<void> {
  for (const command of ["hive-dev", "hive-qa"]) {
    const probe = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `if command -v ${command} >/dev/null; then echo '${command} is reachable' >&2; exit 1; fi`,
      ],
      {
        env: { PATH: binDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim());
  }
}

async function selfUpdate(
  fixture: InstallerFixture,
  version: string,
): Promise<void> {
  const cliBytes = new TextEncoder().encode(
    `#!/bin/sh\necho 'hive ${version}'\n`,
  );
  const sessiondBytes = new TextEncoder().encode("#!/bin/sh\necho sessiond\n");
  const manifest = manifestFor(
    version,
    cliBytes,
    fixture.workspaceBytes,
    sessiondBytes,
    fixture.terminfoBytes,
  );
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
      if (name === "hive-terminfo.tar.gz") return fixture.terminfoBytes;
      if (name !== "hive-darwin-arm64")
        throw new Error(`unexpected asset ${name}`);
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
  test("the same installer gives dev and qa distinct roots and command names", async () => {
    for (const variant of ["dev", "qa"] as const) {
      const fixture = await createInstallerFixture("1.2.3");
      const build = await stageLocalBuild(fixture, "1.2.3");
      const binLink = join(fixture.binDir, `hive-${variant}`);
      const installed = await runInstaller(fixture, "1.2.3", [
        "--variant",
        variant,
        "--from-build",
        build,
      ]);
      expect(installed.exitCode).toBe(0);
      expect(await readlink(binLink)).toBe(
        join(fixture.installRoot, "current", "hive"),
      );
      expect(installed.stdout).toContain(`unverified local ${variant} build`);
    }
  });

  test("a prod install exposes no dev or qa command", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const installed = await runInstaller(fixture, "1.2.3");
    expect(installed.exitCode).toBe(0);
    expect(await Bun.file(join(fixture.binDir, "hive")).exists()).toBe(true);
    await assertProdCommandsAbsent(fixture.binDir);

    await symlink(
      join(fixture.binDir, "hive"),
      join(fixture.binDir, "hive-dev"),
    );
    await expect(assertProdCommandsAbsent(fixture.binDir)).rejects.toThrow(
      "hive-dev is reachable",
    );
    await rm(join(fixture.binDir, "hive-dev"));
    await assertProdCommandsAbsent(fixture.binDir);
  });

  test("first install lands terminfo next to hive-sessiond", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const installed = await runInstaller(fixture, "1.2.3");
    expect(installed.exitCode).toBe(0);
    expect(
      existsSync(
        join(
          fixture.installRoot,
          "versions",
          "1.2.3",
          "resources",
          "terminfo",
          "x",
          "xterm-ghostty",
        ),
      ),
    ).toBe(true);
  });

  test("a local build without hive-terminfo.tar.gz is refused", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const build = await stageLocalBuild(fixture, "1.2.3");
    await rm(join(build, "hive-terminfo.tar.gz"));
    const installed = await runInstaller(fixture, "1.2.3", [
      "--variant",
      "dev",
      "--from-build",
      build,
    ]);
    expect(installed.exitCode).not.toBe(0);
    expect(installed.stderr).toContain("hive-terminfo.tar.gz");
  });

  test("local prod builds and non-qa refs are refused", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const build = await stageLocalBuild(fixture, "1.2.3");
    expect(
      (await runInstaller(fixture, "1.2.3", ["--from-build", build])).exitCode,
    ).not.toBe(0);
    expect(
      (
        await runInstaller(fixture, "1.2.3", [
          "--variant",
          "dev",
          "--ref",
          "topic",
        ])
      ).exitCode,
    ).not.toBe(0);
  });
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
    expect(await readlink(join(fixture.installRoot, "current"))).toBe(
      "versions/1.2.3",
    );
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

    await expect(
      rollback({
        root: fixture.installRoot,
        arch: "arm64",
        publicKey: RELEASE_KEY.publicKey,
        healthCheck: async () => true,
      }),
    ).rejects.toThrow(/does not match its signed release manifest/);
    expect(await readlink(join(fixture.installRoot, "current"))).toBe(
      "versions/1.2.4",
    );
  });

  test("a release without a signature is refused before installation", async () => {
    const fixture = await createInstallerFixture("1.2.3", false);
    const installed = await runInstaller(fixture, "1.2.3");

    expect(installed.exitCode).toBe(1);
    expect(installed.stderr).toContain(
      "release has no Hive manifest signature",
    );
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
    await writeFile(
      join(versionDir, "HiveWorkspace.app", "known-good"),
      "kept\n",
    );
    await symlink("versions/1.2.3", join(installRoot, "current"));
    await symlink(join(installRoot, "current", "hive"), join(binDir, "hive"));

    const badBinary = new TextEncoder().encode(
      "#!/bin/sh\necho 'hive 9.9.9'\n",
    );
    const sessiondBytes = new TextEncoder().encode(
      "#!/bin/sh\necho sessiond\n",
    );
    await writeFile(join(fixtures, "hive-darwin-arm64"), badBinary);
    await writeFile(
      join(fixtures, "hive-sessiond-darwin-arm64"),
      sessiondBytes,
    );
    const terminfoBytes = await writeTerminfoTarball(
      join(fixtures, "hive-terminfo.tar.gz"),
    );
    const workspaceRoot = join(root, "workspace-archive");
    await mkdir(join(workspaceRoot, "HiveWorkspace.app"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "HiveWorkspace.app", "replacement"),
      "new\n",
    );
    const tar = Bun.spawn([
      "tar",
      "-czf",
      join(fixtures, "HiveWorkspace.tar.gz"),
      "-C",
      workspaceRoot,
      "HiveWorkspace.app",
    ]);
    expect(await tar.exited).toBe(0);
    const workspaceBytes = new Uint8Array(
      await Bun.file(join(fixtures, "HiveWorkspace.tar.gz")).arrayBuffer(),
    );
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
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
          {
            name: "hive-terminfo.tar.gz",
            sha256: sha256(terminfoBytes),
          },
        ],
      }),
    );
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
      cwd: root,
      env: ownerEnv({
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HIVE_INSTALL_FIXTURES: fixtures,
        HIVE_INSTALL_ROOT: installRoot,
        HIVE_BIN_DIR: binDir,
      }),
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
    expect(
      await Bun.file(
        join(versionDir, "HiveWorkspace.app", "known-good"),
      ).text(),
    ).toBe("kept\n");
    expect(await Bun.$`${workingBinary} --version`.text()).toBe("hive 1.2.3\n");
  });

  test("the owner path still installs when cwd is not a worktree", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const build = await stageLocalBuild(fixture, "1.2.3");
    const installed = await runInstaller(
      fixture,
      "1.2.3",
      ["--variant", "dev", "--from-build", build],
      { extraEnv: { HIVE_BIN_LINK: join(fixture.binDir, "hive-dev") } },
    );
    expect(installed.exitCode).toBe(0);
    expect(await readlink(join(fixture.binDir, "hive-dev"))).toBe(
      join(fixture.installRoot, "current", "hive"),
    );
  });

  test("an agent-shaped caller installs to its scratch target", async () => {
    const fixture = await createInstallerFixture("1.2.3");
    const build = await stageLocalBuild(fixture, "1.2.3");
    const worktree = join(fixture.root, ".hive", "worktrees", "elton");
    await mkdir(worktree, { recursive: true });

    const installed = await runInstaller(
      fixture,
      "1.2.3",
      ["--variant", "dev", "--from-build", build],
      {
        cwd: worktree,
        extraEnv: {
          HIVE_BIN_LINK: join(fixture.binDir, "hive-dev"),
          HIVE_CAPABILITY_TOKEN: "test-agent-capability",
        },
      },
    );

    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toBe("");
    expect(existsSync(join(fixture.installRoot, "versions", "1.2.3"))).toBe(
      true,
    );
    expect(await readlink(join(fixture.binDir, "hive-dev"))).toBe(
      join(fixture.installRoot, "current", "hive"),
    );
  });
});
