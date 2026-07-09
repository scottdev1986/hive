import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTING,
  HiveConfigSchema,
  RoutingTableSchema,
  type HiveConfig,
  type Route,
  type RoutingTable,
  type RoutingTier,
} from "../schemas";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export async function loadRoutingTable(): Promise<RoutingTable> {
  const path = join(hiveHome(), "routing.toml");
  const raw = await readToml(path);

  if (raw !== undefined && !isRecord(raw)) {
    throw new Error(`Invalid routing table at ${path}: expected a TOML table`);
  }

  const merged: Record<string, unknown> = { ...DEFAULT_ROUTING };
  for (const [tier, override] of Object.entries(raw ?? {})) {
    const fallback = merged[tier];
    merged[tier] =
      isRecord(fallback) && isRecord(override)
        ? { ...fallback, ...override }
        : override;
  }

  try {
    return RoutingTableSchema.parse(merged);
  } catch (error) {
    throw new Error(`Invalid routing table at ${path}: ${errorMessage(error)}`);
  }
}

export async function resolveRoute(tier: RoutingTier): Promise<Route> {
  const routing = await loadRoutingTable();
  return routing[tier];
}
