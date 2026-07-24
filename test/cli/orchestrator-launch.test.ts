import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ORCHESTRATOR_BRIEF,
  orchestratorDocGuidance,
} from "../../src/cli/orchestrator-brief";
import {
  buildOrchestratorCommand,
  buildOrchestratorInstructions,
  CODEX_ROOT_TOKEN_SUBJECT,
  prepareOrchestratorConfig,
  provisionCodexRootToken,
} from "../../src/cli/orchestrator";

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
  });

  test("Codex uses the ordinary local TUI command", () => {
    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "",
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
      "repository guidance",
      "recovery material",
    );
    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "memory material",
      "repository guidance",
      "/opt/tools/codex",
      "",
      "recovery material",
      [],
    );

    expect(instruction).toContain("memory material");
    expect(command.join("\n")).not.toContain("memory material");
    expect(command.join("\n")).not.toContain("repository guidance");
    expect(command.join("\n")).not.toContain("recovery material");
  });

  test("NUL bytes are normalized before instructions are written", () => {
    const instructions = buildOrchestratorInstructions(
      "memory before\0memory after",
    );
    expect(instructions).not.toContain("\0");
    expect(instructions).toContain("memory before\uFFFDmemory after");
  });

  test("repository document guidance is discovered data, not a compiled name", () => {
    const guidance = orchestratorDocGuidance({
      primary: "DESIGN.md",
      loadBearing: ["DESIGN.md", "README.md"],
    });
    expect(guidance).toContain("DESIGN.md is the primary design doc");
    expect(guidance).toContain("- README.md");
    expect(orchestratorDocGuidance({ primary: null, loadBearing: [] })).toBe("");
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
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path!))).mode & 0o777).toBe(0o700);

    const command = buildOrchestratorCommand(
      "codex",
      4317,
      "",
      "",
      "/opt/tools/codex",
      path!,
    );
    expect(command.join(" ")).not.toContain(path!);
    expect(command).toContain(
      'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
    );
  });
});
