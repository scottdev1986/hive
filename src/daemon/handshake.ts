import { createHash } from "node:crypto";
import { resolveHandshakeProject } from "./project-identity";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { HIVE_VERSION } from "./version";

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

/** Content address the executable source tree, rather than its marketing version. */
export async function currentBuildHash(): Promise<string> {
  const sourceRoot = resolveSourceRoot();
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

function resolveSourceRoot(): string {
  // Both the source checkout and a packaged build retain this module beneath
  // `src/daemon`; resolving from import.meta.dir avoids the caller's cwd.
  return join(import.meta.dir, "..");
}

/**
 * The current CLI has no Supervisor registry yet. Until that migration lands,
 * canonical root identity is deterministic and scoped to the exact real path;
 * it is never inferred from a daemon that happened to bind first.
 */
export async function hiveUuidForProject(projectRoot: string): Promise<string> {
  // Embedded daemons in unit tests may use a synthetic root. Production
  // launchers always pass an existing cwd, where realpath removes symlinks.
  const canonicalRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
  return `hive-${createHash("sha256")
    .update("hive-project-v1\0")
    .update(canonicalRoot)
    .digest("hex")}`;
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
    typeof body.schemaEpoch !== "number" || typeof body.hiveUuid !== "string" || typeof body.identityKey !== "string" ||
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
    hiveUuid: body.hiveUuid,
    identityKey: body.identityKey,
    repoFamilyKey: body.repoFamilyKey as string | null,
    generation: body.generation,
  };
}

export function handshakeMismatch(
  expected: DaemonHandshake,
  actual: DaemonHandshake,
): string | null {
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
