import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairLeakedProjectConfig } from "./project-config-cleanup";

describe("repairLeakedProjectConfig", () => {
  test("removes stale orchestrator runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-config-repair-"));
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
        hive: {
          type: "http",
          url: "http://127.0.0.1:4483/mcp",
          headersHelper: "hive credential --agent orchestrator",
        },
        "hive-channel": {
          type: "stdio",
          command: "hive",
          args: ["channel-bridge", "--agent", "orchestrator", "--port", "4483"],
        },
      } }));
      await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({
        permissions: {
          defaultMode: "default",
          allow: ["Read", "Glob", "Grep", "mcp__hive__hive_approve"],
          deny: ["Edit", "Write", "NotebookEdit", "Bash"],
        },
        enableAllProjectMcpServers: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "hive event turn-end --agent orchestrator --port 4483" }] }] },
        statusLine: { type: "command", command: "hive statusline --agent orchestrator --port 4483" },
      }));
      await writeFile(join(root, ".codex", "config.toml"), [
        "[mcp_servers.hive]",
        'url = "http://127.0.0.1:4483/mcp"',
        "",
        "[mcp_servers.hive.tools.hive_send]",
        'approval_mode = "approve"',
        "",
      ].join("\n"));
      await writeFile(join(root, ".codex", "hive-notify.sh"),
        '#!/bin/sh\nexec hive event turn-end --agent orchestrator --port 4483 --payload "$1"\n');

      expect(await repairLeakedProjectConfig(root)).toEqual([
        ".mcp.json",
        ".claude/settings.local.json",
        ".codex/config.toml",
        ".codex/hive-notify.sh",
      ]);
      for (const path of [
        ".mcp.json",
        ".claude/settings.local.json",
        ".codex/config.toml",
        ".codex/hive-notify.sh",
      ]) expect(existsSync(join(root, path))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves user-owned config while removing exact Hive entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-config-repair-"));
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(join(root, ".mcp.json"), JSON.stringify({
        userKey: true,
        mcpServers: {
          mine: { command: "mine" },
          hive: {
            url: "http://127.0.0.1:4317/mcp",
            headersHelper: "hive credential --agent orchestrator",
          },
        },
      }));
      await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({
        customSetting: true,
        hooks: {
          Stop: [{ hooks: [
            { type: "command", command: "mine" },
            { type: "command", command: "hive event turn-end --agent orchestrator --port 4317" },
          ] }],
        },
      }));
      await writeFile(join(root, ".codex", "config.toml"), [
        "model = 'mine'",
        "[mcp_servers.hive]",
        "url = 'http://127.0.0.1:4317/mcp'",
        "[mcp_servers.mine]",
        "command = 'mine'",
        "",
      ].join("\n"));

      await repairLeakedProjectConfig(root);

      expect(await readFile(join(root, ".mcp.json"), "utf8")).toContain('"mine"');
      const settings = await readFile(join(root, ".claude", "settings.local.json"), "utf8");
      expect(settings).toContain("customSetting");
      expect(settings).toContain('"command": "mine"');
      const codex = await readFile(join(root, ".codex", "config.toml"), "utf8");
      expect(codex).toContain("model = 'mine'");
      expect(codex).toContain("[mcp_servers.mine]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not remove similarly named user servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-config-repair-"));
    try {
      await mkdir(join(root, ".codex"), { recursive: true });
      const config = "[mcp_servers.hive]\nurl = 'https://example.com/mcp'\n";
      await writeFile(join(root, ".codex", "config.toml"), config);
      expect(await repairLeakedProjectConfig(root)).toEqual([]);
      expect(await readFile(join(root, ".codex", "config.toml"), "utf8"))
        .toEqual(config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
