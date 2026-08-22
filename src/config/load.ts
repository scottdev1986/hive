import { join } from "node:path";
import { getHiveHome } from "../hive-home/home";
import {
  DEFAULT_QUOTA_CONFIG,
  type QuotaConfig,
  QuotaConfigSchema,
} from "../schemas/quota";
import { type HiveConfig, HiveConfigSchema } from "../schemas/config-schema";
import { errorMessage } from "../shared/error-message";
import type { JsonValue } from "../shared/json";

async function readToml(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return undefined;
  }
  return await file.text();
}

/** The file `loadHiveConfig` reads. A writer must target this exact path, not its own reconstruction of it, or a compare-and-set would fence a file nobody loads. */
export function hiveConfigPath(): string {
  return join(getHiveHome(), "config.toml");
}

export async function loadHiveConfig(): Promise<HiveConfig> {
  const path = hiveConfigPath();
  const text = await readToml(path);
  let parsed: JsonValue = {};
  if (text !== undefined) {
    try {
      // SAFETY: Bun.TOML.parse of a config file yields JSON-shaped data; zod parse below is the contract.
      parsed = Bun.TOML.parse(text) as JsonValue;
    } catch (error) {
      throw new Error(`Invalid TOML in ${path}: ${errorMessage(error)}`);
    }
  }
  try {
    return HiveConfigSchema.parse(parsed);
  } catch (error) {
    throw new Error(`Invalid hive config at ${path}: ${errorMessage(error)}`);
  }
}

export async function loadQuotaConfig(): Promise<QuotaConfig> {
  const path = join(getHiveHome(), "quota.toml");
  const text = await readToml(path);
  let parsed: JsonValue = DEFAULT_QUOTA_CONFIG;
  if (text !== undefined) {
    try {
      // SAFETY: Bun.TOML.parse of a config file yields JSON-shaped data; zod parse below is the contract.
      parsed = Bun.TOML.parse(text) as JsonValue;
    } catch (error) {
      throw new Error(`Invalid TOML in ${path}: ${errorMessage(error)}`);
    }
  }
  try {
    const config = QuotaConfigSchema.parse(parsed);
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
