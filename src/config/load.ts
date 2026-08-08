import { join } from "node:path";
import { getHiveHome } from "../hive-home/home";
import {
  DEFAULT_QUOTA_CONFIG,
  type QuotaConfig,
  QuotaConfigSchema,
} from "../schemas/quota";
import { type HiveConfig, HiveConfigSchema } from "../schemas/config-schema";
import { errorMessage } from "../shared/error-message";

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

/** The file `loadHiveConfig` reads. A writer must target this exact path, not its own reconstruction of it, or a compare-and-set would fence a file nobody loads. */
export function hiveConfigPath(): string {
  return join(getHiveHome(), "config.toml");
}

export async function loadHiveConfig(): Promise<HiveConfig> {
  const path = hiveConfigPath();
  const raw = await readToml(path);

  try {
    return HiveConfigSchema.parse(raw ?? {});
  } catch (error) {
    throw new Error(`Invalid hive config at ${path}: ${errorMessage(error)}`);
  }
}

export async function loadQuotaConfig(): Promise<QuotaConfig> {
  const path = join(getHiveHome(), "quota.toml");
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
