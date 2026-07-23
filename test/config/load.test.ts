import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig, loadQuotaConfig } from "../../src/config/load";

let tempRoot = "";
let hiveHome = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-config-"));
  hiveHome = join(tempRoot, "home");
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = hiveHome;
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

async function resetHome(): Promise<void> {
  await rm(hiveHome, { recursive: true, force: true });
  await mkdir(hiveHome, { recursive: true });
}

describe("config loading", () => {
  test("returns schema defaults when files are absent", async () => {
    await resetHome();
    expect(await loadHiveConfig()).toMatchObject({
      autonomy: "sandboxed",
      resources: { enabled: true },
      lifecycle: { idleReap: true },
    });
    expect(await loadQuotaConfig()).toMatchObject({
      enabled: true,
      limits: [],
      estimates: {
        code_review: 8,
        complex_coding: 20,
        debugging: 20,
        default: 10,
        heavy_research: 20,
        light_research: 4,
        planning: 10,
        simple_coding: 10,
        summarization: 4,
      },
    });
  });

  test("an explicit autonomy choice survives the safe default", async () => {
    await resetHome();
    await writeFile(join(hiveHome, "config.toml"), 'autonomy = "dangerous"\n');
    expect((await loadHiveConfig()).autonomy).toBe("dangerous");
  });

  test("a legacy benchmarks section still parses", async () => {
    await resetHome();
    await writeFile(join(hiveHome, "config.toml"), '[benchmarks]\nmode = "off"\n');
    expect((await loadHiveConfig()).benchmarks.mode).toBe("off");
  });

  test("parses model-specific quota pools and rejects invalid timezones", async () => {
    await resetHome();
    await writeFile(join(hiveHome, "quota.toml"), [
      "[[limits]]",
      'provider = "claude"',
      'pool = "premium"',
      'models = ["opus", "sonnet"]',
      "fiveHourAllowance = 100",
      "weeklyAllowance = 500",
      'timezone = "America/New_York"',
    ].join("\n"));
    expect(await loadQuotaConfig()).toMatchObject({ limits: [{ provider: "claude", pool: "premium" }] });

    await writeFile(join(hiveHome, "quota.toml"), [
      "[[limits]]",
      'provider = "codex"',
      'pool = "agentic"',
      "fiveHourAllowance = 100",
      "weeklyAllowance = 500",
      'timezone = "Mars/Olympus"',
    ].join("\n"));
    expect(loadQuotaConfig()).rejects.toThrow("unknown timezone");
  });
});
