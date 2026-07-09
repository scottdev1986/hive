import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROUTING } from "../schemas";
import { loadHiveConfig, loadRoutingTable, resolveRoute } from "./load";

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
    });
    expect(await loadRoutingTable()).toEqual(DEFAULT_ROUTING);
  });

  test("parses config and merges partial routes over defaults", async () => {
    await resetHome();
    await writeFile(
      join(hiveHome, "config.toml"),
      'terminal = "iterm2"\nheadless = true\n',
    );
    await writeFile(
      join(hiveHome, "routing.toml"),
      [
        "[deep]",
        'tool = "codex"',
        'model = "gpt-deep"',
        'effort = "xhigh"',
        "",
        "[cheap]",
        'model = "gpt-cheap-local"',
        "",
      ].join("\n"),
    );

    expect(await loadHiveConfig()).toEqual({
      terminal: "iterm2",
      headless: true,
    });
    const routing = await loadRoutingTable();
    expect(routing.deep).toEqual({
      tool: "codex",
      model: "gpt-deep",
      effort: "xhigh",
    });
    expect(routing.cheap).toEqual({
      ...DEFAULT_ROUTING.cheap,
      model: "gpt-cheap-local",
    });
    expect(await resolveRoute("deep")).toEqual(routing.deep);
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
});
