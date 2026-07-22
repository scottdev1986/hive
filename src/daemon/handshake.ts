import { createHash } from "node:crypto";
import { resolveHandshakeProject } from "./project-identity";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { HIVE_BUILD_HASH, HIVE_VERSION } from "../version";
import { hiveInstanceSuffix } from "./tmux-sessions";

/**
 * This is intentionally separate from product version. A wire change must not
 * silently attach a newer launcher to an older daemon with the same release
 * label.
 */
export const DAEMON_WIRE_PROTOCOL = { min: 1, max: 1 } as const;
export const DAEMON_SCHEMA_EPOCH = 1;
export const DAEMON_GENERATION = 1;
export const DAEMON_CAPABILITIES = ["daemon-handshake-v1"] as const;

export interface DaemonHandshake {
  productVersion: string;
  buildHash: string;
  wireProtocol: { min: number; max: number };
  schemaEpoch: number;
  capabilities: readonly string[];
  instanceId: string;
  hiveUuid: string;
  identityKey: string;
  repoFamilyKey: string | null;
  generation: number;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

export async function sourceBuildHash(sourceRoot: string): Promise<string> {
  const files = (await sourceFiles(sourceRoot)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(sourceRoot, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Content address the executable, rather than its marketing version.
 *
 * A release binary carries its hash inlined at compile time: there is no source
 * tree inside the compiled artifact to walk, and a build-time constant is the
 * only value a peer cannot influence. A source checkout hashes the tree it is
 * actually executing, which is what makes an edit-and-rerun cycle reject the
 * daemon still running the pre-edit code.
 */
export async function currentBuildHash(): Promise<string> {
  if (HIVE_BUILD_HASH !== null) return HIVE_BUILD_HASH;
  return sourceBuildHash(resolveSourceRoot());
}

function resolveSourceRoot(): string {
  // Both the source checkout and a packaged build retain this module beneath
  // `src/daemon`; resolving from import.meta.dir avoids the caller's cwd.
  return join(import.meta.dir, "..");
}

export async function expectedDaemonHandshake(
  projectRoot: string,
): Promise<DaemonHandshake> {
  return {
    productVersion: HIVE_VERSION,
    buildHash: await currentBuildHash(),
    wireProtocol: DAEMON_WIRE_PROTOCOL,
    schemaEpoch: DAEMON_SCHEMA_EPOCH,
    capabilities: DAEMON_CAPABILITIES,
    instanceId: hiveInstanceSuffix(),
    ...resolveHandshakeProject(projectRoot),
    generation: DAEMON_GENERATION,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function parseDaemonHandshake(value: unknown): DaemonHandshake | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const wire = body.wireProtocol;
  if (
    typeof body.productVersion !== "string" || typeof body.buildHash !== "string" ||
    typeof body.schemaEpoch !== "number" || typeof body.instanceId !== "string" ||
    typeof body.hiveUuid !== "string" || typeof body.identityKey !== "string" ||
    !(typeof body.repoFamilyKey === "string" || body.repoFamilyKey === null) ||
    typeof body.generation !== "number" || !Array.isArray(body.capabilities) ||
    !body.capabilities.every((capability) => typeof capability === "string") ||
    typeof wire !== "object" || wire === null || Array.isArray(wire)
  ) return null;
  const protocol = wire as Record<string, unknown>;
  if (typeof protocol.min !== "number" || typeof protocol.max !== "number") return null;
  return {
    productVersion: body.productVersion,
    buildHash: body.buildHash,
    wireProtocol: { min: protocol.min, max: protocol.max },
    schemaEpoch: body.schemaEpoch,
    capabilities: body.capabilities as string[],
    instanceId: body.instanceId,
    hiveUuid: body.hiveUuid,
    identityKey: body.identityKey,
    repoFamilyKey: body.repoFamilyKey as string | null,
    generation: body.generation,
  };
}

export async function readDaemonHandshake(port: number): Promise<DaemonHandshake> {
  const response = await fetch(`http://127.0.0.1:${port}/handshake`, {
    signal: AbortSignal.timeout(1_000),
  });
  const handshake = response.ok
    ? parseDaemonHandshake(await response.json())
    : null;
  if (handshake === null) {
    throw new Error(`Hive daemon on port ${port} returned no valid handshake`);
  }
  return handshake;
}

export async function verifyDaemonInstance(
  port: number,
  instanceId: string,
): Promise<void> {
  const handshake = await readDaemonHandshake(port);
  if (handshake.instanceId !== instanceId) {
    throw new Error(
      `Refusing daemon on port ${port}: expected Hive instance ${instanceId}, got ${handshake.instanceId}`,
    );
  }
}

export function handshakeMismatch(
  expected: DaemonHandshake,
  actual: DaemonHandshake,
): string | null {
  if (actual.instanceId !== expected.instanceId) return "instance identity";
  if (actual.productVersion !== expected.productVersion) return "product version";
  if (actual.buildHash !== expected.buildHash) return "content-addressed build hash";
  if (actual.hiveUuid !== expected.hiveUuid) return "project identity (HiveUUID)";
  if (actual.identityKey !== expected.identityKey) return "project identity key";
  if (actual.repoFamilyKey !== expected.repoFamilyKey) return "repository family identity";
  if (actual.generation !== expected.generation) return "daemon generation";
  if (actual.schemaEpoch !== expected.schemaEpoch) return "schema/migration epoch";
  if (
    actual.wireProtocol.max < expected.wireProtocol.min ||
    expected.wireProtocol.max < actual.wireProtocol.min
  ) return "wire protocol range";
  if (!sameStringSet(actual.capabilities, expected.capabilities)) return "capability set";
  return null;
}
