/**
 * The versioning contract, enforced by CI rather than by anyone remembering it.
 *
 * Every rule in docs/versioning-and-release.md that a human could break with a
 * plausible edit is asserted here. These tests run in the same `bun test` step
 * the release workflow gates on, so breaking the contract fails the release
 * instead of shipping a wrong version.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("the version has exactly one source", () => {
  test("package.json carries the unreleased dev base, not a release version", () => {
    // Releases are git tags. A version committed to package.json is a second
    // source of truth that drifts the moment someone forgets to bump it.
    expect(JSON.parse(read("package.json")).version).toEqual("0.0.0");
  });

  test("src/version.ts falls back to a dev version, never a release one", () => {
    expect(read("src/version.ts")).toContain('"0.0.0-dev"');
  });

  test("no module outside src/version.ts declares its own version constant", () => {
    const offenders = sourceFiles(join(repoRoot, "src"))
      .filter((file) => !file.endsWith("src/version.ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => /\bHIVE_VERSION\s*=\s*["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  test("no module hardcodes a semver where the version belongs", () => {
    // The four copies of "0.1.0" that used to drift: MCP clientInfo, the
    // channel bridge's serverInfo, the Codex app-server handshake, the daemon.
    const offenders = sourceFiles(join(repoRoot, "src"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => /version:\s*["']\d+\.\d+\.\d+["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});

describe("the release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  test("exists and triggers on a push to main", () => {
    expect(workflow).toContain("branches: [main]");
  });

  test("serializes so two pushes cannot race for one version", () => {
    expect(workflow).toContain("group: hive-release");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  test("raises GITHUB_TOKEN to contents: write for the tag push", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*write/);
  });

  test("fetches tags, because the bump is a function of them", () => {
    expect(workflow).toContain("fetch-tags: true");
    expect(workflow).toContain("fetch-depth: 0");
  });

  test("calls the tested planner rather than reimplementing the bump in shell", () => {
    expect(workflow).toContain("src/release/plan-cli.ts");
    expect(workflow).not.toMatch(/git tag[^\n]*sort[^\n]*tail/);
  });

  test("builds before it tags, so a failed build never burns a version", () => {
    const build = workflow.indexOf("Build release artifacts");
    const tag = workflow.indexOf("Publish the tag");
    expect(build).toBeGreaterThan(0);
    expect(tag).toBeGreaterThan(build);
  });

  test("gates typecheck and tests ahead of any release step", () => {
    const tests = workflow.indexOf("bun test");
    expect(tests).toBeGreaterThan(0);
    expect(workflow.indexOf("Plan the release")).toBeGreaterThan(tests);
  });

  test("pins the same Bun the project pins", () => {
    // The release binary embeds this Bun's runtime; a floating version would
    // silently change what every user runs.
    const pinned = /bun-version:\s*"([^"]+)"/.exec(workflow)?.[1];
    const declared = JSON.parse(read("package.json")).packageManager;
    expect(declared).toEqual(`bun@${pinned}`);
  });
});

describe("the installer", () => {
  const installer = read("install.sh");

  test("verifies a digest before it ever runs the binary", () => {
    expect(installer.indexOf("verify ")).toBeLessThan(installer.indexOf("--version"));
  });

  test("activates through a verified macOS no-follow rename", () => {
    const platformGuard = installer.indexOf('"$(uname -s)" = "Darwin"');
    const rename = installer.indexOf('/bin/mv -fh "$temporary" "$link"');
    const activation = installer.indexOf('replace_symlink "versions/$RESOLVED" "$ROOT/current"');
    expect(platformGuard).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(platformGuard);
    expect(installer).toContain('[ "$actual" = "$target" ] ||');
    expect(installer).toContain('[ "$active_dir" = "$intended_dir" ] ||');
  });

  test("plain macOS mv follows a current directory symlink and silently misses activation", () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "hive-install-follow-"));
    try {
      mkdirSync(join(root, "versions", "old"), { recursive: true });
      mkdirSync(join(root, "versions", "new"), { recursive: true });
      symlinkSync(join("versions", "old"), join(root, "current"));
      symlinkSync(join("versions", "new"), join(root, "current.tmp"));

      const moved = spawnSync("/bin/mv", ["-f", join(root, "current.tmp"), join(root, "current")]);

      expect(moved.status).toEqual(0);
      expect(readlinkSync(join(root, "current"))).toEqual(join("versions", "old"));
      expect(readlinkSync(join(root, "versions", "old", "current.tmp")))
        .toEqual(join("versions", "new"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("macOS no-follow mv atomically replaces a current directory symlink", () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "hive-install-nofollow-"));
    try {
      mkdirSync(join(root, "versions", "old"), { recursive: true });
      mkdirSync(join(root, "versions", "new"), { recursive: true });
      symlinkSync(join("versions", "old"), join(root, "current"));
      symlinkSync(join("versions", "new"), join(root, "current.tmp"));

      const moved = spawnSync("/bin/mv", ["-fh", join(root, "current.tmp"), join(root, "current")]);

      expect(moved.status).toEqual(0);
      expect(readlinkSync(join(root, "current"))).toEqual(join("versions", "new"));
      expect(existsSync(join(root, "versions", "old", "current.tmp"))).toEqual(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is executable", () => {
    expect(statSync(join(repoRoot, "install.sh")).mode & 0o111).toBeGreaterThan(0);
  });
});
