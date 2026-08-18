import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { getHiveHome, hiveInstanceSuffix } from "../../hive-home/home";
import { systemNow } from "../../shared/clock";
import { HIVE_BUILD_HASH, HIVE_VERSION } from "../../shared/version";
import { resolveHandshakeProject } from "../project-identity-core/project-identity-daemon";

/** This is intentionally separate from product version. A wire change must not silently attach a newer launcher to an older daemon with the same release label. */
export const DAEMON_WIRE_PROTOCOL = { min: 1, max: 1 } as const;
export const DAEMON_SCHEMA_EPOCH = 1;
export const DAEMON_GENERATION = 1;
export const DAEMON_CAPABILITIES = ["daemon-handshake-v1"] as const;
export const DAEMON_STARTUP_VERIFY_TIMEOUT_MS = 10_000;
export const DAEMON_STARTUP_VERIFY_RETRY_MS = 100;

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
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__fixtures__" ? [] : sourceFiles(path);
      }
      return entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return files.flat();
}

async function skillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return skillFiles(path);
      return entry.isFile() && entry.name === "SKILL.md" ? [path] : [];
    }),
  );
  return files.flat();
}

export async function sourceBuildHash(repoRoot: string): Promise<string> {
  const files = [
    ...(await sourceFiles(join(repoRoot, "src"))),
    ...(await skillFiles(join(repoRoot, "skills"))),
    join(repoRoot, "graphify.lock"),
    join(repoRoot, "bun.lock"),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(repoRoot, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Content address the executable, rather than its marketing version. A release binary carries its hash inlined at compile time: there is no source tree inside the compiled artifact to walk, and a build-time constant is the only value a peer cannot influence. A source checkout hashes the tree it is actually executing, which is what makes an edit-and-rerun cycle reject the daemon still running the pre-edit code. */
export async function currentBuildHash(): Promise<string> {
  if (HIVE_BUILD_HASH !== null) return HIVE_BUILD_HASH;
  return sourceBuildHash(resolveRepoRoot());
}

function resolveRepoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

/** The handshake this launcher expects from its daemon. Both identity halves — the instance suffix and the project registry that mints the HiveUUID — are functions of the Hive home, so callers that must not be redirected by a mid-flight `HIVE_HOME` change pass the home they already resolved rather than letting each half ask the environment again. */
export async function expectedDaemonHandshake(
  projectRoot: string,
  hiveHome: string = getHiveHome(),
): Promise<DaemonHandshake> {
  return {
    productVersion: HIVE_VERSION,
    buildHash: await currentBuildHash(),
    wireProtocol: DAEMON_WIRE_PROTOCOL,
    schemaEpoch: DAEMON_SCHEMA_EPOCH,
    capabilities: DAEMON_CAPABILITIES,
    instanceId: hiveInstanceSuffix(hiveHome),
    ...resolveHandshakeProject(projectRoot, hiveHome),
    generation: DAEMON_GENERATION,
  };
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

export function parseDaemonHandshake(value: unknown): DaemonHandshake | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const body = value as Record<string, unknown>;
  const wire = body.wireProtocol;
  if (
    typeof body.productVersion !== "string" ||
    typeof body.buildHash !== "string" ||
    typeof body.schemaEpoch !== "number" ||
    typeof body.instanceId !== "string" ||
    typeof body.hiveUuid !== "string" ||
    typeof body.identityKey !== "string" ||
    !(typeof body.repoFamilyKey === "string" || body.repoFamilyKey === null) ||
    typeof body.generation !== "number" ||
    !Array.isArray(body.capabilities) ||
    !body.capabilities.every((capability) => typeof capability === "string") ||
    typeof wire !== "object" ||
    wire === null ||
    Array.isArray(wire)
  )
    return null;
  const protocol = wire as Record<string, unknown>;
  if (typeof protocol.min !== "number" || typeof protocol.max !== "number")
    return null;
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

export interface ProbeHandshakeOptions {
  /** Per-caller budget for the whole probe; the right value is the caller's decision (a destructive gate waits longer than a startup reuse poll). */
  readonly timeoutMs?: number;
  /** Injectable for tests that must not open a real socket. */
  readonly fetcher?: typeof fetch;
}

/** The one daemon handshake probe. Every "is a Hive daemon there, and which one" question goes through here so the fetch, the parse, and the failure shape exist exactly once. A probe never throws: any failure — unreachable, timed out, not a Hive daemon — is `null`, and the caller decides what an absent answer means for its own gate. */
export async function probeHandshake(
  port: number,
  options: ProbeHandshakeOptions = {},
): Promise<DaemonHandshake | null> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/handshake`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_000),
    });
    return response.ok ? parseDaemonHandshake(await response.json()) : null;
  } catch {
    return null;
  }
}

export async function readDaemonHandshake(
  port: number,
): Promise<DaemonHandshake> {
  const handshake = await probeHandshake(port);
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
    throw new DaemonInstanceMismatchError(
      port,
      instanceId,
      handshake.instanceId,
    );
  }
}

export class DaemonInstanceMismatchError extends Error {
  constructor(port: number, expected: string, actual: string) {
    super(
      `Refusing daemon on port ${port}: expected Hive instance ${expected}, got ${actual}`,
    );
    this.name = "DaemonInstanceMismatchError";
  }
}

export interface VerifyDaemonInstanceWhenReadyDependencies {
  readonly verify?: (port: number, instanceId: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly retryMs?: number;
}

/** Waits through the short interval where a newly bound daemon is still doing startup maintenance. An identity mismatch is never transient: retrying it could attach this Workspace to a different Hive instance. */
export async function verifyDaemonInstanceWhenReady(
  port: number,
  instanceId: string,
  dependencies: VerifyDaemonInstanceWhenReadyDependencies = {},
): Promise<void> {
  const verify = dependencies.verify ?? verifyDaemonInstance;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? systemNow;
  const retryMs = dependencies.retryMs ?? DAEMON_STARTUP_VERIFY_RETRY_MS;
  const deadline =
    now() + (dependencies.timeoutMs ?? DAEMON_STARTUP_VERIFY_TIMEOUT_MS);

  while (true) {
    try {
      await verify(port, instanceId);
      return;
    } catch (error) {
      if (error instanceof DaemonInstanceMismatchError) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(retryMs, remaining));
    }
  }
}

export function handshakeMismatch(
  expected: DaemonHandshake,
  actual: DaemonHandshake,
): string | null {
  if (actual.instanceId !== expected.instanceId) return "instance identity";
  if (actual.productVersion !== expected.productVersion)
    return "product version";
  if (actual.buildHash !== expected.buildHash)
    return "content-addressed build hash";
  if (actual.hiveUuid !== expected.hiveUuid)
    return "project identity (HiveUUID)";
  if (actual.identityKey !== expected.identityKey)
    return "project identity key";
  if (actual.repoFamilyKey !== expected.repoFamilyKey)
    return "repository family identity";
  if (actual.generation !== expected.generation) return "daemon generation";
  if (actual.schemaEpoch !== expected.schemaEpoch)
    return "schema/migration epoch";
  if (
    actual.wireProtocol.max < expected.wireProtocol.min ||
    expected.wireProtocol.max < actual.wireProtocol.min
  )
    return "wire protocol range";
  if (!sameStringSet(actual.capabilities, expected.capabilities))
    return "capability set";
  return null;
}
