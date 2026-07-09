import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "./claude";

let tempRoot = "";
let worktreePath = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-claude-"));
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
      mcpServers: Record<string, { type: string; url: string }>;
    };

    expect(settings.permissions).toEqual({
      defaultMode: "default",
      deny: ["Edit", "Write", "NotebookEdit", "Bash"],
      allow: [
        "Read",
        "Glob",
        "Grep",
        "Bash(git status:*)",
        "Bash(git log:*)",
        "Bash(git diff:*)",
        "Bash(ls:*)",
        "Bash(cat:*)",
        "Bash(rg:*)",
        "Bash(grep:*)",
        "Bash(find:*)",
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
        },
      },
    });
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
        permissions: { userPermission: true },
        hooks: { UserPromptSubmit: [{ hooks: [] }] },
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
      permissions: { userPermission: boolean; defaultMode: string };
      hooks: Record<string, unknown>;
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
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [] }]);
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(mcp.projectSetting).toEqual("preserved");
    expect(mcp.mcpServers.existing).toBeDefined();
    expect(mcp.mcpServers.hive?.url).toEqual("http://127.0.0.1:5000/mcp");
    expect(
      await readFile(join(claudeDirectory, "settings.json"), "utf8"),
    ).toEqual('{"userSetting":"untouched"}\n');
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
});
