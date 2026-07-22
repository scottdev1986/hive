import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("make build propagates a compile failure and removes the previous artifact", () => {
  const fixture = mkdtempSync(join(tmpdir(), "hive-make-build-failure-"));
  const binDir = join(fixture, "bin");
  const artifact = join(fixture, "staged", "hive");
  const toolchainStamp = join(fixture, "toolchain.stamp");
  const ghosttyArtifact = join(fixture, "ghostty-artifact");
  const ghosttyStamp = join(ghosttyArtifact, "lock.stamp");
  const ghosttyInfo = join(fixture, "GhosttyKit.xcframework", "Info.plist");
  const sessiondRelease = join(fixture, "sessiond-release", "hive-sessiond");
  const sessiond = join(fixture, "sessiond", "hive-sessiond");
  try {
    for (const path of [
      binDir,
      join(artifact, ".."),
      ghosttyArtifact,
      join(ghosttyInfo, ".."),
      join(sessiondRelease, ".."),
      join(sessiond, ".."),
    ]) mkdirSync(path, { recursive: true });

    const fakeBun = join(binDir, "bun");
    writeFileSync(fakeBun, [
      "#!/bin/sh",
      '[ "$1" = "install" ] && exit 0',
      'echo "synthetic compile failure" >&2',
      "exit 23",
      "",
    ].join("\n"));
    chmodSync(fakeBun, 0o755);
    writeFileSync(artifact, "previous executable\n");
    chmodSync(artifact, 0o755);
    for (const path of [toolchainStamp, ghosttyStamp, ghosttyInfo]) {
      writeFileSync(path, "fixture\n");
    }
    writeFileSync(sessiondRelease, "sessiond\n");
    writeFileSync(sessiond, "sessiond\n");

    const future = new Date("2030-01-01T00:00:00Z");
    for (const path of [
      toolchainStamp,
      ghosttyStamp,
      ghosttyInfo,
      sessiondRelease,
      sessiond,
    ]) utimesSync(path, future, future);

    const result = Bun.spawnSync([
      "make",
      "build",
      `HIVE_BIN=${artifact}`,
      `DIST=${join(fixture, "dist")}`,
      `INSTALL_ROOT=${join(fixture, "install")}`,
      `TOOLCHAIN_STAMP=${toolchainStamp}`,
      `GHOSTTY_ARTIFACT=${ghosttyArtifact}`,
      `GHOSTTY_ARTIFACT_STAMP=${ghosttyStamp}`,
      `GHOSTTYKIT=${join(fixture, "GhosttyKit.xcframework")}`,
      `GHOSTTYKIT_INFO=${ghosttyInfo}`,
      `SESSIOND_RELEASE_BIN=${sessiondRelease}`,
      `SESSIOND_BIN=${sessiond}`,
    ], {
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("synthetic compile failure");
    expect(output).not.toContain("staged:");
    expect(existsSync(artifact)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("make run surfaces an immediately exiting daemon's lock failure", () => {
  const fixture = mkdtempSync(join(tmpdir(), "hive-make-run-lock-"));
  const binary = join(fixture, "hive");
  const project = join(fixture, "project");
  const dev = join(fixture, "dev");
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(binary, [
      "#!/bin/sh",
      'if [ "$1" = "init" ]; then exit 0; fi',
      'if [ "$1" = "daemon" ]; then',
      '  echo "hive: Could not acquire Hive daemon lock at /tmp/planted.lock" >&2',
      "  exit 1",
      "fi",
      "exit 99",
      "",
    ].join("\n"));
    chmodSync(binary, 0o755);

    const startedAt = Date.now();
    const result = Bun.spawnSync([
      "make",
      "run",
      `HIVE_BIN=${binary}`,
      `PROJECT=${project}`,
      `DEV=${dev}`,
      `DEV_HOME=${join(fixture, "home")}`,
      `INSTALL_ROOT=${join(fixture, "root")}`,
      `DAEMON_STARTUP_LOG=${join(dev, "daemon-startup.log")}`,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("Could not acquire Hive daemon lock at /tmp/planted.lock");
    expect(output).not.toContain("did not observe the daemon startup announcement");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
