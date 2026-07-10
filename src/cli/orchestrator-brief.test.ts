import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { orchestratorTmuxSession } from "../daemon/tmux-sessions";
import {
  buildOrchestratorCommand,
  buildOrchestratorLaunchCommand,
  buildCodexRootAuthorityCommand,
  launchOrchestrator,
  prepareFreshOrchestratorSession,
  prepareOrchestratorConfig,
  registerRunningOrchestratorTerminal,
} from "./orchestrator";

const noExistingRoot = {
  hasSession: async () => false,
  listClientTtys: async () => [],
  killSession: async () => {},
};

describe("orchestrator brief", () => {
  test("builds an authority-first Codex root command without enabling it yet", () => {
    const command = buildCodexRootAuthorityCommand("/tmp/hive-root.sock");
    expect(command.slice(0, 2)).toEqual(["sh", "-lc"]);
    expect(command[2]).toContain("codex app-server --listen unix:///tmp/hive-root.sock");
    expect(command[2]).toContain(
      "exec 'codex' '--remote' 'unix:///tmp/hive-root.sock'",
    );
  });
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
    expect(claude.at(-1)).toEqual("--");
    expect(claude.indexOf("--append-system-prompt")).toBeLessThan(
      claude.indexOf("--"),
    );
    expect(claude[claude.indexOf("--append-system-prompt") + 1]).toEqual(
      ORCHESTRATOR_BRIEF,
    );
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
    const claudeCommand = buildOrchestratorCommand("claude", 4317, index);
    expect(claudeCommand[claudeCommand.indexOf("--append-system-prompt") + 1]).toEqual(
      `${ORCHESTRATOR_BRIEF}\n\n${index}`,
    );
    const codexCommand = buildOrchestratorCommand("codex", 4317, index);
    expect(codexCommand.at(-1)).toEqual(`${ORCHESTRATOR_BRIEF}\n\n${index}`);
    const plainClaudeCommand = buildOrchestratorCommand("claude", 4317);
    expect(
      plainClaudeCommand[plainClaudeCommand.indexOf("--append-system-prompt") + 1],
    ).toEqual(ORCHESTRATOR_BRIEF);
  });

  test("starts a fresh root in the fixed instance-scoped tmux session", () => {
    const command = buildOrchestratorLaunchCommand("claude", 4317, "/repo");
    expect(command.slice(0, 7)).toEqual([
      "tmux",
      "new-session",
      "-s",
      orchestratorTmuxSession(),
      "-c",
      "/repo",
      "claude",
    ]);
    expect(command).not.toContain("-A");
    expect(command).toContain(ORCHESTRATOR_BRIEF);
  });

  test("runs Codex root through an app-server authority and remote TUI", () => {
    const memory = "Hive memory index — durable facts.\n- [repo] launch fact";
    const guidance = "DESIGN.md is the primary design doc.";
    const command = buildOrchestratorLaunchCommand(
      "codex",
      4317,
      "/repo",
      memory,
      guidance,
    );
    expect(command.slice(0, 7)).toEqual([
      "tmux", "new-session", "-s", orchestratorTmuxSession(), "-c", "/repo", "sh",
    ]);
    const shellCommand = command.at(-1)!;
    expect(shellCommand).toContain("codex app-server --listen unix://");
    expect(shellCommand).toContain("'codex' '--remote' 'unix://");
    expect(shellCommand).toContain("mcp_servers.hive.url=");
    expect(shellCommand).toContain("'--sandbox' 'read-only'");
    expect(shellCommand).toContain(ORCHESTRATOR_BRIEF.slice(0, 80));
    expect(shellCommand).toContain(guidance);
    expect(shellCommand).toContain(memory);
  });

  test("Codex launch does not resolve or version-gate Claude", async () => {
    let command: string[] = [];
    const exitCode = await launchOrchestrator(
      "codex",
      4317,
      process.cwd(),
      (spawned) => {
        command = spawned;
        return { exited: Promise.resolve(0) };
      },
      async () => null,
      async () => { throw new Error("must not inspect Claude"); },
      () => { throw new Error("must not resolve Claude"); },
      noExistingRoot,
    );
    expect(exitCode).toEqual(0);
    expect(command.at(-1)).toContain(ORCHESTRATOR_BRIEF.slice(0, 80));
  });

  test("kills an unattached stale root before launch", async () => {
    const killed: string[] = [];
    await prepareFreshOrchestratorSession({
      hasSession: async () => true,
      listClientTtys: async () => [],
      killSession: async (session) => { killed.push(session); },
    });
    expect(killed).toEqual([orchestratorTmuxSession()]);
  });

  test("refuses to replace a root with an attached client", async () => {
    let killed = false;
    await expect(prepareFreshOrchestratorSession({
      hasSession: async () => true,
      listClientTtys: async () => ["/dev/ttys003"],
      killSession: async () => { killed = true; },
    })).rejects.toThrow("already active");
    expect(killed).toEqual(false);
  });

  test("forbids background polling and makes status explicitly on-demand", () => {
    expect(ORCHESTRATOR_BRIEF).toContain("never poll");
    expect(ORCHESTRATOR_BRIEF).toContain('detail "active"');
    expect(ORCHESTRATOR_BRIEF).toContain("only when the user explicitly");
    expect(ORCHESTRATOR_BRIEF).toContain("Wake only");
  });

  test("makes reusing a live agent the default over respawning", () => {
    expect(ORCHESTRATOR_BRIEF).toContain(
      "Prefer a follow-up to a live agent over a new spawn",
    );
    expect(ORCHESTRATOR_BRIEF).toContain("re-reads the repo from zero");
    // The reuse test is the two facts hive_status already reports, so no
    // second source of truth about reusability can go stale.
    expect(ORCHESTRATOR_BRIEF).toContain("contextPct is under 65");
    expect(ORCHESTRATOR_BRIEF).toContain("file scopes would collide");
  });

  test("tells the orchestrator to cite doc sections rather than whole docs", () => {
    expect(ORCHESTRATOR_BRIEF).toContain("file:line pointers");
    expect(ORCHESTRATOR_BRIEF).toContain(
      "never tell an agent to read a document whole",
    );
    // The rule is generic: no hive-repo-specific doc name is compiled into the
    // brief. The actual doc names are fed from the profile at launch.
    expect(ORCHESTRATOR_BRIEF).not.toContain("SPEC");
    expect(ORCHESTRATOR_BRIEF).not.toContain("docs/research");
    expect(ORCHESTRATOR_BRIEF).toContain("Cite this repo's own documents by the names listed below");
  });

  describe("orchestratorDocGuidance (profile-fed at launch)", () => {
    test("names this repo's primary and load-bearing docs, whatever they are", () => {
      const guidance = orchestratorDocGuidance({
        primary: "DESIGN.md",
        loadBearing: ["DESIGN.md", "README.md", "docs/api.md"],
      });
      expect(guidance).toContain("DESIGN.md is the primary design doc");
      expect(guidance).toContain('a bare "DESIGN §6" resolves to it');
      expect(guidance).toContain("- README.md");
      expect(guidance).toContain("- docs/api.md");
      // The primary is listed once (as primary), not repeated in the plain list.
      expect(guidance.match(/DESIGN\.md/g)!.length).toBe(1);
    });

    test("a repo with no profiled docs contributes nothing", () => {
      expect(orchestratorDocGuidance({ primary: null, loadBearing: [] })).toBe("");
    });

    test("is appended to the brief in the launched command", () => {
      const command = buildOrchestratorCommand(
        "claude",
        4317,
        "",
        orchestratorDocGuidance({ primary: "SPEC.md", loadBearing: ["SPEC.md"] }),
      );
      const prompt = command[command.indexOf("--append-system-prompt") + 1];
      expect(prompt).toContain(ORCHESTRATOR_BRIEF);
      expect(prompt).toContain("SPEC.md is the primary design doc");
    });
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
        async () => null,
        async () => "2.1.80",
        undefined,
        noExistingRoot,
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
        async () => null,
        async () => "2.1.80",
        undefined,
        noExistingRoot,
      )).rejects.toThrow("claude failed");

      expect(existsSync(settingsPath)).toEqual(false);
      expect(existsSync(mcpPath)).toEqual(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to launch without a Channels-capable Claude CLI", async () => {
    await expect(launchOrchestrator(
      "claude",
      4317,
      process.cwd(),
      () => {
        throw new Error("must not spawn");
      },
      async () => null,
      async () => null,
    )).rejects.toThrow("requires Claude Channels");
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
      async () => "2.1.80",
      undefined,
      noExistingRoot,
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
        async () => "2.1.80",
        undefined,
        noExistingRoot,
      );

      const prompt = capturedCommand[
        capturedCommand.indexOf("--append-system-prompt") + 1
      ];
      expect(prompt).toContain("Hive memory index");
      expect(prompt).toContain(
        "[repo] flaky-login-test (2026-06-01): The login test is flaky",
      );
      expect(prompt).toContain(ORCHESTRATOR_BRIEF);
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
