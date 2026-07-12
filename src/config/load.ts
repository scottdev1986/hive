import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultRoutingTable,
  DEFAULT_QUOTA_CONFIG,
  HiveConfigSchema,
  QuotaConfigSchema,
  RoutingPinsSchema,
  RoutingTableSchema,
  type HiveConfig,
  type QuotaConfig,
  type Route,
  type RoutingPins,
  type RoutingTable,
  type RoutingTier,
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

export async function loadRoutingTable(): Promise<RoutingTable> {
  const path = join(hiveHome(), "routing.toml");
  const raw = await readToml(path);

  if (raw !== undefined && !isRecord(raw)) {
    throw new Error(`Invalid routing table at ${path}: expected a TOML table`);
  }

  const merged = mergeOwn();
  for (const [tier, route] of Object.entries(defaultRoutingTable())) {
    const mergedRoute = mergeOwn(route);
    mergedRoute.claude = mergeOwn(route.claude);
    mergedRoute.codex = mergeOwn(route.codex);
    merged[tier] = mergedRoute;
  }

  for (const [tier, override] of Object.entries(raw ?? {})) {
    const fallback = merged[tier];
    if (!isRecord(fallback) || !isRecord(override)) {
      merged[tier] = isRecord(override) ? mergeOwn(override) : override;
      continue;
    }

    const mergedRoute = mergeOwn(fallback, override);
    for (const tool of ["claude", "codex"] as const) {
      const fallbackTool = fallback[tool];
      const overrideTool = override[tool];
      if (isRecord(fallbackTool) && isRecord(overrideTool)) {
        mergedRoute[tool] = mergeOwn(fallbackTool, overrideTool);
      }
    }
    merged[tier] = mergedRoute;
  }

  try {
    return RoutingTableSchema.parse(merged);
  } catch (error) {
    throw new Error(`Invalid routing table at ${path}: ${errorMessage(error)}`);
  }
}

/**
 * The user's pins alone, before the shipped table is merged under them.
 *
 * `loadRoutingTable` returns the merge, which is what routing needs and exactly
 * what an inspection surface must not use: after the merge, a value the user
 * pinned and a value Hive shipped are the same string in the same slot. Telling
 * them apart requires reading the file the user actually wrote.
 */
export async function loadRoutingPins(): Promise<RoutingPins> {
  const path = join(hiveHome(), "routing.toml");
  const raw = await readToml(path);
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new Error(`Invalid routing table at ${path}: expected a TOML table`);
  }
  try {
    return RoutingPinsSchema.parse(raw);
  } catch (error) {
    throw new Error(`Invalid routing table at ${path}: ${errorMessage(error)}`);
  }
}

export async function resolveRoute(tier: RoutingTier): Promise<Route> {
  const routing = await loadRoutingTable();
  return routing[tier];
}
