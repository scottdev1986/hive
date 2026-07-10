import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLatestCodexSessionId,
  codexSessionsDirectory,
  buildCodexResumeCommand,
  buildCodexSpawnCommand,
  buildCodexTrustArgs,
  CODEX_NOTIFY_SCRIPT,
  writeCodexAgentConfig,
} from "./codex";

let tempRoot = "";
let worktreePath = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-codex-"));
  worktreePath = join(tempRoot, "worktree");
  await mkdir(worktreePath, { recursive: true });
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
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

describe("Codex adapter", () => {
  test("builds writer and read-only spawn argv", () => {
    const base = {
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
    };

    expect(buildCodexSpawnCommand({ ...base, readOnly: false })).toEqual([
      "codex",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'projects."/tmp/worktree".trust_level="trusted"',
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
      "-c",
      'notify=["/tmp/worktree/.codex/hive-notify.sh"]',
    ]);
    expect(buildCodexSpawnCommand({ ...base, readOnly: true })).toEqual([
      "codex",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "--sandbox",
      "read-only",
      "-c",
      'projects."/tmp/worktree".trust_level="trusted"',
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
      "-c",
      'notify=["/tmp/worktree/.codex/hive-notify.sh"]',
    ]);
  });

  test("builds trusted-project and TOML notify CLI overrides", () => {
    expect(buildCodexTrustArgs("/tmp/work tree")).toEqual([
      "-c",
      'projects."/tmp/work tree".trust_level="trusted"',
    ]);

    const command = buildCodexSpawnCommand({
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high",
      worktreePath: "/tmp/work tree",
      daemonPort: 4317,
      readOnly: false,
    });
    const notifyOverride = command.at(-1);
    expect(notifyOverride).toBeDefined();
    expect(Bun.TOML.parse(notifyOverride ?? "")).toEqual({
      notify: ["/tmp/work tree/.codex/hive-notify.sh"],
    });
    const mcpOverride = command.find((argument) =>
      argument.startsWith("mcp_servers.hive.url=")
    );
    expect(mcpOverride).toBeDefined();
    expect(Bun.TOML.parse(mcpOverride ?? "")).toEqual({
      mcp_servers: {
        hive: { url: "http://127.0.0.1:4317/mcp" },
      },
    });
  });

  test("builds a resume argv that replays the spawn overrides as `codex resume`", () => {
    expect(buildCodexResumeCommand({
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    }, "019f-thread")).toEqual([
      "codex",
      "resume",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'projects."/tmp/worktree".trust_level="trusted"',
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
      "-c",
      'notify=["/tmp/worktree/.codex/hive-notify.sh"]',
      "019f-thread",
    ]);
  });

  test("a read-only resume expresses the sandbox as a config override, not --sandbox", () => {
    const command = buildCodexResumeCommand({
      name: "agent-4",
      model: "default",
      effort: "medium" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: true,
    }, "019f-thread");
    expect(command).not.toContain("--sandbox");
    expect(command).toContain('sandbox_mode="read-only"');
  });

  test("rollout disk discovery matches session_meta cwd and prefers the newest file", async () => {
    const fakeHome = join(tempRoot, "codex-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "10");
    await mkdir(dayDir, { recursive: true });
    const meta = (sessionId: string, cwd: string): string =>
      `${JSON.stringify({
        timestamp: "2026-07-10T09:00:00.000Z",
        type: "session_meta",
        payload: { session_id: sessionId, id: sessionId, cwd },
      })}\n`;
    await writeFile(
      join(dayDir, "rollout-2026-07-10T08-00-00-other.jsonl"),
      meta("other-session", "/somewhere/else"),
    );
    await writeFile(
      join(dayDir, "rollout-2026-07-10T08-30-00-older.jsonl"),
      meta("older-match", worktreePath),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(
      join(dayDir, "rollout-2026-07-10T09-00-00-newer.jsonl"),
      meta("newer-match", worktreePath),
    );

    expect(await findLatestCodexSessionId(worktreePath, fakeHome))
      .toEqual("newer-match");
    expect(await findLatestCodexSessionId("/no/such/worktree", fakeHome))
      .toBeNull();
    expect(
      await findLatestCodexSessionId(worktreePath, join(tempRoot, "missing")),
    ).toBeNull();
  });

  test("omits the model override for the account default", () => {
    const command = buildCodexSpawnCommand({
      name: "agent-4",
      model: "default",
      effort: "low",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    });

    expect(command).not.toContain("model=default");
    expect(command).toContain("model_reasoning_effort=low");
  });

  test("writes notify wrapper and streamable HTTP MCP config", async () => {
    await writeCodexAgentConfig(worktreePath, {
      name: "agent-4",
      daemonPort: 4317,
      readOnly: false,
    });

    const configSource = await readFile(
      join(worktreePath, ".codex", "config.toml"),
      "utf8",
    );
    const config = Bun.TOML.parse(configSource) as {
      notify?: string[];
      mcp_servers: Record<string, { url: string }>;
    };
    const notifyPath = join(worktreePath, ".codex", CODEX_NOTIFY_SCRIPT);
    const script = await readFile(notifyPath, "utf8");

    expect(config.notify).toBeUndefined();
    expect(configSource.includes("notify")).toEqual(false);
    expect(config.mcp_servers.hive?.url).toEqual(
      "http://127.0.0.1:4317/mcp",
    );
    expect(script.startsWith("#!/bin/sh\n")).toEqual(true);
    expect(
      script.includes(
        'exec hive event turn-end --agent agent-4 --port 4317 --payload "$1"',
      ),
    ).toEqual(true);
  });
});
