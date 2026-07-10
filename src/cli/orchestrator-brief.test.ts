import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATOR_BRIEF } from "./orchestrator-brief";
import {
  buildOrchestratorCommand,
  launchOrchestrator,
  prepareOrchestratorConfig,
} from "./orchestrator";

describe("orchestrator brief", () => {
  test("is non-empty and names every orchestration MCP tool", () => {
    expect(ORCHESTRATOR_BRIEF.trim().length).toBeGreaterThan(100);
    for (const tool of [
      "hive_spawn",
      "hive_status",
      "hive_send",
      "hive_inbox",
      "hive_approvals",
      "hive_approve",
    ]) {
      expect(ORCHESTRATOR_BRIEF).toContain(tool);
    }
    expect(ORCHESTRATOR_BRIEF).toContain("never write");
    expect(ORCHESTRATOR_BRIEF).toContain("integrator");
  });

  test("builds read-only foreground commands for both tools", () => {
    expect(buildOrchestratorCommand("claude", 4317)).toEqual([
      "claude",
      "--append-system-prompt",
      ORCHESTRATOR_BRIEF,
    ]);
    expect(buildOrchestratorCommand("codex", 4317)).toEqual([
      "codex",
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
      "--sandbox",
      "read-only",
      ORCHESTRATOR_BRIEF,
    ]);
  });

  test("preserves an existing Codex project config while preparing MCP overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-orchestrator-"));
    const codexDirectory = join(root, ".codex");
    const existing = '[features]\ncustom = true\n';
    try {
      await mkdir(codexDirectory, { recursive: true });
      await writeFile(join(codexDirectory, "config.toml"), existing);
      await prepareOrchestratorConfig("codex", 4317, root);

      expect(await readFile(join(codexDirectory, "config.toml"), "utf8"))
        .toEqual(existing);
      expect(await readFile(
        join(codexDirectory, "hive-notify.sh"),
        "utf8",
      )).toContain("hive event turn-end");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores existing Claude project config after the process exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-orchestrator-"));
    const settingsPath = join(root, ".claude", "settings.local.json");
    const mcpPath = join(root, ".mcp.json");
    const existingSettings = '{"customSetting":true}\n';
    const existingMcp = '{"mcpServers":{"custom":{"command":"custom"}}}\n';
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(settingsPath, existingSettings);
      await writeFile(mcpPath, existingMcp);

      const exitCode = await launchOrchestrator(
        "claude",
        4317,
        root,
        () => {
          expect(readFileSync(settingsPath, "utf8")).toContain(
            "enableAllProjectMcpServers",
          );
          expect(readFileSync(mcpPath, "utf8")).toContain(
            "http://127.0.0.1:4317/mcp",
          );
          return { exited: Promise.resolve(17) };
        },
      );

      expect(exitCode).toEqual(17);
      expect(await readFile(settingsPath, "utf8")).toEqual(existingSettings);
      expect(await readFile(mcpPath, "utf8")).toEqual(existingMcp);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes temporary Claude project config when process exit rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-orchestrator-"));
    const settingsPath = join(root, ".claude", "settings.local.json");
    const mcpPath = join(root, ".mcp.json");
    try {
      await expect(launchOrchestrator(
        "claude",
        4317,
        root,
        () => ({ exited: Promise.reject(new Error("claude failed")) }),
      )).rejects.toThrow("claude failed");

      expect(existsSync(settingsPath)).toEqual(false);
      expect(existsSync(mcpPath)).toEqual(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
