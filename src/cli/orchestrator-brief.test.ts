import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATOR_BRIEF } from "./orchestrator-brief";
import { orchestratorTmuxSession } from "../daemon/tmux-sessions";
import {
  buildOrchestratorCommand,
  buildOrchestratorLaunchCommand,
  launchOrchestrator,
  prepareOrchestratorConfig,
  registerRunningOrchestratorTerminal,
} from "./orchestrator";

describe("orchestrator brief", () => {
  test("is non-empty and names every orchestration MCP tool", () => {
    expect(ORCHESTRATOR_BRIEF.trim().length).toBeGreaterThan(100);
    for (const tool of [
      "hive_spawn",
      "hive_status",
      "hive_quota_status",
      "hive_send",
      "hive_inbox",
      "hive_read_message",
      "hive_approvals",
      "hive_approve",
    ]) {
      expect(ORCHESTRATOR_BRIEF).toContain(tool);
    }
    expect(ORCHESTRATOR_BRIEF).toContain("never write");
    expect(ORCHESTRATOR_BRIEF).toContain("integrator");
    expect(ORCHESTRATOR_BRIEF).toContain("quota pressure");
    expect(ORCHESTRATOR_BRIEF).toContain("silently changing vendors");
  });

  test("makes agents land their own work and reserves integrators for escalations", () => {
    expect(ORCHESTRATOR_BRIEF).toContain("land their own finished work");
    expect(ORCHESTRATOR_BRIEF).toContain("fast-forward merge");
    expect(ORCHESTRATOR_BRIEF).toContain("do not restate it");
    expect(ORCHESTRATOR_BRIEF).toContain("stranded work");
    expect(ORCHESTRATOR_BRIEF).toContain("never merge or edit files yourself");
  });

  test("builds a read-only Claude command with the required Channels bridge", () => {
    const claude = buildOrchestratorCommand("claude", 4317);
    expect(claude).toContain("--dangerously-load-development-channels");
    expect(claude).toContain("server:hive-channel");
    expect(claude.at(-1)).toEqual(ORCHESTRATOR_BRIEF);
    expect(buildOrchestratorCommand("codex", 4317)).toEqual([
      "codex",
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
      "--sandbox",
      "read-only",
      ORCHESTRATOR_BRIEF,
    ]);
  });

  test("appends a supplied memory index to the root prompt", () => {
    const index = "Hive memory index — durable facts.\n- [repo] x (2026-06-01): note";
    expect(buildOrchestratorCommand("claude", 4317, index).at(-1)).toEqual(
      `${ORCHESTRATOR_BRIEF}\n\n${index}`,
    );
    const codexCommand = buildOrchestratorCommand("codex", 4317, index);
    expect(codexCommand.at(-1)).toEqual(`${ORCHESTRATOR_BRIEF}\n\n${index}`);
    expect(buildOrchestratorCommand("claude", 4317).at(-1)).toEqual(ORCHESTRATOR_BRIEF);
  });

  test("runs the root in the fixed attachable tmux session used for wakes", () => {
    const command = buildOrchestratorLaunchCommand("claude", 4317, "/repo");
    expect(command.slice(0, 8)).toEqual([
      "tmux",
      "new-session",
      "-A",
      "-s",
      orchestratorTmuxSession(),
      "-c",
      "/repo",
      "claude",
    ]);
    expect(command).toContain(ORCHESTRATOR_BRIEF);
  });

  test("forbids background polling and makes status explicitly on-demand", () => {
    expect(ORCHESTRATOR_BRIEF).toContain("never poll");
    expect(ORCHESTRATOR_BRIEF).toContain('detail "active"');
    expect(ORCHESTRATOR_BRIEF).toContain("only when the user explicitly");
    expect(ORCHESTRATOR_BRIEF).toContain("Wake only");
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

  test("launches when Terminal.app capture reports pgrep's no-match error", async () => {
    let spawned = false;
    const exitCode = await launchOrchestrator(
      "claude",
      4317,
      process.cwd(),
      () => {
        spawned = true;
        return { exited: Promise.resolve(0) };
      },
      async () => {
        throw new Error(
          "could not find Terminal.app window: execution error: command exited with non-zero status (1)",
        );
      },
    );
    expect(exitCode).toEqual(0);
    expect(spawned).toEqual(true);
  });

  test("re-registers the running root by its attached client's exact TTY", async () => {
    const registered: unknown[] = [];
    const handle = {
      app: "terminal",
      processId: 4242,
      windowId: 17,
      tty: "/dev/ttys003",
    } as const;

    await expect(registerRunningOrchestratorTerminal(4317, "auto", {
      listClientTtys: async (session) => {
        expect(session).toEqual(orchestratorTmuxSession());
        return ["/dev/ttys003"];
      },
      captureTerminalApp: async (tty) => {
        expect(tty).toEqual("/dev/ttys003");
        return handle;
      },
      captureITerm2: async () => null,
      register: async (port, captured) => {
        registered.push({ port, captured });
      },
    })).resolves.toEqual(handle);
    expect(registered).toEqual([{ port: 4317, captured: handle }]);
  });

  test("refuses ambiguous multi-client root registration", async () => {
    await expect(registerRunningOrchestratorTerminal(4317, "auto", {
      listClientTtys: async () => ["/dev/ttys003", "/dev/ttys004"],
      captureTerminalApp: async () => null,
      captureITerm2: async () => null,
      register: async () => {},
    })).rejects.toThrow("multiple attached terminal clients");
  });

  test("launches the orchestrator with the repo's committed memory index", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-orchestrator-memory-"));
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = await mkdtemp(
      join(tmpdir(), "hive-orchestrator-memory-home-"),
    );
    try {
      await mkdir(join(root, ".hive", "memory"), { recursive: true });
      await writeFile(
        join(root, ".hive", "memory", "flaky-login-test.md"),
        "---\ntitle: The login test is flaky\ndate: 2026-06-01\ntags: []\n---\n\nRace condition.\n",
      );

      let capturedCommand: string[] = [];
      await launchOrchestrator(
        "claude",
        4317,
        root,
        (command) => {
          capturedCommand = command;
          return { exited: Promise.resolve(0) };
        },
        async () => null,
      );

      expect(capturedCommand.at(-1)).toContain("Hive memory index");
      expect(capturedCommand.at(-1)).toContain(
        "[repo] flaky-login-test (2026-06-01): The login test is flaky",
      );
      expect(capturedCommand.at(-1)).toContain(ORCHESTRATOR_BRIEF);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
