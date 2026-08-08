import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { errorMessage } from "../../src/shared/error-message";

export interface BinaryIdentity {
  version: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
}

interface TreeNode {
  path: string;
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  device: number;
  inode: number;
  mode: number;
  size: number;
  mtimeMs: number;
}

export interface TreeMetadataNode {
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  device: number;
  inode: number;
  mode: number;
  size: number;
  mtimeMs: number;
}

export async function binaryIdentity(binary: string): Promise<BinaryIdentity> {
  const stat = await lstat(binary);
  if (!stat.isFile())
    throw new Error(`binary is not a regular file: ${binary}`);
  const child = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${binary} --version failed: ${(stderr || stdout).trim()}`);
  }
  return {
    version: stdout.trim(),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function assertIdentityUnchanged(
  before: BinaryIdentity,
  after: BinaryIdentity,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("VERSION_DRIFT");
  }
}

async function walk(root: string, allowSymlinks = false): Promise<TreeNode[]> {
  const rootStat = await lstat(root);
  const nodes: TreeNode[] = [];

  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    const relativePath = relative(root, path) || ".";
    if (
      (!allowSymlinks && stat.isSymbolicLink()) ||
      (!stat.isSymbolicLink() && !stat.isFile() && !stat.isDirectory())
    ) {
      throw new Error(
        `credential tree contains a non-regular node: ${relativePath}`,
      );
    }
    nodes.push({
      path,
      relativePath,
      kind: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : "file",
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of (await readdir(path)).sort())
      await visit(join(path, name));
  }

  if (
    (!allowSymlinks && rootStat.isSymbolicLink()) ||
    (!rootStat.isSymbolicLink() &&
      !rootStat.isFile() &&
      !rootStat.isDirectory())
  ) {
    throw new Error(
      `credential root is not a regular file or directory: ${root}`,
    );
  }
  await visit(root);
  return nodes;
}

export async function copyDetachedTree(
  source: string,
  destination: string,
): Promise<void> {
  const nodes = await walk(source);
  await rm(destination, { force: true, recursive: true });
  for (const node of nodes) {
    const target =
      node.relativePath === "."
        ? destination
        : join(destination, node.relativePath);
    if (node.kind === "directory") {
      await mkdir(target, { recursive: true, mode: 0o700 });
    } else if (node.kind === "file") {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(node.path, target);
      await chmod(target, node.mode & 0o444);
    } else {
      throw new Error(
        `credential tree contains a symlink: ${node.relativePath}`,
      );
    }
  }
  for (const node of nodes.toReversed()) {
    if (node.kind !== "directory") continue;
    const target =
      node.relativePath === "."
        ? destination
        : join(destination, node.relativePath);
    await chmod(target, node.mode & 0o555);
  }
  await verifyDetachedTree(source, destination);
}

export async function verifyDetachedTree(
  source: string,
  destination: string,
): Promise<{ nodes: number; files: number; directories: number }> {
  const [sourceNodes, destinationNodes] = await Promise.all([
    walk(source),
    walk(destination),
  ]);
  const byRelativePath = new Map(
    destinationNodes.map((node) => [node.relativePath, node]),
  );
  if (sourceNodes.length !== destinationNodes.length) {
    throw new Error("detached credential tree node count differs");
  }
  for (const sourceNode of sourceNodes) {
    const destinationNode = byRelativePath.get(sourceNode.relativePath);
    if (!destinationNode || destinationNode.kind !== sourceNode.kind) {
      throw new Error(
        `detached credential node differs: ${sourceNode.relativePath}`,
      );
    }
    if (
      destinationNode.device === sourceNode.device &&
      destinationNode.inode === sourceNode.inode
    ) {
      throw new Error(
        `detached credential node shares an inode: ${sourceNode.relativePath}`,
      );
    }
    if ((destinationNode.mode & 0o222) !== 0) {
      throw new Error(
        `detached credential node is writable: ${sourceNode.relativePath}`,
      );
    }
    if (
      destinationNode.kind === "directory" &&
      (destinationNode.mode & 0o111) === 0
    ) {
      throw new Error(
        `detached credential directory is not traversable: ${sourceNode.relativePath}`,
      );
    }
  }
  return {
    nodes: destinationNodes.length,
    files: destinationNodes.filter((node) => node.kind === "file").length,
    directories: destinationNodes.filter((node) => node.kind === "directory")
      .length,
  };
}

export async function detachedTreeEvidence(
  source: string,
  destination: string,
): Promise<
  | {
      verification: { nodes: number; files: number; directories: number };
      error: null;
    }
  | { verification: null; error: string }
> {
  try {
    return {
      verification: await verifyDetachedTree(source, destination),
      error: null,
    };
  } catch (error) {
    return {
      verification: null,
      error: errorMessage(error),
    };
  }
}

export async function makeDetachedTreeRemovable(path: string): Promise<void> {
  const nodes = await walk(path);
  for (const node of nodes) {
    if (node.kind === "directory") await chmod(node.path, 0o700);
  }
}

export async function metadataDigest(path: string): Promise<string> {
  const nodes = await walk(path);
  const metadata = nodes.map(
    ({ relativePath, kind, device, inode, mode, size, mtimeMs }) => ({
      relativePath,
      kind,
      device,
      inode,
      mode,
      size,
      mtimeMs,
    }),
  );
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

export async function baselineMetadata(
  path: string,
): Promise<{ digest: string; nodes: TreeMetadataNode[] }> {
  const nodes = (await walk(path, true)).map(
    ({ relativePath, kind, device, inode, mode, size, mtimeMs }) => ({
      relativePath,
      kind,
      device,
      inode,
      mode,
      size,
      mtimeMs,
    }),
  );
  return {
    digest: createHash("sha256").update(JSON.stringify(nodes)).digest("hex"),
    nodes,
  };
}

export function artifactLabel(path: string): string {
  return basename(path);
}
