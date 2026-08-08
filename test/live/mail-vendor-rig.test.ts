import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIdentityUnchanged,
  copyDetachedTree,
  detachedTreeEvidence,
  makeDetachedTreeRemovable,
  metadataDigest,
  verifyDetachedTree,
} from "./mail-vendor-rig";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) {
    // The rig strips write bits on copies; a root whose copy was refused (the
    // symlink control) needs no chmod and its walk refuses the symlink.
    await makeDetachedTreeRemovable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("mail vendor rig controls", () => {
  test("copies a credential tree without links, shared inodes, or write bits", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-credential-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(join(source, "nested"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, "auth.json"), "fixture", { mode: 0o600 });
    await writeFile(join(source, "nested", "token"), "fixture", {
      mode: 0o600,
    });

    await copyDetachedTree(source, destination);
    expect(await verifyDetachedTree(source, destination)).toEqual({
      nodes: 4,
      files: 2,
      directories: 2,
    });
  });

  test("refuses a symlink anywhere in a credential tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-symlink-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true, mode: 0o700 });
    await symlink("/dev/null", join(source, "token"));
    await expect(copyDetachedTree(source, join(root, "copy"))).rejects.toThrow(
      "non-regular node",
    );
  });

  test("detects a hardlink introduced after copying", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-hardlink-"));
    roots.push(root);
    const source = join(root, "auth.json");
    const destination = join(root, "copy.json");
    await writeFile(source, "fixture", { mode: 0o600 });
    await link(source, destination);
    await chmod(destination, 0o400);
    await expect(verifyDetachedTree(source, destination)).rejects.toThrow(
      "shares an inode",
    );
  });

  test("retains the writable-copy error as evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-writable-"));
    roots.push(root);
    const source = join(root, "auth.json");
    const destination = join(root, "copy.json");
    await writeFile(source, "fixture", { mode: 0o600 });
    await copyDetachedTree(source, destination);
    await chmod(destination, 0o600);
    expect(await detachedTreeEvidence(source, destination)).toEqual({
      verification: null,
      error: "detached credential node is writable: .",
    });
  });

  test("detects a destination with fewer nodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-node-count-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source, { mode: 0o700 });
    await mkdir(destination, { mode: 0o500 });
    await writeFile(join(source, "auth.json"), "fixture", { mode: 0o600 });
    await expect(verifyDetachedTree(source, destination)).rejects.toThrow(
      "node count differs",
    );
  });

  test("detects a non-traversable copied directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-traversal-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source, { mode: 0o700 });
    await copyDetachedTree(source, destination);
    await chmod(destination, 0o400);
    await expect(verifyDetachedTree(source, destination)).rejects.toThrow(
      "not traversable",
    );
  });

  test("the drift guard fails when identity changes", () => {
    const before = {
      version: "1",
      device: 1,
      inode: 2,
      size: 3,
      mtimeMs: 4,
    };
    expect(() => assertIdentityUnchanged(before, before)).not.toThrow();
    expect(() =>
      assertIdentityUnchanged(before, { ...before, size: before.size + 1 }),
    ).toThrow("VERSION_DRIFT");
  });

  test("the metadata guard moves when a borrowed tree changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-vendor-metadata-"));
    roots.push(root);
    const source = join(root, "auth.json");
    await writeFile(source, "fixture", { mode: 0o600 });
    const before = await metadataDigest(source);
    await chmod(source, 0o400);
    expect(await metadataDigest(source)).not.toBe(before);
  });
});
