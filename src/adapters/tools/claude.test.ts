import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeResumeCommand,
  buildClaudeSpawnCommand,
  claudeProjectDirectory,
  detectClaudeCliVersion,
  resolveWorkingClaudeExecutable,
  claudeExecutableCandidates,
  findLatestClaudeSessionId,
  writeClaudeAgentConfig,
  claudeConfigPath,
  seedClaudeWorktreeTrust,
  CLAUDE_CHANNELS_FLAG,
  HIVE_CHANNEL_SERVER_NAME,
} from "./claude";
import { GRAPHIFY_HOOK_SCRIPT } from "./graphify-hook";

let tempRoot = "";
let worktreePath = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  // mkdtemp hands back /var/... on macOS while the real path is /private/var/...;
  // Claude keys projects by the resolved path, so resolve it up front.
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), "hive-claude-")));
  worktreePath = join(tempRoot, "worktree");
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
});

beforeEach(async () => {
  await rm(worktreePath, { recursive: true, force: true });
  await mkdir(worktreePath, { recursive: true });
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

describe("Claude adapter", () => {
  test("builds writer and read-only spawn argv", () => {
    const base = {
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
    };

    expect(buildClaudeSpawnCommand({ ...base, readOnly: false })).toEqual([
      "claude",
      "--model",
      "sonnet",
    ]);
    expect(buildClaudeSpawnCommand({ ...base, readOnly: true })).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "default",
    ]);
  });

  test("passes an explicit effort and omits an absent one", () => {
    const base = {
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    };
    expect(buildClaudeSpawnCommand({ ...base, effort: "xhigh" })).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "xhigh",
    ]);
    expect(buildClaudeSpawnCommand(base)).not.toContain("--effort");
  });

  describe("spawn-scoped MCP surface", () => {
    const base = {
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    };

    test("restricts the session to the worktree's own .mcp.json", () => {
      expect(
        buildClaudeSpawnCommand({
          ...base,
          scopedMcpConfigPath: "/tmp/worktree/.mcp.json",
        }),
      ).toEqual([
        "claude",
        "--model",
        "sonnet",
        "--mcp-config",
        "/tmp/worktree/.mcp.json",
        "--strict-mcp-config",
      ]);
    });

    test("loads Hive settings without reading project or local settings", () => {
      expect(buildClaudeSpawnCommand({
        ...base,
        scopedSettingsPath: "/home/user/.hive/runtime/orchestrator/settings.json",
      })).toEqual([
        "claude",
        "--model",
        "sonnet",
        "--settings",
        "/home/user/.hive/runtime/orchestrator/settings.json",
        "--setting-sources",
        "user",
      ]);
    });

    // `--mcp-config <configs...>` is variadic: the non-variadic
    // `--strict-mcp-config` must follow it, or the flag list swallows whatever
    // argv holds next — including Hive's positional task prompt.
    test("terminates the variadic config list with the strict flag", () => {
      const command = buildClaudeSpawnCommand({
        ...base,
        scopedMcpConfigPath: "/tmp/worktree/.mcp.json",
      });
      expect(command.indexOf("--strict-mcp-config")).toBe(
        command.indexOf("--mcp-config") + 2,
      );
      command.push("the task prompt");
      expect(command.at(-1)).toBe("the task prompt");
    });

    test("emits exactly one `--` when channels and scoping are both on", () => {
      const command = buildClaudeSpawnCommand({
        ...base,
        channels: true,
        scopedMcpConfigPath: "/tmp/worktree/.mcp.json",
      });
      // A second `--` would be read as prompt text rather than a terminator.
      expect(command.filter((argument) => argument === "--")).toHaveLength(1);
      expect(command.at(-1)).toBe("--");
      expect(command.indexOf("--mcp-config")).toBeLessThan(
        command.indexOf(CLAUDE_CHANNELS_FLAG),
      );
    });

    test("places an appended system prompt before the channels terminator", () => {
      const command = buildClaudeSpawnCommand({
        ...base,
        channels: true,
        appendSystemPrompt: "root instructions",
      });
      expect(command.indexOf("--append-system-prompt")).toBeLessThan(
        command.indexOf("--"),
      );
      expect(command[command.indexOf("--append-system-prompt") + 1]).toBe(
        "root instructions",
      );
      expect(command.at(-1)).toBe("--");
    });

    test("omits the flags entirely when no scoped config is given", () => {
      const command = buildClaudeSpawnCommand(base);
      expect(command).not.toContain("--strict-mcp-config");
      expect(command).not.toContain("--mcp-config");
      expect(command).not.toContain("--setting-sources");
      expect(command).not.toContain("--settings");
    });

    test("a resumed session keeps the same scoped surface", () => {
      const command = buildClaudeResumeCommand(
        { ...base, scopedMcpConfigPath: "/tmp/worktree/.mcp.json" },
        "session-9",
      );
      expect(command.slice(0, 3)).toEqual(["claude", "--resume", "session-9"]);
      expect(command).toContain("--strict-mcp-config");
    });
  });

  test("uses the daemon-resolved executable instead of tmux PATH", () => {
    expect(buildClaudeSpawnCommand({
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
      executable: "/home/user/.local/bin/claude",
    })).toEqual([
      "/home/user/.local/bin/claude",
      "--model",
      "sonnet",
    ]);
  });

  test("resolves the first candidate that answers --version, skipping broken shims", () => {
    const probes: string[] = [];
    const resolved = resolveWorkingClaudeExecutable(
      (executable) => {
        probes.push(executable);
        return executable === "/native/claude" ? "2.1.206" : null;
      },
      () => ["/homebrew/claude", "/native/claude", "/never/reached"],
    );
    expect(resolved).toEqual({ path: "/native/claude", version: "2.1.206" });
    expect(probes).toEqual(["/homebrew/claude", "/native/claude"]);
  });

  test("falls back to the bare command with a null version when nothing works", () => {
    expect(resolveWorkingClaudeExecutable(() => null, () => ["/broken/claude"]))
      .toEqual({ path: "claude", version: null });
    expect(resolveWorkingClaudeExecutable(() => "2.1.206", () => []))
      .toEqual({ path: "claude", version: null });
  });

  test("candidate order is PATH first, then the native-installer locations", () => {
    const candidates = claudeExecutableCandidates({
      PATH: "/definitely-missing-dir-a:/definitely-missing-dir-b",
      HOME: "/definitely-missing-home",
    });
    // Every candidate must exist on disk; none of these do.
    expect(candidates).toEqual([]);
  });

  test("omits the model flag for the account default", () => {
    expect(buildClaudeSpawnCommand({
      name: "agent-3",
      model: "default",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    })).toEqual(["claude"]);
  });

  test("builds a resume argv that replays the spawn flags with --resume", () => {
    expect(buildClaudeResumeCommand({
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    }, "0189-session")).toEqual([
      "claude",
      "--resume",
      "0189-session",
      "--model",
      "sonnet",
    ]);
  });

  test("keeps resumed session flags before the channels terminator", () => {
    const command = buildClaudeResumeCommand({
      name: "agent-3",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
      channels: true,
      appendSystemPrompt: "root instructions",
    }, "0189-session");
    expect(command.slice(0, 3)).toEqual(["claude", "--resume", "0189-session"]);
    expect(command.indexOf("--append-system-prompt")).toBeLessThan(
      command.indexOf("--"),
    );
  });

  test("derives the transcript project directory from the munged worktree path", () => {
    expect(claudeProjectDirectory("/repo/.hive/worktrees/maya", "/home/u"))
      .toEqual("/home/u/.claude/projects/-repo--hive-worktrees-maya");
  });

  test("disk discovery returns the newest transcript's session id, or null", async () => {
    const fakeHome = join(tempRoot, "claude-home");
    const projectDir = join(
      fakeHome,
      ".claude",
      "projects",
      worktreePath.replace(/[^A-Za-z0-9]/g, "-"),
    );
    expect(await findLatestClaudeSessionId(worktreePath, fakeHome)).toBeNull();

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "older-session.jsonl"), "{}\n");
    // Ensure a strictly newer mtime for the second transcript.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(projectDir, "newer-session.jsonl"), "{}\n");
    await writeFile(join(projectDir, "not-a-transcript.txt"), "ignored");

    expect(await findLatestClaudeSessionId(worktreePath, fakeHome))
      .toEqual("newer-session");
  });

  test("a dangerous writer bypasses permissions via settings, not the CLI flag", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
      dangerous: true,
    });

    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as { permissions: { defaultMode: string; allow?: string[] } };

    // bypassPermissions in settings starts the session already in bypass mode.
    // --dangerously-skip-permissions would instead raise a blocking acceptance
    // dialog that no human is there to answer (verified on claude 2.1.206),
    // so the launch argv must stay free of it.
    expect(settings.permissions.defaultMode).toEqual("bypassPermissions");
    expect(settings.permissions.allow).toBeUndefined();
    expect(
      buildClaudeSpawnCommand({
        name: "maya",
        daemonPort: 4317,
        model: "claude-opus-4-8",
        readOnly: false,
        dangerous: true,
        worktreePath,
      }),
    ).not.toContain("--dangerously-skip-permissions");
  });

  test("a read-only session ignores dangerous autonomy", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "orchestrator",
      daemonPort: 4317,
      readOnly: true,
      dangerous: true,
    });

    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as { permissions: { defaultMode: string; deny: string[] } };

    expect(settings.permissions.defaultMode).toEqual("default");
    expect(settings.permissions.deny).toContain("Write");
  });

  test("writes read-only hooks, Bash rules, and HTTP MCP registration", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "orchestrator",
      daemonPort: 4317,
      readOnly: true,
    });

    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as {
      enableAllProjectMcpServers: boolean;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
      permissions: { defaultMode: string; deny: string[]; allow: string[] };
    };
    const mcp = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headersHelper?: string }
      >;
    };

    expect(settings.permissions).toEqual({
      defaultMode: "default",
      deny: ["Edit", "Write", "NotebookEdit", "Bash"],
      allow: [
        "Read",
        "Glob",
        "Grep",
      ],
    });
    expect(settings.enableAllProjectMcpServers).toEqual(true);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toEqual(
      "hive event session-start --agent orchestrator --port 4317",
    );
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toEqual(
      "hive event turn-end --agent orchestrator --port 4317",
    );
    expect(settings.hooks.Notification?.[0]?.hooks[0]?.command).toEqual(
      "hive event notification --agent orchestrator --port 4317",
    );
    expect(mcp).toEqual({
      mcpServers: {
        hive: {
          type: "http",
          url: "http://127.0.0.1:4317/mcp",
          // The capability is fetched at connect time, never from the
          // environment, so descendants inherit no credential.
          headersHelper: "hive credential --agent orchestrator",
        },
      },
    });
  });

  test("a graphify URL becomes an http entry; its absence removes a stale one", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    const withGraph = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { type: string; url: string }> };
    const withGraphSettings = JSON.parse(
      await readFile(join(worktreePath, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks: { PreToolUse?: Array<{ matcher: string }> } };
    expect(withGraph.mcpServers.graphify).toEqual({
      type: "http",
      url: "http://127.0.0.1:7799/mcp",
    });
    expect(withGraphSettings.hooks.PreToolUse?.map((entry) => entry.matcher))
      .toEqual(["Bash", "Read|Glob"]);
    expect(
      await readFile(join(worktreePath, ".claude", GRAPHIFY_HOOK_SCRIPT), "utf8"),
    ).toContain("127.0.0.1:7799/mcp");

    // A respawn under a daemon with no healthy server must not leave the old
    // URL behind: every agent would pay a connect-timeout for a dead entry.
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
    });
    const without = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    const withoutSettings = JSON.parse(
      await readFile(join(worktreePath, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks: { PreToolUse?: unknown[] } };
    expect(without.mcpServers.graphify).toBeUndefined();
    expect(without.mcpServers.hive).toBeDefined();
    expect(withoutSettings.hooks.PreToolUse).toEqual([]);
    expect(
      readFile(join(worktreePath, ".claude", GRAPHIFY_HOOK_SCRIPT), "utf8"),
    ).rejects.toThrow();
  });

  test("deep-merges settings.local.json and .mcp.json without touching settings.json", async () => {
    const claudeDirectory = join(worktreePath, ".claude");
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(
      join(claudeDirectory, "settings.json"),
      '{"userSetting":"untouched"}\n',
    );
    await writeFile(
      join(claudeDirectory, "settings.local.json"),
      `${JSON.stringify({
        userSetting: "preserved",
        permissions: {
          userPermission: true,
          allow: ["Read", "Bash(custom:*)"],
        },
        hooks: {
          UserPromptSubmit: [{ hooks: [] }],
          SessionStart: [
            {
              hooks: [{
                type: "command",
                command: "user-session-start",
              }],
            },
            {
              hooks: [{
                type: "command",
                command: "hive event session-start --agent agent-merge --port 5000",
              }],
            },
          ],
        },
      })}\n`,
    );
    await writeFile(
      join(worktreePath, ".mcp.json"),
      `${JSON.stringify({
        projectSetting: "preserved",
        mcpServers: {
          existing: { type: "stdio", command: "existing-server" },
        },
      })}\n`,
    );

    await writeClaudeAgentConfig(worktreePath, {
      name: "agent-merge",
      daemonPort: 5000,
      readOnly: false,
    });

    const settings = JSON.parse(
      await readFile(
        join(claudeDirectory, "settings.local.json"),
        "utf8",
      ),
    ) as {
      userSetting: string;
      permissions: {
        userPermission: boolean;
        defaultMode: string;
        allow: string[];
      };
      hooks: Record<string, { hooks: { command?: string }[] }[]>;
    };
    const mcp = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as {
      projectSetting: string;
      mcpServers: Record<string, { url?: string }>;
    };

    expect(settings.userSetting).toEqual("preserved");
    expect(settings.permissions.userPermission).toEqual(true);
    expect(settings.permissions.defaultMode).toEqual("acceptEdits");
    expect(settings.permissions.allow).toEqual([
      "Read",
      "Bash(custom:*)",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(bun test:*)",
      "Bash(bun run:*)",
    ]);
    expect(
      settings.hooks.UserPromptSubmit?.map((entry) => entry.hooks[0]?.command),
    ).toEqual([
      undefined,
      "hive event turn-start --agent agent-merge --port 5000",
    ]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(
      settings.hooks.SessionStart?.map((entry) =>
        entry.hooks[0]?.command
      ),
    ).toEqual([
      "user-session-start",
      "hive event session-start --agent agent-merge --port 5000",
    ]);
    expect(mcp.projectSetting).toEqual("preserved");
    expect(mcp.mcpServers.existing).toBeDefined();
    expect(mcp.mcpServers.hive?.url).toEqual("http://127.0.0.1:5000/mcp");
    expect(
      await readFile(join(claudeDirectory, "settings.json"), "utf8"),
    ).toEqual('{"userSetting":"untouched"}\n');
  });

  test("a daemon port change re-points the turn-start hook, not just the others", async () => {
    // The 2026-07-12 incident: the config had been written under port 4317,
    // the daemon came back on 4483, and the rewrite refreshed every hook
    // except UserPromptSubmit — so the root's turn-starts posted to a dead
    // port, its open turns were invisible, and the stalled-message sweep
    // false-alarmed "idle yet never submitted" on a busy root.
    await writeClaudeAgentConfig(worktreePath, {
      name: "orchestrator",
      daemonPort: 4317,
      readOnly: true,
    });
    await writeClaudeAgentConfig(worktreePath, {
      name: "orchestrator",
      daemonPort: 4483,
      readOnly: true,
    });

    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as { hooks: Record<string, { hooks: { command?: string }[] }[]> };

    const turnStartCommands = settings.hooks.UserPromptSubmit?.map((entry) =>
      entry.hooks[0]?.command
    );
    expect(turnStartCommands).toContain(
      "hive event turn-start --agent orchestrator --port 4483",
    );
  });

  test("writes acceptEdits-style writer permissions", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "agent-3",
      daemonPort: 4317,
      readOnly: false,
    });
    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as { permissions: { defaultMode: string; allow: string[] } };

    expect(settings.permissions.defaultMode).toEqual("acceptEdits");
    expect(settings.permissions.allow.includes("Edit")).toEqual(true);
    expect(settings.permissions.allow.includes("Bash(bun test:*)")).toEqual(true);
  });

  test("registers the statusLine command that forwards subscriber quota", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
    });
    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    ) as { statusLine: { type: string; command: string } };

    expect(settings.statusLine).toEqual({
      type: "command",
      command: "hive statusline --agent maya --port 4317",
    });
  });
});

