import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROUTING, FABLE_AUTO_ROUTING_CUTOFF } from "../schemas";
import {
  loadHiveConfig,
  loadQuotaConfig,
  loadRoutingTable,
  resolveRoute,
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
      autonomy: "dangerous",
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
    });
    const beforeFableCutoff = new Date(
      new Date(FABLE_AUTO_ROUTING_CUTOFF).getTime() - 1,
    );
    expect(await loadRoutingTable(beforeFableCutoff)).toEqual(DEFAULT_ROUTING);
    expect(await loadQuotaConfig()).toMatchObject({
      enabled: true,
      limits: [],
      estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
    });
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
      autonomy: "dangerous",
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
    });
    const routing = await loadRoutingTable();
    expect(routing.deep).toEqual({
      tool: "codex",
      claude: DEFAULT_ROUTING.deep.claude,
      codex: {
        model: "gpt-deep",
        effort: "xhigh",
      },
    });
    expect(routing.cheap).toEqual({
      ...DEFAULT_ROUTING.cheap,
      claude: {
        ...DEFAULT_ROUTING.cheap.claude,
        model: "gpt-cheap-local",
      },
    });
    expect(await resolveRoute("deep")).toEqual(routing.deep);
  });

  test("deep-merges one tool override without changing the other tool", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "routing.toml"),
      '[cheap.claude]\nmodel = "haiku-local"\n',
    );

    const routing = await loadRoutingTable();
    expect(routing.cheap.claude).toEqual({
      ...DEFAULT_ROUTING.cheap.claude,
      model: "haiku-local",
    });
    expect(routing.cheap.codex).toEqual(DEFAULT_ROUTING.cheap.codex);
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
      '[review]\ntool = "gemini"\nmodel = "pro"\n',
    );

    let message = "";
    try {
      await loadRoutingTable();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes(join(hiveHome, "routing.toml"))).toEqual(true);
    expect(message.includes("review")).toEqual(true);
    expect(message.includes("codex")).toEqual(true);
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
      await loadRoutingTable();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.startsWith(`Invalid routing table at ${path}:`)).toEqual(
      true,
    );
    expect(message.includes("__proto__")).toEqual(true);
    expect(Object.hasOwn(Object.prototype, pollutionKey)).toEqual(false);
  });

  describe("Fable auto-routing cutoff", () => {
    const cutoff = new Date(FABLE_AUTO_ROUTING_CUTOFF);
    const beforeCutoff = new Date(cutoff.getTime() - 1);

    test("deep tier stays on the best alias before the cutoff", async () => {
      await resetHome();
      const routing = await loadRoutingTable(beforeCutoff);
      expect(routing.deep.claude.model).toEqual("best");
      expect(await resolveRoute("deep", beforeCutoff)).toEqual(routing.deep);
    });

    test("deep tier defaults to Opus 4.8 on/after the cutoff", async () => {
      await resetHome();
      const routing = await loadRoutingTable(cutoff);
      expect(routing.deep.claude.model).toEqual("claude-opus-4-8");
      expect(routing.deep.codex).toEqual(DEFAULT_ROUTING.deep.codex);
      expect(await resolveRoute("deep", cutoff)).toEqual(routing.deep);
    });

    test("an explicit routing.toml pin to Fable survives the cutoff", async () => {
      await resetHome();
      await writeFile(
        join(hiveHome, "routing.toml"),
        '[deep.claude]\nmodel = "claude-fable-5"\n',
      );
      const routing = await loadRoutingTable(cutoff);
      expect(routing.deep.claude.model).toEqual("claude-fable-5");
    });
  });
});
