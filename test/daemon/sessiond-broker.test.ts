import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectUnixSocket,
  readLocalPeerPid,
  resolveSessiondBinary,
  socketFileDescriptor,
} from "../../src/daemon/session-host/sessiond-broker";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fakeBinary(dir: string, name = "hive-sessiond"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("resolveSessiondBinary", () => {
  test("prefers HIVE_SESSIOND_BIN over other locations", () => {
    const dir = tempDir("hive-sessiond-resolve-");
    const override = fakeBinary(dir, "override-sessiond");
    const siblingDir = tempDir("hive-sessiond-sibling-");
    fakeBinary(siblingDir, "hive-sessiond");
    expect(
      resolveSessiondBinary({
        env: { HIVE_SESSIOND_BIN: override },
        execPath: join(siblingDir, "hive"),
        repoRoot: dir,
        isReleaseBuild: false,
      }),
    ).toBe(override);
  });

  test("finds a sibling of the release CLI", () => {
    const dir = tempDir("hive-sessiond-sibling-");
    const binary = fakeBinary(dir, "hive-sessiond");
    expect(
      resolveSessiondBinary({
        env: {},
        execPath: join(dir, "hive"),
        isReleaseBuild: true,
        repoRoot: tempDir("hive-sessiond-empty-"),
      }),
    ).toBe(binary);
  });

  test("finds the staged install layout", () => {
    const root = tempDir("hive-sessiond-install-");
    const versionDir = join(root, "versions", "0.0.0");
    mkdirSync(versionDir, { recursive: true });
    const binary = fakeBinary(versionDir, "hive-sessiond");
    const current = join(root, "current");
    symlinkSync(versionDir, current);
    expect(
      resolveSessiondBinary({
        env: {},
        execPath: join(root, "other", "hive"),
        installRoot: root,
        isReleaseBuild: true,
        repoRoot: tempDir("hive-sessiond-empty-"),
      }),
    ).toBe(join(current, "hive-sessiond"));
    expect(binary).toBe(join(versionDir, "hive-sessiond"));
  });
});

describe("LOCAL_PEERPID measurement", () => {
  test("kernel peer pid equals the process bound to a unix socket", async () => {
    const dir = tempDir("hive-peerpid-");
    const path = join(dir, "s.sock");
    const server = createServer(() => {
      // hold connection open
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    try {
      const client = await connectUnixSocket(path);
      try {
        const peer = readLocalPeerPid(socketFileDescriptor(client));
        expect(peer).toBe(process.pid);
      } finally {
        client.destroy();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
