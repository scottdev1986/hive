import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodexRecoverySessionId,
  findCodexRolloutBySessionId,
  findCodexRolloutForProcess,
  findLatestCodexSessionId,
  codexCapabilityTokenPath,
  codexSessionsDirectory,
  buildCodexResumeCommand,
  buildCodexResumeOptions,
  buildCodexSpawnCommand,
  buildCodexTrustArgs,
  CODEX_CAPABILITY_TOKEN_ENV,
  CODEX_NOTIFY_SCRIPT,
  codexCompatibilityRefusal,
  parseCodexCliVersion,
  wrapCodexSpawnWithCapabilityEnv,
  writeCodexAgentConfig,
} from "./codex";
import { GRAPHIFY_HOOK_SCRIPT } from "./graphify-hook";
import { CODEX_WRITER_CONTAINMENT_REASON } from "../../daemon/codex-containment";

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
    readOnly: true,
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

  test("disables Codex Apps for the process without touching user config", () => {
    const command = buildCodexSpawnCommand(base);
    expect(command).toContain("features.apps=false");
  });

  test("disables Codex-internal subagents so children get no implicit authority", () => {
    const command = buildCodexSpawnCommand(base);
    expect(command).toContain("features.multi_agent=false");
  });

  test("changes nothing when the user has no servers of their own", () => {
    expect(buildCodexSpawnCommand({ ...base, excludeMcpServers: [] })).toEqual(
      buildCodexSpawnCommand(base),
    );
  });

  test("never detaches Hive's own server even if asked", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      excludeMcpServers: ["hive", "legacy", "idea"],
    });
    expect(command.join(" ")).not.toContain("mcp_servers.hive.enabled=false");
    expect(command.join(" ")).toContain("mcp_servers.legacy.enabled=false");
    expect(command).toContain("mcp_servers.idea.enabled=false");
  });

  test("attaches graphify by URL and keeps a same-named inherited server enabled", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
      excludeMcpServers: ["graphify", "idea"],
    });
    expect(command).toContain('mcp_servers.graphify.url="http://127.0.0.1:7799/mcp"');
    expect(command.join(" ")).toContain("hooks.PreToolUse=");
    expect(command.join(" ")).toContain(`${GRAPHIFY_HOOK_SCRIPT} codex`);
    // The exclusion pass must not disable the entry whose url we just claimed.
    expect(command.join(" ")).not.toContain("mcp_servers.graphify.enabled=false");
    expect(command).toContain("mcp_servers.idea.enabled=false");
  });

  test("full autonomy pre-approves only Hive-owned MCP tools", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      dangerous: true,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
      excludeMcpServers: ["idea"],
    });
    expect(command).toContain(
      'mcp_servers.hive.default_tools_approval_mode="approve"',
    );
    expect(command).toContain(
      'mcp_servers.graphify.default_tools_approval_mode="approve"',
    );
    expect(command.join(" ")).not.toContain(
      "mcp_servers.idea.default_tools_approval_mode",
    );

    const sandboxed = buildCodexSpawnCommand({
      ...base,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    expect(sandboxed.join(" ")).not.toContain("default_tools_approval_mode");
  });

  test("without a graphify URL there is no graphify entry, and an inherited one is detached", () => {
    const command = buildCodexSpawnCommand({
      ...base,
      excludeMcpServers: ["graphify"],
    });
    expect(command.join(" ")).not.toContain("mcp_servers.graphify.url");
    expect(command).toContain("mcp_servers.graphify.enabled=false");
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
    const options = { ...base, excludeMcpServers: ["idea"] };
    const resumeOptions = buildCodexResumeOptions(options);
    const command = buildCodexResumeCommand(options, "session-7");
    expect(command).toContain("mcp_servers.idea.enabled=false");
    expect(resumeOptions).toEqual(command.slice(0, -1));
    expect(resumeOptions).not.toContain("session-7");
    expect(command.at(-1)).toBe("session-7");
  });
});

// The lifecycle hooks must ride the command line: codex only loads a
// project-local `.codex/config.toml` when the directory's trust is persisted
// in the user's own config file, and Hive passes trust as a `-c` override
// precisely so it never edits that file (verified against codex 0.144.1).
const expectedHookOverrides = (
  worktreePath: string,
  _options: { readOnly?: boolean } = {},
): string[] =>
  [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "turn-start"],
    ["PostToolUse", "tool-boundary"],
    ["Stop", "turn-end"],
  ].flatMap(([event, kind]) => [
    "-c",
    `hooks.${event}=[{hooks=[{type="command",command="${worktreePath}/.codex/${CODEX_NOTIFY_SCRIPT} ${kind}",timeout=5}]}]`,
  ]);
  // No PreToolUse identity guard: Codex 0.144.4 hooks fail open / are
  // writer-tamperable, so writers are refused at launch instead.