describe("Claude Channels", () => {
  test("adds the development-channels flag naming the hive bridge", () => {
    expect(buildClaudeSpawnCommand({
      name: "maya",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
      channels: true,
    })).toEqual([
      "claude",
      "--model",
      "sonnet",
      // During the research preview a `server:` entry needs the development
      // flag; hive is not an allowlisted channel plugin.
      CLAUDE_CHANNELS_FLAG,
      `server:${HIVE_CHANNEL_SERVER_NAME}`,
      "--",
    ]);
  });

  test("terminates the variadic Channels option before an appended prompt", () => {
    const command = buildClaudeSpawnCommand({
      name: "maya",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
      channels: true,
    });
    command.push("SANITIZED REVIEW PROMPT");

    expect(command.slice(-3)).toEqual([
      `server:${HIVE_CHANNEL_SERVER_NAME}`,
      "--",
      "SANITIZED REVIEW PROMPT",
    ]);
  });

  test("omits the flag entirely when channels are off", () => {
    expect(buildClaudeSpawnCommand({
      name: "maya",
      model: "sonnet",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    })).toEqual(["claude", "--model", "sonnet"]);
  });

  test("registers the stdio bridge alongside the HTTP daemon server", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
      channels: true,
    });
    const mcp = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };

    // Channels only work over stdio, so the HTTP daemon cannot push directly.
    expect(mcp.mcpServers.hive).toEqual({
      type: "http",
      url: "http://127.0.0.1:4317/mcp",
      headersHelper: "hive credential --agent maya",
    });
    expect(mcp.mcpServers[HIVE_CHANNEL_SERVER_NAME]).toEqual({
      type: "stdio",
      command: "hive",
      args: ["channel-bridge", "--agent", "maya", "--port", "4317"],
    });
  });

  test("omits the bridge server when channels are off", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
    });
    const mcp = JSON.parse(
      await readFile(join(worktreePath, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["hive"]);
  });
});

