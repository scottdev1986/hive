import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "../../schemas";
import { defaultRoutingTable, FABLE_AUTO_ROUTING_CUTOFF } from "../../schemas";
import {
  CLAUDE_BEST_MODEL,
  CLAUDE_OPUS_MODEL,
  resolveConcreteModel,
} from "./models";

const previousClaudeConfigDir = Bun.env.CLAUDE_CONFIG_DIR;
const previousCodexHome = Bun.env.CODEX_HOME;
const tempRoots: string[] = [];

afterEach(async () => {
  if (previousClaudeConfigDir === undefined) {
    delete Bun.env.CLAUDE_CONFIG_DIR;
  } else {
    Bun.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  }
  if (previousCodexHome === undefined) {
    delete Bun.env.CODEX_HOME;
  } else {
    Bun.env.CODEX_HOME = previousCodexHome;
  }
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function isolatedHomes(): Promise<{ claude: string; codex: string }> {
  const root = await mkdtemp(join(tmpdir(), "hive-models-"));
  tempRoots.push(root);
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  await Promise.all([
    mkdir(claude, { recursive: true }),
    mkdir(codex, { recursive: true }),
  ]);
  Bun.env.CLAUDE_CONFIG_DIR = claude;
  Bun.env.CODEX_HOME = codex;
  return { claude, codex };
}

function route(overrides: {
  tool?: Route["tool"];
  claudeModel?: string;
  codexModel?: string;
}): Route {
  return {
    tool: overrides.tool ?? "claude",
    claude: { model: overrides.claudeModel ?? "default" },
    codex: { model: overrides.codexModel ?? "default", effort: "medium" },
  };
}

describe("resolveConcreteModel", () => {
  test("passes concrete route models through untouched", async () => {
    await isolatedHomes();
    expect(
      await resolveConcreteModel("claude", route({ claudeModel: "sonnet" })),
    ).toEqual("sonnet");
    expect(
      await resolveConcreteModel(
        "codex",
        route({ tool: "codex", codexModel: "gpt-5.6-sol" }),
      ),
    ).toEqual("gpt-5.6-sol");
  });

  test("resolves the claude best alias to the verified concrete model", async () => {
    await isolatedHomes();
    const resolved = await resolveConcreteModel(
      "claude",
      route({ claudeModel: "best" }),
    );
    expect(resolved).toEqual(CLAUDE_BEST_MODEL);
    expect(resolved).not.toEqual("best");
    expect(resolved).not.toEqual("default");
  });

  test("resolves claude default from the user's settings.json", async () => {
    const homes = await isolatedHomes();
    await writeFile(
      join(homes.claude, "settings.json"),
      JSON.stringify({ model: "claude-fable-5[1m]" }),
    );
    expect(await resolveConcreteModel("claude", route({}))).toEqual(
      "claude-fable-5[1m]",
    );
  });

  test("resolves codex default from the user's config.toml", async () => {
    const homes = await isolatedHomes();
    await writeFile(
      join(homes.codex, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n',
    );
    expect(
      await resolveConcreteModel("codex", route({ tool: "codex" })),
    ).toEqual("gpt-5.6-sol");
  });

  test("falls back to the alias when no tool config names a model", async () => {
    await isolatedHomes();
    expect(await resolveConcreteModel("claude", route({}))).toEqual("default");
    expect(
      await resolveConcreteModel("codex", route({ tool: "codex" })),
    ).toEqual("default");
  });

  test("ignores unreadable or modelless tool configs", async () => {
    const homes = await isolatedHomes();
    await writeFile(join(homes.claude, "settings.json"), "{not json");
    await writeFile(
      join(homes.codex, "config.toml"),
      'model_reasoning_effort = "high"\n',
    );
    expect(await resolveConcreteModel("claude", route({}))).toEqual("default");
    expect(
      await resolveConcreteModel("codex", route({ tool: "codex" })),
    ).toEqual("default");
  });

  test("passes the concrete Opus 4.8 model through untouched", async () => {
    await isolatedHomes();
    expect(
      await resolveConcreteModel(
        "claude",
        route({ claudeModel: CLAUDE_OPUS_MODEL }),
      ),
    ).toEqual("claude-opus-4-8");
  });
});

describe("CLAUDE_OPUS_MODEL", () => {
  test("matches the model the post-Fable-cutoff default routing table pins", () => {
    // Cross-check against schemas/routing.ts's own (necessarily duplicated,
    // since schemas cannot depend on adapters) copy of this id.
    const table = defaultRoutingTable(new Date(FABLE_AUTO_ROUTING_CUTOFF));
    expect(table.deep.claude.model).toEqual(CLAUDE_OPUS_MODEL);
  });
});
