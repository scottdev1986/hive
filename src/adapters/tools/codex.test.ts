import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

describe("Codex spawn-scoped MCP surface", () => {
  const base = {
    name: "agent-4",
    model: "gpt-5.6-terra",
    effort: "medium" as const,
    worktreePath: "/tmp/worktree",
    daemonPort: 4317,
    readOnly: false,
  };

  test("detaches each inherited server for this process only", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      excludeMcpServers: ["idea", "openaiDeveloperDocs"],
    });
    expect(command).toContain("mcp_servers.idea.enabled=false");
    expect(command).toContain("mcp_servers.openaiDeveloperDocs.enabled=false");
    // Hive's own server is still attached, and by URL, not by inheritance.
    expect(command).toContain('mcp_servers.hive.url="http://127.0.0.1:4317/mcp"');
    expect(command).not.toContain("mcp_servers.hive.enabled=false");
  });

  test("changes nothing when the user has no servers of their own", () => {
    expect(buildCodexSpawnCommand({ ...base, excludeMcpServers: [] })).toEqual(
      buildCodexSpawnCommand(base),
    );
  });

  test("never detaches Hive's own servers even if asked", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      excludeMcpServers: ["hive", "hive-channel", "idea"],
    });
    expect(command.join(" ")).not.toContain("mcp_servers.hive.enabled=false");
    expect(command.join(" ")).not.toContain(
      "mcp_servers.hive-channel.enabled=false",
    );
    expect(command).toContain("mcp_servers.idea.enabled=false");
  });

  // codex-cli 0.144.0 cannot address a quoted key through `-c`; emitting the
  // override would make the CLI refuse to load its config at all.
  test("leaves an unaddressable server name attached", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      excludeMcpServers: ["odd.name"],
    });
    expect(command.join(" ")).not.toContain("odd.name");
  });

  test("a resumed session keeps the same scoped surface", () => {
    const command = buildCodexResumeCommand(
      { ...base, excludeMcpServers: ["idea"] },
      "session-7",
    );
    expect(command).toContain("mcp_servers.idea.enabled=false");
    expect(command.at(-1)).toBe("session-7");
  });
});