describe("detectClaudeCliVersion", () => {
  test("reads the version from `claude --version`", async () => {
    let argv: string[] = [];
    expect(
      await detectClaudeCliVersion(async (command) => {
        argv = command;
        return {
          stdout: "2.1.206 (Claude Code)\n",
          exitCode: 0,
        };
      }, "/native/claude"),
    ).toBe("2.1.206");
    expect(argv).toEqual(["/native/claude", "--version"]);
  });

  test("returns null when the CLI is missing, fails, or is unparseable", async () => {
    expect(
      await detectClaudeCliVersion(async () => ({ stdout: "", exitCode: 1 })),
    ).toBeNull();
    expect(
      await detectClaudeCliVersion(async () => ({
        stdout: "unknown",
        exitCode: 0,
      })),
    ).toBeNull();
    expect(
      await detectClaudeCliVersion(async () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("unattended launch state", () => {
  test("a dangerous writer pre-accepts the bypass-permissions disclaimer", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "maya",
      daemonPort: 4317,
      readOnly: false,
      dangerous: true,
    });
    const settings = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    );
    // Without this the CLI opens on "WARNING: Claude Code running in Bypass
    // Permissions mode" and waits for a human that is never there.
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
  });

  test("read-only and approval-queue sessions never skip the disclaimer", async () => {
    await writeClaudeAgentConfig(worktreePath, {
      name: "reader",
      daemonPort: 4317,
      readOnly: true,
    });
    const readOnly = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    );
    expect(readOnly.skipDangerousModePermissionPrompt).toBeUndefined();

    await rm(worktreePath, { recursive: true, force: true });
    await mkdir(worktreePath, { recursive: true });
    await writeClaudeAgentConfig(worktreePath, {
      name: "sandboxed",
      daemonPort: 4317,
      readOnly: false,
      dangerous: false,
    });
    const sandboxed = JSON.parse(
      await readFile(
        join(worktreePath, ".claude", "settings.local.json"),
        "utf8",
      ),
    );
    expect(sandboxed.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  test("seeds folder trust for the worktree and nothing else", async () => {
    const home = join(tempRoot, "home-scoped");
    await mkdir(home, { recursive: true });
    await seedClaudeWorktreeTrust(worktreePath, home);

    const config = JSON.parse(
      await readFile(claudeConfigPath(home), "utf8"),
    );
    expect(config.projects[worktreePath]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 1,
    });
    // Exactly one project key, and no global flag: the operator's own sessions
    // and every other repository keep their existing trust state.
    expect(Object.keys(config.projects)).toEqual([worktreePath]);
    expect(config.hasCompletedOnboarding).toBeUndefined();
    expect(config.bypassPermissionsModeAccepted).toBeUndefined();
  });

  test("preserves unrelated config and other projects", async () => {
    const home = join(tempRoot, "home-merge");
    await mkdir(home, { recursive: true });
    await writeFile(
      claudeConfigPath(home),
      JSON.stringify({
        numStartups: 42,
        oauthAccount: { emailAddress: "scott@example.com" },
        projects: {
          "/Users/scott/other": { hasTrustDialogAccepted: false, lastCost: 3 },
        },
      }),
    );

    await seedClaudeWorktreeTrust(worktreePath, home);
    const config = JSON.parse(await readFile(claudeConfigPath(home), "utf8"));

    expect(config.numStartups).toBe(42);
    expect(config.oauthAccount).toEqual({ emailAddress: "scott@example.com" });
    // A neighbouring untrusted project stays untrusted.
    expect(config.projects["/Users/scott/other"]).toEqual({
      hasTrustDialogAccepted: false,
      lastCost: 3,
    });
    expect(config.projects[worktreePath].hasTrustDialogAccepted).toBe(true);
  });

  test("keeps the worktree's own recorded state and is idempotent", async () => {
    const home = join(tempRoot, "home-idempotent");
    await mkdir(home, { recursive: true });
    await writeFile(
      claudeConfigPath(home),
      JSON.stringify({
        projects: {
          [worktreePath]: {
            lastSessionId: "session-1",
            projectOnboardingSeenCount: 5,
          },
        },
      }),
    );

    await seedClaudeWorktreeTrust(worktreePath, home);
    const first = await readFile(claudeConfigPath(home), "utf8");
    const config = JSON.parse(first);
    expect(config.projects[worktreePath]).toEqual({
      lastSessionId: "session-1",
      projectOnboardingSeenCount: 5,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });

    // Re-spawn and crash recovery re-seed the same worktree; a no-op write
    // would race the CLI's own writer for no reason.
    await seedClaudeWorktreeTrust(worktreePath, home);
    expect(await readFile(claudeConfigPath(home), "utf8")).toBe(first);
  });

  test("seeds the resolved path when the worktree is reached via a symlink", async () => {
    const home = join(tempRoot, "home-symlink");
    await mkdir(home, { recursive: true });
    const linkedRoot = join(tempRoot, "linked-root");
    await symlink(tempRoot, linkedRoot);

    // Same worktree, reached through a symlinked prefix — exactly what /tmp and
    // /var do on macOS. The CLI would look up the resolved path and miss a key
    // recorded under the symlinked one.
    await seedClaudeWorktreeTrust(join(linkedRoot, "worktree"), home);

    const config = JSON.parse(await readFile(claudeConfigPath(home), "utf8"));
    expect(Object.keys(config.projects)).toEqual([worktreePath]);
  });

  test("concurrent seeds do not lose each other", async () => {
    const home = join(tempRoot, "home-concurrent");
    await mkdir(home, { recursive: true });
    const worktrees = ["alpha", "beta", "gamma", "delta"].map((name) =>
      join(tempRoot, "concurrent", name)
    );

    await Promise.all(worktrees.map((path) => seedClaudeWorktreeTrust(path, home)));

    const config = JSON.parse(await readFile(claudeConfigPath(home), "utf8"));
    expect(Object.keys(config.projects).sort()).toEqual([...worktrees].sort());
  });
});
