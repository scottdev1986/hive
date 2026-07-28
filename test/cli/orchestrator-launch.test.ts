import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildOrchestratorCommand,
  buildOrchestratorInstructions,
  CODEX_ROOT_TOKEN_SUBJECT,
  prepareOrchestratorConfig,
  provisionCodexRootToken,
} from "../../src/cli/orchestrator";
import { ORCHESTRATOR_BRIEF } from "../../src/cli/orchestrator-brief";
import {
  OPERATOR_SUBJECT,
  writeCredential,
} from "../../src/daemon/credentials";
import { required } from "../required";

let hiveHome: string;
let previousHiveHome: string | undefined;

beforeEach(async () => {
  previousHiveHome = process.env.HIVE_HOME;
  hiveHome = await mkdtemp(join(tmpdir(), "hive-orchestrator-test-"));
  process.env.HIVE_HOME = hiveHome;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

describe("orchestrator launch", () => {
  test("the silent brief names the orchestration surface and operating rules", () => {
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
    expect(ORCHESTRATOR_BRIEF).toContain("never poll");
    expect(ORCHESTRATOR_BRIEF).toContain("land their own finished work");
    expect(ORCHESTRATOR_BRIEF).toContain("Treat null as full, not as free");
    // The #12 role boundary: the queen writes her own memory and planning
    // docs and uses gh, but implementation is always delegated.
    expect(ORCHESTRATOR_BRIEF).toContain("never author implementation code");
    expect(ORCHESTRATOR_BRIEF).not.toContain(
      "never write code or modify files",
    );
    expect(ORCHESTRATOR_BRIEF).not.toContain("claude-opus-4-8");
    expect(ORCHESTRATOR_BRIEF).not.toContain("Opus 4.8");
  });

  test("Codex uses the ordinary local TUI command", () => {
    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "",
      "/opt/tools/codex",
      "",
      "",
      [],
    );

    expect(command[0]).toBe("/opt/tools/codex");
    expect(command).not.toContain("--remote");
    expect(command).not.toContain("--no-alt-screen");
    expect(command).not.toContain("app-server");
    expect(command).toContain("--profile");
  });

  test("silent instructions stay out of the visible command arguments", () => {
    const instruction = buildOrchestratorInstructions(
      "memory material",
      "recovery material",
    );
    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "memory material",
      "/opt/tools/codex",
      "",
      "recovery material",
      [],
    );

    expect(instruction).toContain("memory material");
    expect(command.join("\n")).not.toContain("memory material");
    expect(command.join("\n")).not.toContain("recovery material");
  });

  test("NUL bytes are normalized before instructions are written", () => {
    const instructions = buildOrchestratorInstructions(
      "memory before\0memory after",
    );
    expect(instructions).not.toContain("\0");
    expect(instructions).toContain("memory before\uFFFDmemory after");
  });

  test("Codex setup never modifies project configuration", async () => {
    const project = await mkdtemp(join(tmpdir(), "hive-codex-project-"));
    const config = join(project, ".codex", "config.toml");
    try {
      await mkdir(dirname(config), { recursive: true });
      await writeFile(config, "[features]\ncustom = true\n");
      await prepareOrchestratorConfig("codex", 4317, project);
      expect(await readFile(config, "utf8")).toBe(
        "[features]\ncustom = true\n",
      );
      expect(existsSync(join(project, ".codex", "hive-notify.sh"))).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("Codex capability stays in owner-only storage and out of argv", async () => {
    const path = await provisionCodexRootToken(4317, async () => "token");
    expect(path).not.toBeNull();
    expect(path).toContain(CODEX_ROOT_TOKEN_SUBJECT);
    expect((await stat(required(path))).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(required(path)))).mode & 0o777).toBe(0o700);

    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "",
      "/opt/tools/codex",
      required(path),
    );
    expect(command.join(" ")).not.toContain(required(path));
    expect(command).toContain(
      'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
    );
  });

  test("the queen's codex role: workspace-write sandbox with network for gh", () => {
    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "",
      "/opt/tools/codex",
      "",
      "",
      [],
    );
    const joined = command.join(" ");
    expect(joined).toContain("--sandbox workspace-write");
    expect(joined).not.toContain("--sandbox read-only");
    expect(joined).toContain("sandbox_workspace_write.network_access=true");
  });

  test("the queen's grok role is a full tool grant — grok cannot scope it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-orch-"));
    try {
      const grok = join(root, "grok");
      await writeFile(grok, "#!/bin/sh\nprintf '* grok-4 (default)\\n'\n");
      await chmod(grok, 0o755);
      const command = buildOrchestratorCommand("grok", 4317, "", grok);
      const joined = command.join(" ");
      expect(joined).toContain("--always-approve");
      expect(joined).not.toContain("--deny");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the queen's kimi role is --yolo — kimi has no per-launch scoping", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-orch-"));
    const previous = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    try {
      await writeFile(
        join(home, "config.toml"),
        'default_model = "kimi-code/k3"\n',
      );
      const command = buildOrchestratorCommand(
        "kimi",
        4317,
        "",
        "/opt/tools/kimi",
      );
      expect(command.join(" ")).toContain("--yolo");
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the queen's opencode role rides the hive agent's permission set", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "hive-opencode-orch-"));
    const project = await mkdtemp(join(tmpdir(), "hive-opencode-project-"));
    const previous = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;
    try {
      await writeFile(
        join(configDir, "opencode.json"),
        JSON.stringify({ model: "openai/gpt-5.5" }),
      );
      writeCredential(OPERATOR_SUBJECT, "operator-token");
      await prepareOrchestratorConfig("opencode", 4317, project);
      const config = JSON.parse(
        await readFile(join(project, "opencode.json"), "utf8"),
      ) as { agent: Record<string, Record<string, unknown>> };
      expect(config.agent.hive?.permission).toEqual({
        edit: { "*": "deny", ".hive/**": "allow", "planning/**": "allow" },
        bash: { "*": "ask", "gh *": "allow" },
      });
      const command = buildOrchestratorCommand(
        "opencode",
        4317,
        "",
        "/opt/tools/opencode",
      );
      expect(command).toContain("--agent");
      expect(command).not.toContain("--auto");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});