// The lifecycle hooks must ride the command line: codex only loads a
// project-local `.codex/config.toml` when the directory's trust is persisted
// in the user's own config file, and Hive passes trust as a `-c` override
// precisely so it never edits that file (verified against codex 0.144.1).
const expectedHookOverrides = (worktreePath: string): string[] =>
  [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "turn-start"],
    ["PostToolUse", "tool-boundary"],
    ["Stop", "turn-end"],
  ].flatMap(([event, kind]) => [
    "-c",
    `hooks.${event}=[{hooks=[{type="command",command="${worktreePath}/.codex/${CODEX_NOTIFY_SCRIPT} ${kind}",timeout=5}]}]`,
  ]);

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
      "--dangerously-bypass-hook-trust",
      "-c",
      "features.hooks=true",
      ...expectedHookOverrides("/tmp/worktree"),
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
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
      "--dangerously-bypass-hook-trust",
      "-c",
      "features.hooks=true",
      ...expectedHookOverrides("/tmp/worktree"),
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
    ]);
  });

  test("a dangerous writer needs no approvals and no sandbox; read-only still wins", () => {
    const base = {
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
    };

    const dangerous = buildCodexSpawnCommand({
      ...base,
      readOnly: false,
      dangerous: true,
    });
    expect(dangerous).toContain('sandbox_mode="danger-full-access"');
    expect(dangerous).toContain('approval_policy="never"');
    expect(dangerous).not.toContain('approval_policy="on-request"');
    // The resume path replays the same posture, so a crash-recovered agent
    // does not silently stall on a prompt nobody is watching.
    expect(
      buildCodexResumeCommand({ ...base, readOnly: false, dangerous: true }, "s1"),
    ).toContain('approval_policy="never"');

    // Read-only sessions (the orchestrator, control restarts) ignore autonomy.
    const readOnly = buildCodexSpawnCommand({
      ...base,
      readOnly: true,
      dangerous: true,
    });
    expect(readOnly).toContain("read-only");
    expect(readOnly).not.toContain('sandbox_mode="danger-full-access"');
    expect(readOnly).not.toContain('approval_policy="never"');
  });

  test("builds trusted-project, native-hook, and MCP CLI overrides", () => {
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
    expect(command).toContain("--dangerously-bypass-hook-trust");
    expect(command).toContain("features.hooks=true");
    expect(command.join(" ")).not.toContain("notify=");
    const mcpOverride = command.find((argument) =>
      argument.startsWith("mcp_servers.hive.url=")
    );
    expect(mcpOverride).toBeDefined();
    expect(Bun.TOML.parse(mcpOverride ?? "")).toEqual({
      mcp_servers: {
        hive: { url: "http://127.0.0.1:4317/mcp" },
      },
    });

    // Each hook override is one `-c key=value` whose value is valid inline
    // TOML addressing the notify script; codex parses it exactly like a
    // config-file hook table.
    const hookOverride = command.find((argument) =>
      argument.startsWith("hooks.SessionStart=")
    );
    expect(hookOverride).toBeDefined();
    expect(Bun.TOML.parse(hookOverride ?? "")).toEqual({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: "command",
            command:
              `/tmp/work tree/.codex/${CODEX_NOTIFY_SCRIPT} session-start`,
            timeout: 5,
          }],
        }],
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
      "--dangerously-bypass-hook-trust",
      "-c",
      "features.hooks=true",
      ...expectedHookOverrides("/tmp/worktree"),
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
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

  test("writes the notify script and MCP config, but no hook tables", async () => {
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
      mcp_servers: Record<string, { url: string }>;
    };
    const notifyPath = join(worktreePath, ".codex", CODEX_NOTIFY_SCRIPT);
    const script = await readFile(notifyPath, "utf8");

    expect(configSource.includes("notify =")).toEqual(false);
    // Hooks live on the spawn command line, never in this file: codex only
    // loads project-local config for directories whose trust is persisted in
    // the user's own config, so a hook defined here would silently not fire —
    // and would double-fire if that file ever did load.
    expect(configSource.includes("hooks")).toEqual(false);
    expect(config.mcp_servers.hive?.url).toEqual(
      "http://127.0.0.1:4317/mcp",
    );
    expect(script.startsWith("#!/bin/sh\n")).toEqual(true);
    expect(
      script.includes(
        'exec hive event "$1" --agent agent-4 --port 4317',
      ),
    ).toEqual(true);
  });
  test("carries the agent capability as a static header in a 0600 config", async () => {
    // Codex has no connect-time headers helper, so its token has to sit in a
    // file. It must never land in `bearer_token_env_var`: an environment
    // variable is inherited by every descendant of the agent's process.
    await writeCodexAgentConfig(worktreePath, {
      daemonPort: 4317,
      name: "maya",
      readOnly: false,
      capabilityToken: "hv1.abc.secret-token",
    });
    const configPath = join(worktreePath, ".codex", "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("[mcp_servers.hive.http_headers]");
    expect(config).toContain('Authorization = "Bearer hv1.abc.secret-token"');
    expect(config).not.toContain("bearer_token_env_var");
    expect((await stat(configPath)).mode & 0o777).toEqual(0o600);
  });

  test("omits the header entirely when no capability was issued", async () => {
    await writeCodexAgentConfig(worktreePath, {
      daemonPort: 4317,
      name: "maya",
      readOnly: false,
    });
    const config = await readFile(
      join(worktreePath, ".codex", "config.toml"),
      "utf8",
    );
    expect(config).not.toContain("http_headers");
    expect(config).not.toContain("Authorization");
  });
});
