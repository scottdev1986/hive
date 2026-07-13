import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const repoRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("the standalone installer", () => {
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
    await writeFile(join(fixtures, "hive-darwin-arm64"), badBinary);
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
    await writeFile(
      join(fixtures, "hive-release.json"),
      JSON.stringify({
        artifacts: [
          {
            name: "hive-darwin-arm64",
            sha256: sha256(badBinary),
          },
          {
            name: "HiveWorkspace.tar.gz",
            sha256: sha256(workspaceBytes),
          },
        ],
      }),
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
