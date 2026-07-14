import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexMcpExclusionArgs,
  codexHome,
  HIVE_MCP_SERVERS,
  isCodexAddressableServerName,
  listInheritedCodexMcpServers,
  parseCodexMcpServerNames,
} from "./mcp-scope";

let tempRoot = "";

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-mcp-scope-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("parseCodexMcpServerNames", () => {
  test("reads table headers and collapses subtables to the server name", () => {
    const names = parseCodexMcpServerNames(
      [
        "model = 'gpt-5.6-terra'",
        "",
        "[mcp_servers.idea]",
        'url = "http://127.0.0.1:64342/stream"',
        "",
        "[mcp_servers.hive]",
        'url = "http://127.0.0.1:4483/mcp"',
        "",
        "[mcp_servers.hive.http_headers]",
        'Authorization = "Bearer x"',
      ].join("\n"),
    );
    expect(names).toEqual(["idea", "hive"]);
  });

  test("reads the inline assignment form", () => {
    const names = parseCodexMcpServerNames(
      'mcp_servers.openaiDeveloperDocs = { url = "https://developers.openai.com/mcp" }',
    );
    expect(names).toEqual(["openaiDeveloperDocs"]);
  });

  test("ignores commented-out servers and unrelated tables", () => {
    const names = parseCodexMcpServerNames(
      [
        "# [mcp_servers.disabled]",
        '[projects."/tmp/x"]',
        'trust_level = "trusted"',
        "[tui.model_availability_nux]",
      ].join("\n"),
    );
    expect(names).toEqual([]);
  });

  test("keeps a quoted name whole so it can be rejected later", () => {
    expect(parseCodexMcpServerNames('[mcp_servers."odd.name"]')).toEqual([
      "odd.name",
    ]);
  });
});

describe("isCodexAddressableServerName", () => {
  test("accepts bare TOML keys", () => {
    expect(isCodexAddressableServerName("idea")).toBe(true);
    expect(isCodexAddressableServerName("openaiDeveloperDocs")).toBe(true);
    expect(isCodexAddressableServerName("legacy-server")).toBe(true);
    expect(isCodexAddressableServerName("a_b1")).toBe(true);
  });

  // codex-cli 0.144.0 splits `-c` dotted paths on "." with no quoting support,
  // so these names cannot be targeted; emitting an override for one produces a
  // transport-less entry and Codex refuses to start.
  test("rejects names that a -c dotted path cannot reach", () => {
    expect(isCodexAddressableServerName("odd.name")).toBe(false);
    expect(isCodexAddressableServerName('say "hi"')).toBe(false);
    expect(isCodexAddressableServerName("has space")).toBe(false);
  });
});

describe("buildCodexMcpExclusionArgs", () => {
  test("disables each inherited server with a config override", () => {
    const result = buildCodexMcpExclusionArgs(["idea", "openaiDeveloperDocs"]);
    expect(result.args).toEqual([
      "-c",
      "mcp_servers.idea.enabled=false",
      "-c",
      "mcp_servers.openaiDeveloperDocs.enabled=false",
    ]);
    expect(result.excluded).toEqual(["idea", "openaiDeveloperDocs"]);
    expect(result.unaddressable).toEqual([]);
  });

  test("never detaches Hive's own server", () => {
    const result = buildCodexMcpExclusionArgs([
      ...HIVE_MCP_SERVERS,
      "idea",
    ]);
    expect(result.args).toEqual(["-c", "mcp_servers.idea.enabled=false"]);
    expect(result.excluded).toEqual(["idea"]);
  });

  test("leaves an unaddressable name attached rather than breaking the launch", () => {
    const result = buildCodexMcpExclusionArgs(["odd.name", "idea"]);
    expect(result.args).toEqual(["-c", "mcp_servers.idea.enabled=false"]);
    expect(result.unaddressable).toEqual(["odd.name"]);
    expect(result.args.join(" ")).not.toContain("odd.name");
  });

  test("honours an explicit keep list", () => {
    const result = buildCodexMcpExclusionArgs(["idea", "docs"], [
      "hive",
      "docs",
    ]);
    expect(result.excluded).toEqual(["idea"]);
  });

  test("emits nothing when nothing is inherited", () => {
    expect(buildCodexMcpExclusionArgs([]).args).toEqual([]);
  });
});

describe("listInheritedCodexMcpServers", () => {
  test("reads the global config without writing it", async () => {
    const home = join(tempRoot, "codex");
    await Bun.write(join(home, "config.toml"), "[mcp_servers.idea]\nurl = 'x'\n");
    const before = await Bun.file(join(home, "config.toml")).text();
    expect(await listInheritedCodexMcpServers(home)).toEqual(["idea"]);
    expect(await Bun.file(join(home, "config.toml")).text()).toBe(before);
  });

  test("a missing config inherits nothing", async () => {
    expect(await listInheritedCodexMcpServers(join(tempRoot, "absent"))).toEqual(
      [],
    );
  });

  test("codexHome honours CODEX_HOME", () => {
    expect(codexHome({ CODEX_HOME: "/custom" }, "/home/x")).toBe("/custom");
    expect(codexHome({}, "/home/x")).toBe("/home/x/.codex");
  });
});
