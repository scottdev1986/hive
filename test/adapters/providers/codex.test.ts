import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexSpawnCommand,
  buildCodexTrustArgs,
  CODEX_NOTIFY_SCRIPT,
  writeCodexAgentConfig,
} from "../../../src/adapters/providers/codex-cli";
import {
  HIVE_CAPABILITY_TOKEN_ENV,
  wrapSpawnWithCapabilityEnv,
} from "../../../src/adapters/providers/shared/capability-env";
import { GRAPHIFY_HOOK_SCRIPT } from "../../../src/adapters/providers/shared/graphify-hook";
import { credentialPath } from "../../../src/hive-home/home";
import { shellJoin } from "../../../src/shared/shell-quote";

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
    expect(command).toContain(
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
    );
    expect(command).not.toContain("mcp_servers.hive.enabled=false");
  });

  test("disables Codex Apps for the process without touching user config", () => {
    const command = buildCodexSpawnCommand(base);
    expect(command).toContain("features.apps=false");
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
    expect(command).toContain(
      'mcp_servers.graphify.url="http://127.0.0.1:7799/mcp"',
    );
    expect(command.join(" ")).toContain("hooks.PreToolUse=");
    expect(command.join(" ")).toContain(`${GRAPHIFY_HOOK_SCRIPT} codex`);
    // The exclusion pass must not disable the entry whose url we just claimed.
    expect(command.join(" ")).not.toContain(
      "mcp_servers.graphify.enabled=false",
    );
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
});

// The lifecycle hooks must ride the command line: codex only loads a
// project-local `.codex/config.toml` when the directory's trust is persisted
// in the user's own config file, and Hive passes trust as a `-c` override
// precisely so it never edits that file (verified against codex 0.144.1).
const expectedHookOverrides = (worktreePath: string): string[] =>
  [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "turn-start"],
    // The vendor's approval popup is the one blocking state no other hook
    // reports, so it must ride the same override channel as the rest.
    ["PermissionRequest", "approval-request"],
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
      "features.apps=false",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'projects={"/tmp/worktree"={trust_level="trusted"}}',
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
      "features.apps=false",
      "-c",
      "model=gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
      "--sandbox",
      "read-only",
      "-c",
      'projects={"/tmp/worktree"={trust_level="trusted"}}',
      "--dangerously-bypass-hook-trust",
      "-c",
      "features.hooks=true",
      ...expectedHookOverrides("/tmp/worktree"),
      "-c",
      'mcp_servers.hive.url="http://127.0.0.1:4317/mcp"',
    ]);
  });

  test("builds trusted-project, native-hook, and MCP CLI overrides", () => {
    expect(buildCodexTrustArgs("/tmp/work tree")).toEqual([
      "-c",
      'projects={"/tmp/work tree"={trust_level="trusted"}}',
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
      argument.startsWith("mcp_servers.hive.url="),
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
      argument.startsWith("hooks.SessionStart="),
    );
    expect(hookOverride).toBeDefined();
    expect(Bun.TOML.parse(hookOverride ?? "")).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `/tmp/work tree/.codex/${CODEX_NOTIFY_SCRIPT} session-start`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    });
  });

  test("trusts the physical worktree path Codex compares against", async () => {
    const alias = join(tempRoot, "worktree-alias");
    await symlink(worktreePath, alias, "dir");

    expect(buildCodexTrustArgs(alias)).toEqual([
      "-c",
      `projects={${JSON.stringify(await realpath(worktreePath))}={trust_level="trusted"}}`,
    ]);
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
    // SAFETY: The test owns this value and its fields.
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
    expect(config.mcp_servers.hive?.url).toEqual("http://127.0.0.1:4317/mcp");
    expect(script.startsWith("#!/bin/sh\n")).toEqual(true);
    expect(
      script.includes('exec hive event "$1" --agent agent-4 --port 4317'),
    ).toEqual(true);
  });

  test("pins lifecycle hooks to the exact release binary", async () => {
    await writeCodexAgentConfig(worktreePath, {
      name: "agent-4",
      daemonPort: 4317,
      readOnly: false,
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
      name: "agent-4",
      daemonPort: 4317,
      readOnly: false,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    expect(await readFile(hookPath, "utf8")).toContain("127.0.0.1:7799/mcp");

    await writeCodexAgentConfig(worktreePath, {
      name: "agent-4",
      daemonPort: 4317,
      readOnly: false,
    });
    expect(readFile(hookPath, "utf8")).rejects.toThrow();
  });
  test("puts no capability in the worktree, and clears a legacy token file", async () => {
    // The bearer must never sit in .codex/capability-token (staged by an
    // ordinary `git add -A`). It travels only in the launch environment, and
    // the config never carries it. A leftover file from an older layout is
    // cleared on write.
    const tokenPath = join(worktreePath, ".codex", "capability-token");
    await mkdir(join(worktreePath, ".codex"), { recursive: true });
    await writeFile(tokenPath, "hv1.abc.secret-token");

    await writeCodexAgentConfig(worktreePath, {
      daemonPort: 4317,
      name: "maya",
      readOnly: false,
    });

    const configPath = join(worktreePath, ".codex", "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).not.toContain("Authorization");
    expect(config).not.toContain("secret-token");
    expect(stat(tokenPath)).rejects.toThrow();
    expect((await stat(configPath)).mode & 0o777).toEqual(0o600);
  });

  test("a minted capability rides the launch env, never the argv", async () => {
    const base = {
      name: "maya",
      model: "gpt-5-codex",
      effort: "high" as const,
      worktreePath: "/tmp/worktree",
      daemonPort: 4317,
      readOnly: false,
    };
    const withToken = buildCodexSpawnCommand({
      ...base,
      withCapabilityToken: true,
    });
    expect(withToken).toContain(
      `mcp_servers.hive.bearer_token_env_var="${HIVE_CAPABILITY_TOKEN_ENV}"`,
    );
    // Without a token the override must be absent entirely: codex 0.144.1
    // silently disables an MCP server whose bearer_token_env_var is unset.
    expect(buildCodexSpawnCommand(base).join(" ")).not.toContain(
      "bearer_token_env_var",
    );

    // The launch wrapper reads the credential file — outside every worktree —
    // inside the spawn shell, so `ps` shows the substitution text, never the
    // secret, and no project file ever holds it.
    const wrapped = wrapSpawnWithCapabilityEnv("codex -c x=1", "maya", "codex");
    expect(wrapped).toEqual(
      `${HIVE_CAPABILITY_TOKEN_ENV}="$(cat '${credentialPath("maya")}')" codex -c x=1`,
    );
    expect(wrapped).not.toContain("/worktree");
  });

  test("the capability wrapper refuses a command that runs something first", () => {
    const hive = "/opt/hive/hive";
    const launch = `${shellJoin([hive, "agent-ui", "--subject", "amos"])}`;
    // Assignments already in front are fine: they bind alongside, not instead.
    expect(
      wrapSpawnWithCapabilityEnv(
        `HIVE_AGENT_NAME='amos' ${launch}`,
        "amos",
        hive,
      ),
    ).toContain(HIVE_CAPABILITY_TOKEN_ENV);

    // The shape that shipped a tokenless Kimi: a copy step before the launch
    // takes the assignment, and the provider never sees it.
    expect(() =>
      wrapSpawnWithCapabilityEnv(
        `mkdir -p .kimi-code && install -m 600 '/tmp/p.txt' '.kimi-code/AGENTS.md' && ${launch}`,
        "amos",
        hive,
      ),
    ).toThrow(/would not reach/);
  });
});
