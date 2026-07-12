import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHiveConfig,
  loadQuotaConfig,
  loadRoutingFloors,
  loadRoutingPins,
} from "./load";

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
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (tempRoot !== "") {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function resetHome(): Promise<void> {
  Bun.env.HIVE_HOME = hiveHome;
  await rm(hiveHome, { recursive: true, force: true });
  await mkdir(hiveHome, { recursive: true });
}

describe("config loading", () => {
  test("returns schema defaults when files are absent", async () => {
    await resetHome();

    expect(await loadHiveConfig()).toEqual({
      terminal: "auto",
      headless: false,
      layout: "auto",
      codex: { driver: "tui" },
      channels: "auto",
      autonomy: "sandboxed",
      routingManifest: "auto",
      router: "derived",
      benchmarks: { mode: "live" },
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
      lifecycle: {
        idleReap: true,
        idleReapMinutes: 10,
      },
    });
    // No routing.toml means no pins — and no shipped table underneath them:
    // the binary names no model, so an empty file yields an empty policy.
    expect(await loadRoutingPins()).toEqual({});
    expect(await loadQuotaConfig()).toMatchObject({
      enabled: true,
      limits: [],
      estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
    });
  });

  test("an explicit autonomy choice survives the safe default", async () => {
    // The shipped default flipped to "sandboxed" (2026-07-11); a user who
    // deliberately configured "dangerous" must keep exactly what they chose.
    await resetHome();
    await writeFile(
      join(hiveHome, "config.toml"),
      'autonomy = "dangerous"\n',
    );
    expect((await loadHiveConfig()).autonomy).toEqual("dangerous");
  });

  test("benchmark inspection has an explicit hard-off switch", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "config.toml"),
      '[benchmarks]\nmode = "off"\n',
    );
    expect((await loadHiveConfig()).benchmarks.mode).toBe("off");
  });

  test("a legacy 'shadow' benchmarks mode parses as live — the parallel path it named is gone", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "config.toml"),
      '[benchmarks]\nmode = "shadow"\n',
    );
    expect((await loadHiveConfig()).benchmarks.mode).toBe("live");
  });

  test("parses model-specific quota pools and rejects invalid timezone configuration", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "quota.toml"),
      [
        "warningRemainingPct = 0.3",
        "criticalRemainingPct = 0.1",
        "",
        "[[limits]]",
        'provider = "claude"',
        'account = "work"',
        'pool = "premium"',
        'models = ["opus", "sonnet"]',
        "fiveHourAllowance = 100",
        "weeklyAllowance = 500",
        'weeklyWindow = "calendar"',
        'timezone = "America/New_York"',
        "resetWeekday = 1",
      ].join("\n"),
    );
    expect(await loadQuotaConfig()).toMatchObject({
      warningRemainingPct: 0.3,
      limits: [{
        provider: "claude",
        account: "work",
        pool: "premium",
        models: ["opus", "sonnet"],
        weeklyWindow: "calendar",
        timezone: "America/New_York",
      }],
    });

    await writeFile(
      join(hiveHome, "quota.toml"),
      [
        "[[limits]]",
        'provider = "codex"',
        'pool = "agentic"',
        "fiveHourAllowance = 100",
        "weeklyAllowance = 500",
        'timezone = "Mars/Olympus"',
      ].join("\n"),
    );
    expect(loadQuotaConfig()).rejects.toThrow("unknown timezone");
  });

  test("parses config and merges partial routes over defaults", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "config.toml"),
      [
        'terminal = "iterm2"',
        "headless = true",
        "",
        "[codex]",
        'driver = "app-server"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(hiveHome, "routing.toml"),
      [
        "[deep]",
        'tool = "codex"',
        "",
        "[deep.codex]",
        'model = "gpt-deep"',
        'effort = "xhigh"',
        "",
        "[cheap.claude]",
        'model = "gpt-cheap-local"',
        "",
      ].join("\n"),
    );

    expect(await loadHiveConfig()).toEqual({
      terminal: "iterm2",
      headless: true,
      layout: "auto",
      codex: { driver: "app-server" },
      channels: "auto",
      autonomy: "sandboxed",
      routingManifest: "auto",
      router: "derived",
      benchmarks: { mode: "live" },
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
      lifecycle: {
        idleReap: true,
        idleReapMinutes: 10,
      },
    });
    // Pins are read back exactly as written — nothing is merged underneath
    // them, because there is nothing shipped to merge.
    const pins = await loadRoutingPins();
    expect(pins.deep?.tool).toEqual("codex");
    expect(pins.deep?.codex).toEqual({ model: "gpt-deep", effort: "xhigh" });
    expect(pins.cheap?.claude).toEqual({ model: "gpt-cheap-local" });
    expect(pins.cheap?.codex).toBeUndefined();
  });

  test("a single-cell pin parses alone, touching nothing else", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      '[cheap.claude]\nmodel = "haiku-local"\n',
    );

    const pins = await loadRoutingPins();
    expect(pins.cheap?.claude).toEqual({ model: "haiku-local" });
    expect(pins.deep).toBeUndefined();
  });

  test("reports invalid config with its path and schema details", async () => {
    await resetHome();
    await writeFile(join(hiveHome, "config.toml"), 'terminal = "xterm"\n');

    let message = "";
    try {
      await loadHiveConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes(join(hiveHome, "config.toml"))).toEqual(true);
    expect(message.includes("terminal")).toEqual(true);
    expect(message.includes("auto")).toEqual(true);
  });

  test("reports invalid routing overrides", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      '[review]\ntool = "gemini"\n',
    );

    let message = "";
    try {
      await loadRoutingPins();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes(join(hiveHome, "routing.toml"))).toEqual(true);
    expect(message.includes("codex")).toEqual(true);
  });

  test("rejects a misspelled tier instead of silently pinning nothing", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      '[deeep.claude]\nmodel = "claude-fable-5"\n',
    );

    let message = "";
    try {
      await loadRoutingPins();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes("unknown tier")).toEqual(true);
    expect(message.includes("deeep")).toEqual(true);
    expect(message.includes("deep, standard, cheap, review")).toEqual(true);
  });

  test("rejects a __proto__ route without polluting Object.prototype", async () => {
    await resetHome();
    const path = join(hiveHome, "routing.toml");
    const pollutionKey = "hiveRoutingPrototypePolluted";
    await writeFile(
      path,
      `["__proto__"]\n${pollutionKey} = true\n`,
    );

    expect(Object.hasOwn(Object.prototype, pollutionKey)).toEqual(false);

    let message = "";
    try {
      await loadRoutingPins();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.startsWith(`Invalid routing table at ${path}:`)).toEqual(
      true,
    );
    expect(message.includes("__proto__")).toEqual(true);
    expect(Object.hasOwn(Object.prototype, pollutionKey)).toEqual(false);
  });

  test("an explicit routing.toml pin reads back verbatim", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      '[deep.claude]\nmodel = "claude-fable-5"\n',
    );
    const pins = await loadRoutingPins();
    expect(pins.deep?.claude?.model).toEqual("claude-fable-5");
  });

  test("no routing.toml means no floors — the binary ships none", async () => {
    await resetHome();
    expect(await loadRoutingFloors()).toEqual({});
  });

  test("floors read back verbatim and coexist with pins in the same file", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      [
        "[deep.claude]",
        'model = "claude-fable-5"',
        "",
        "[floors.claude]",
        'allow = ["claude-opus-4-8", "claude-fable-5"]',
        "",
        "[floors.codex]",
        'allow = ["gpt-5.6-sol"]',
        "",
      ].join("\n"),
    );
    const floors = await loadRoutingFloors();
    expect(floors.claude?.allow).toEqual(["claude-opus-4-8", "claude-fable-5"]);
    expect(floors.codex?.allow).toEqual(["gpt-5.6-sol"]);
    // `floors` is a reserved key, not a tier: it does not trip the unknown-tier
    // check, and the pin alongside it still reads back untouched.
    const pins = await loadRoutingPins();
    expect(pins.deep?.claude?.model).toEqual("claude-fable-5");
    expect(pins.floors).toBeUndefined();
  });

  test("an empty allow-list is rejected — a floor with no members admits nothing", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      "[floors.claude]\nallow = []\n",
    );
    let message = "";
    try {
      await loadRoutingFloors();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes(join(hiveHome, "routing.toml"))).toEqual(true);
  });
});