describe("Codex adapter", () => {
  test.each([
    ["codex-cli 0.144.4", true],
    ["codex-cli 0.144.5", true],
    ["codex-cli 0.145.0", true],
    ["codex-cli 1.0.0", true],
    ["codex-cli 0.144.10", true],
    ["codex-cli 0.144.3", false],
    ["codex-cli 0.143.99", false],
    ["codex-cli 0.144.4-alpha.1", false],
    ["codex-cli 0.144.4+build.7", true],
  ])("gates installed version output %s", (output, accepted) => {
    const parsed = parseCodexCliVersion(output);
    expect(parsed).not.toBeNull();
    expect(codexCompatibilityRefusal(parsed!.version) === null).toBe(accepted);
  });

  test.each(["unknown", "", "codex-cli nope", "0.144.4"])(
    "fails closed on unreadable version output %j",
    (output) => {
      expect(parseCodexCliVersion(output)).toBeNull();
      expect(codexCompatibilityRefusal(null)).toContain(
        "could not determine the Codex CLI version",
      );
    },
  );

  test("builds only read-only spawn argv", () => {
    const base = {
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
    };

    expect(buildCodexSpawnCommand({ ...base, readOnly: true })).toEqual([
      "codex",
      "-c",
      "features.apps=false",
      "-c",
      "features.multi_agent=false",
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
      ...expectedHookOverrides("/tmp/worktree", { readOnly: true }),
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
    ]);
  });

  test("refuses writer argv and config at the adapter boundary", async () => {
    const writer = {
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    };
    expect(() => buildCodexSpawnCommand(writer)).toThrow(
      CODEX_WRITER_CONTAINMENT_REASON,
    );
    expect(() => buildCodexResumeCommand(writer, "legacy-session")).toThrow(
      CODEX_WRITER_CONTAINMENT_REASON,
    );
    await expect(writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      name: writer.name,
      daemonPort: writer.daemonPort,
      readOnly: false,
    })).rejects.toThrow(CODEX_WRITER_CONTAINMENT_REASON);
  });

  test("full autonomy removes prompts without weakening a read-only sandbox", () => {
    const base = {
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
    };

    const readOnly = buildCodexSpawnCommand({
      ...base,
      readOnly: true,
      dangerous: true,
    });
    expect(readOnly).toContain("read-only");
    expect(readOnly).not.toContain('sandbox_mode="danger-full-access"');
    expect(readOnly).toContain('approval_policy="never"');
    expect(readOnly).not.toContain('approval_policy="on-request"');

    const resumedReader = buildCodexResumeCommand({
      ...base,
      readOnly: true,
      dangerous: true,
    }, "reader-session");
    expect(resumedReader).toContain('sandbox_mode="read-only"');
    expect(resumedReader).toContain('approval_policy="never"');
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
      readOnly: true,
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

  test("builds a reader resume argv that replays the spawn overrides", () => {
    expect(buildCodexResumeCommand({
      name: "agent-4",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: true,
    }, "019f-thread")).toEqual([
      "codex",
      "resume",
      "-c",
      "features.apps=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'projects."/tmp/worktree".trust_level="trusted"',
      "--dangerously-bypass-hook-trust",
      "-c",
      "features.hooks=true",
      ...expectedHookOverrides("/tmp/worktree", { readOnly: true }),
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
        payload: { session_id: sessionId, id: sessionId, cwd, source: "cli" },
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

  test("rollout disk discovery reads session_meta lines larger than 8 KiB", async () => {
    const fakeHome = join(tempRoot, "large-meta-codex-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "11");
    await mkdir(dayDir, { recursive: true });
    const firstLine = JSON.stringify({
      timestamp: "2026-07-11T09:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "large-meta-session",
        cwd: worktreePath,
        source: "cli",
        base_instructions: "x".repeat(17_000),
      },
    });
    expect(Buffer.byteLength(firstLine)).toBeGreaterThan(8192);
    await writeFile(
      join(dayDir, "rollout-2026-07-11T09-00-00-large.jsonl"),
      `${firstLine}\n`,
    );

    expect(await findLatestCodexSessionId(worktreePath, fakeHome))
      .toEqual("large-meta-session");
  });

  test("process binding excludes predecessors; earliest-after-start is a DISPLAY-GRADE pick that a same-cwd child can win", async () => {
    const fakeHome = join(tempRoot, "process-bound-codex-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "15");
    await mkdir(dayDir, { recursive: true });
    const meta = (id: string, timestamp: string) => `${JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id,
        cwd: worktreePath,
        source: "cli",
        agent_nickname: "maya",
      },
    })}\n`;
    // A dead predecessor in the reused worktree: created BEFORE this process
    // started, so it can never be observed as this process's session.
    await writeFile(
      join(dayDir, "rollout-predecessor.jsonl"),
      meta("predecessor", "2026-07-15T17:59:59.000Z"),
    );
    // KNOWN AMBIGUITY, encoded on purpose: a same-cwd child session created
    // just before the parent's rollout wins the earliest-after-start pick.
    // 0.144.4 metadata has no PID/nonce to tell them apart, which is exactly
    // why this result is display-grade observation and never authority.
    await writeFile(
      join(dayDir, "rollout-child.jsonl"),
      meta("child", "2026-07-15T18:00:00.100Z"),
    );
    await writeFile(
      join(dayDir, "rollout-parent.jsonl"),
      meta("parent", "2026-07-15T18:00:00.200Z"),
    );

    expect((await findCodexRolloutForProcess(
      worktreePath,
      "2026-07-15T18:00:00.000Z",
      fakeHome,
    ))?.sessionId).toBe("child");

    // A process started after every rollout observes nothing rather than
    // inheriting a predecessor.
    expect(await findCodexRolloutForProcess(
      worktreePath,
      "2026-07-15T19:00:00.000Z",
      fakeHome,
    )).toBeNull();
  });

  test("exact session-id lookup survives 100+ newer rollouts (filename index, meta verified)", async () => {
    const fakeHome = join(tempRoot, "indexed-lookup-codex-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "15");
    await mkdir(dayDir, { recursive: true });
    const meta = (id: string, cwd: string) => `${JSON.stringify({
      timestamp: "2026-07-15T18:00:00.000Z",
      type: "session_meta",
      payload: { id, cwd, source: "cli" },
    })}\n`;
    const wanted = "019f0000-0000-0000-0000-00000000aaaa";
    await writeFile(
      join(dayDir, `rollout-2026-07-15T18-00-00-${wanted}.jsonl`),
      meta(wanted, worktreePath),
    );
    // 110 newer sessions from other work push the wanted one far out of any
    // newest-N window; a live-but-idle agent must not go absent for it.
    for (let index = 0; index < 110; index++) {
      const id = `019f0000-0000-0000-0000-${String(index).padStart(12, "0")}`;
      await writeFile(
        join(dayDir, `rollout-2026-07-15T19-00-00-${id}.jsonl`),
        meta(id, "/somewhere/else"),
      );
    }

    expect((await findCodexRolloutBySessionId(
      worktreePath,
      wanted,
      fakeHome,
    ))?.sessionId).toBe(wanted);
  });

  test("refuses a session_meta record whose session id key is unknown", async () => {
    const fakeHome = join(tempRoot, "drifted-meta-codex-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "11");
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, "rollout-2026-07-11T10-00-00-drifted.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "session_meta",
        payload: { sessionID: "drifted-session", cwd: worktreePath, source: "cli" },
      })}\n`,
    );

    expect(findLatestCodexSessionId(worktreePath, fakeHome)).rejects.toThrow(
      "Invalid Codex session_meta",
    );
  });

  test("recovery discovery stays unknown without process-bound provider evidence", async () => {
    const fakeHome = join(tempRoot, "codex-recovery-home");
    const dayDir = join(codexSessionsDirectory(fakeHome), "2026", "07", "13");
    await mkdir(dayDir, { recursive: true });
    const meta = (sessionId: string, timestamp: string) =>
      `${JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: worktreePath,
          source: "cli",
          agent_nickname: "maya",
        },
      })}\n`;
    await writeFile(
      join(dayDir, "rollout-predecessor.jsonl"),
      meta("predecessor", "2026-07-13T11:59:59.000Z"),
    );
    await writeFile(
      join(dayDir, "rollout-child.jsonl"),
      meta("child", "2026-07-13T12:00:01.000Z"),
    );
    await writeFile(
      join(dayDir, "rollout-parent.jsonl"),
      meta("parent", "2026-07-13T12:00:02.000Z"),
    );

    expect(await discoverCodexRecoverySessionId(
      worktreePath,
      "2026-07-13T12:00:00.000Z",
      fakeHome,
    )).toBeNull();
  });

  test("omits the model override for the account default", () => {
    const command = buildCodexSpawnCommand({
      name: "agent-4",
      model: "default",
      effort: "low",
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: true,
    });

    expect(command).not.toContain("model=default");
    expect(command).toContain("model_reasoning_effort=low");
  });

  test("writes the notify script and MCP config, but no hook tables", async () => {
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      name: "agent-4",
      daemonPort: 4317,
      readOnly: true,
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

    // Residual identity-guard scripts from older launches are removed.
    expect(
      await stat(join(worktreePath, ".codex", "hive-tool-guard.sh")).then(
        () => true,
        () => false,
      ),
    ).toEqual(false);
  });

  test("pins lifecycle hooks to the exact release binary", async () => {
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      name: "agent-4",
      daemonPort: 4317,
      readOnly: true,
      hiveCommand: ["/tmp/Hive Versions/0.0.999/hive"],
    });

    const script = await readFile(
      join(worktreePath, ".codex", CODEX_NOTIFY_SCRIPT),
      "utf8",
    );
    expect(script).toContain(
      `exec '/tmp/Hive Versions/0.0.999/hive' event "$1"`,
    );
    expect(script).not.toContain("exec hive event");
  });

  test("writes and removes the worktree-local graphify hook with server health", async () => {
    const hookPath = join(worktreePath, ".codex", GRAPHIFY_HOOK_SCRIPT);
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      name: "agent-4",
      daemonPort: 4317,
      readOnly: true,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    expect(await readFile(hookPath, "utf8")).toContain("127.0.0.1:7799/mcp");

    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      name: "agent-4",
      daemonPort: 4317,
      readOnly: true,
    });
    expect(readFile(hookPath, "utf8")).rejects.toThrow();
  });
  test("carries the agent capability in a dedicated 0600 token file", async () => {
    // Codex has no connect-time headers helper and does not read the
    // project config.toml under Hive's launch, so the secret sits in its own
    // 0600 file; the launch shell exports it for bearer_token_env_var. It
    // must never land in the config file or any argv.
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      daemonPort: 4317,
      name: "maya",
      readOnly: true,
      capabilityToken: "hv1.abc.secret-token",
    });
    const configPath = join(worktreePath, ".codex", "config.toml");
    const tokenPath = codexCapabilityTokenPath(worktreePath);
    const config = await readFile(configPath, "utf8");
    expect(config).not.toContain("secret-token");
    expect(config).not.toContain("Authorization");
    expect(await readFile(tokenPath, "utf8")).toEqual("hv1.abc.secret-token");
    expect((await stat(tokenPath)).mode & 0o777).toEqual(0o600);
    expect((await stat(configPath)).mode & 0o777).toEqual(0o600);
  });

  test("removes a stale token file when no capability was issued", async () => {
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      daemonPort: 4317,
      name: "maya",
      readOnly: true,
      capabilityToken: "hv1.abc.stale-token",
    });
    await writeCodexAgentConfig(worktreePath, {
      driver: "tui",
      daemonPort: 4317,
      name: "maya",
      readOnly: true,
    });
    const config = await readFile(
      join(worktreePath, ".codex", "config.toml"),
      "utf8",
    );
    expect(config).not.toContain("http_headers");
    expect(config).not.toContain("Authorization");
    expect(stat(codexCapabilityTokenPath(worktreePath))).rejects.toThrow();
  });

  test("a minted capability rides the launch env, never the argv", async () => {
    const base = {
      name: "maya",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: true,
    };
    const withToken = buildCodexSpawnCommand({
      ...base,
      withCapabilityToken: true,
    });
    expect(withToken).toContain(
      `mcp_servers.hive.bearer_token_env_var="${CODEX_CAPABILITY_TOKEN_ENV}"`,
    );
    // Without a token the override must be absent entirely: codex 0.144.1
    // silently disables an MCP server whose bearer_token_env_var is unset.
    expect(buildCodexSpawnCommand(base).join(" ")).not.toContain(
      "bearer_token_env_var",
    );

    // The launch wrapper reads the 0600 file inside the spawn shell, so `ps`
    // shows the substitution text, never the secret.
    expect(wrapCodexSpawnWithCapabilityEnv("codex -c x=1", "/tmp/worktree"))
      .toEqual(
        `${CODEX_CAPABILITY_TOKEN_ENV}="$(cat /tmp/worktree/.codex/capability-token)" codex -c x=1`,
      );
    expect(
      wrapCodexSpawnWithCapabilityEnv("codex", "/tmp/work tree"),
    ).toEqual(
      `${CODEX_CAPABILITY_TOKEN_ENV}="$(cat '/tmp/work tree/.codex/capability-token')" codex`,
    );
  });
});
