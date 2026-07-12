import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_QUOTA_CONFIG,
  HiveConfigSchema,
  QuotaConfigSchema,
  ROUTING_TIERS,
  RoutingFloorsSchema,
  RoutingPinsSchema,
  type HiveConfig,
  type QuotaConfig,
  type RoutingFloors,
  type RoutingPins,
} from "../schemas";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeOwn = (...sources: object[]): Record<string, unknown> =>
  Object.assign(Object.create(null), ...sources);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

async function readToml(path: string): Promise<unknown | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return undefined;
  }

  try {
    return Bun.TOML.parse(await file.text());
  } catch (error) {
    throw new Error(`Invalid TOML in ${path}: ${errorMessage(error)}`);
  }
}

export async function loadHiveConfig(): Promise<HiveConfig> {
  const path = join(hiveHome(), "config.toml");
  const raw = await readToml(path);

  try {
    return HiveConfigSchema.parse(raw ?? {});
  } catch (error) {
    throw new Error(`Invalid hive config at ${path}: ${errorMessage(error)}`);
  }
}

export async function loadQuotaConfig(): Promise<QuotaConfig> {
  const path = join(hiveHome(), "quota.toml");
  const raw = await readToml(path);

  try {
    const config = QuotaConfigSchema.parse(raw ?? DEFAULT_QUOTA_CONFIG);
    for (const limit of config.limits) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: limit.timezone }).format();
      } catch {
        throw new Error(`unknown timezone ${limit.timezone}`);
      }
    }
    return config;
  } catch (error) {
    throw new Error(`Invalid quota config at ${path}: ${errorMessage(error)}`);
  }
}

/**
 * The user's pins: the one hand-authored route source. There is no shipped
 * table to merge under them any more (`loadRoutingTable` and `resolveRoute`
 * died with it) — the derivation engine layers these over live discovery.
 *
 * Tier names are checked explicitly. `RoutingPinsSchema` is keyed by plain
 * strings so a single-tier file parses, which means a misspelled tier would
 * otherwise parse too — into a pin that silently pins nothing. A key that
 * names no tier is an error, not an ignorable extra.
 */
export async function loadRoutingPins(): Promise<RoutingPins> {
  const path = join(hiveHome(), "routing.toml");
  const raw = await readToml(path);
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new Error(`Invalid routing table at ${path}: expected a TOML table`);
  }
  // `floors` is a reserved top-level key, not a tier — `loadRoutingFloors`
  // reads it from the same file.
  const unknown = Object.keys(raw).filter((key) =>
    key !== "floors" && !(ROUTING_TIERS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Invalid routing table at ${path}: unknown tier ${
        unknown.map((key) => JSON.stringify(key)).join(", ")
      } (tiers are ${ROUTING_TIERS.join(", ")})`,
    );
  }
  const { floors: _floors, ...pins } = raw;
  try {
    return RoutingPinsSchema.parse(pins);
  } catch (error) {
    throw new Error(`Invalid routing table at ${path}: ${errorMessage(error)}`);
  }
}

/**
 * The user's capability floors: the one place a floor value is ever named.
 * Read from the same `routing.toml`, under the reserved `[floors]` table.
 * Missing means no floor is configured — the derivation runs exactly as it
 * did before floors existed, which is the point: the binary ships the schema
 * and the enforcement, never a value.
 */
export async function loadRoutingFloors(): Promise<RoutingFloors> {
  const path = join(hiveHome(), "routing.toml");
  const raw = await readToml(path);
  if (raw === undefined || !isRecord(raw) || raw.floors === undefined) {
    return {};
  }
  try {
    return RoutingFloorsSchema.parse(raw.floors);
  } catch (error) {
    throw new Error(`Invalid capability floors at ${path}: ${errorMessage(error)}`);
  }
}
