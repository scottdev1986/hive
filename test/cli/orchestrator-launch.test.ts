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
  buildQueenLaunchContext,
  CLAUDE_QUEEN_AUTOCOMPACT,
  CLAUDE_QUEEN_EFFORT,
  CLAUDE_QUEEN_MODEL,
  CODEX_ROOT_TOKEN_SUBJECT,
  launchOrchestrator,
  orchestratorJournalPath,
  orchestratorLaunchEnvironment,
  prepareOrchestratorConfig,
  provisionCodexRootToken,
  provisionQueenRootToken,
  QUEEN_KICKOFF,
} from "../../src/cli/orchestrator";
import { QUEEN_POLICY } from "../../src/cli/queen-policy";
import {
  USER_SUBJECT,
  writeCredential,
} from "../../src/daemon/authorization/credentials";
import { rootSessionIdForLaunchRequest } from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import { launchPromptPath } from "../../src/daemon/spawn/launch-prompt";
import {
  hiveInstanceSuffix,
  orchestratorSessionKey,
} from "../../src/hive-home/home";
import { required } from "../required";
import type { JsonObject } from "../../src/shared/json";

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
  test("queen kickoff does not invent an assigned task", () => {
    expect(QUEEN_KICKOFF).not.toContain("Begin the assigned task.");
    expect(QUEEN_KICKOFF).toContain("wait for the user");
    expect(QUEEN_KICKOFF).toContain("Do not invent work");
  });

  test("the pinned policy names the orchestration surface and operating rules", () => {
    for (const tool of [
      "hive_spawn",
      "hive_status",
      "hive_mail_poll",
      "hive_approvals",
      "hive_approve",
    ]) {
      expect(QUEEN_POLICY).toContain(tool);
    }
    expect(QUEEN_POLICY).toContain("never poll");
    expect(QUEEN_POLICY).toContain("hive_terminal_observe");
    expect(QUEEN_POLICY).toContain("never as a background or periodic check");
    // User-facing continuity: fresh queens must speak plainly and translate
    // internal task ids instead of expecting the user to recognize them.
    expect(QUEEN_POLICY).toContain("plain, concise language");
    expect(QUEEN_POLICY).toContain("Answer their question first");
    expect(QUEEN_POLICY).toContain(
      "Never identify work only by an internal id",
    );
    expect(QUEEN_POLICY).toContain("short human-readable name");
    // Mail discipline, dispatch, escalation, landing, and succession are
    // pull-tier topics now (src/skills/knowledge.ts); the policy points at
    // them rather than restating their protocol inline.
    for (const topic of [
      "mail-discipline",
      "dispatch",
      "escalation",
      "landing",
      "succession",
    ]) {
      expect(QUEEN_POLICY).toContain(`hive_knowledge topic=${topic}`);
    }
    // Role boundary: queen writes her own memory and uses gh; implementation
    // is always delegated. planning/ is not a writable home.
    expect(QUEEN_POLICY).toContain("never author implementation code");
    expect(QUEEN_POLICY).toContain("own memory (.hive/)");
    expect(QUEEN_POLICY).not.toContain("docs (planning/)");
    expect(QUEEN_POLICY).not.toContain("never write code or modify files");
    expect(QUEEN_POLICY).not.toContain("claude-opus-4-8");
    expect(QUEEN_POLICY).not.toContain("Opus 4.8");
  });

  test("the pinned policy makes queen the project's technical leader", () => {
    for (const responsibility of [
      "expert project manager",
      "technical architect",
      "master technical lead",
      "Hive's hierarchy board",
      "sole system of record",
      "established module boundaries",
      "no duplication/scattering",
      "Reject over-engineering and needless abstraction",
      "Require root-cause fixes, never symptom patches",
      "delegate research",
      "best-supported design",
    ]) {
      expect(QUEEN_POLICY).toContain(responsibility);
    }
  });

  test("Codex uses the ordinary local TUI command", () => {
    const command = buildOrchestratorCommand({
      tool: "codex",
      port: 4317,
      executable: "/opt/tools/codex",
    });

    expect(command[0]).toBe("/opt/tools/codex");
    expect(command).not.toContain("--remote");
    expect(command).not.toContain("--no-alt-screen");
    expect(command).not.toContain("app-server");
    expect(command).toContain("--profile");
  });

  test("Claude Queen launches Opus 5 with the leadership runtime controls", () => {
    const command = buildOrchestratorCommand({
      tool: "claude",
      port: 4317,
      executable: "/opt/tools/claude",
    });

    expect(command).toContain(CLAUDE_QUEEN_MODEL);
    expect(command).toContain(CLAUDE_QUEEN_EFFORT);
    expect(command).toContain("--brief");
    expect(command[command.indexOf("--autocompact") + 1]).toBe(
      CLAUDE_QUEEN_AUTOCOMPACT,
    );
  });

  test("launches the queen through agent-ui with its prompt already installed", async () => {
    const project = await mkdtemp(join(tmpdir(), "hive-queen-ui-"));
    const executable = join(project, "codex");
    const observed: string[] = [];
    try {
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      const exit = await launchOrchestrator("codex", 4317, project, "", {
        resolveCodexExecutable: () => ({
          path: executable,
          version: "fixture",
        }),
        listCodexMcpServers: async () => [],
        provisionCodexToken: async () => {
          const tokenPath = join(project, "token");
          await writeFile(tokenPath, "queen-token\n");
          return tokenPath;
        },
        sessiondControl: {
          start: async (launch) => {
            observed.push(...launch.argv);
            expect(
              await readFile(
                launchPromptPath(orchestratorSessionKey()),
                "utf8",
              ),
            ).toContain("You are queen, the Hive orchestrator");
            expect(launch.environment.HIVE_CAPABILITY_TOKEN).toBe(
              "queen-token",
            );
            return {
              requestId: launch.requestId,
              locator: {
                schemaVersion: 1,
                instanceId: hiveInstanceSuffix(),
                subject: { kind: "root" },
                sessionId: rootSessionIdForLaunchRequest(launch.requestId),
                generation: 1,
                hostKind: "sessiond",
                engineBuildId: "fixture",
              },
              state: "exited",
              exitCode: 0,
              diagnostic: null,
            };
          },
          waitForTerminal: async () => ({ kind: "missing" }),
        },
      });
      expect(exit).toBe(0);
      expect(observed).toContain("agent-ui");
      expect(observed).toContain("queen");
      expect(observed).toContain(orchestratorJournalPath());
      expect(observed).toContain("default");
      const runIdIndex = observed.indexOf("--provider-run-id");
      expect(runIdIndex).toBeGreaterThan(-1);
      expect(observed[runIdIndex + 1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("silent instructions stay out of the visible command arguments", async () => {
    const instruction = await buildQueenLaunchContext({
      memoryIndex: "memory material",
      bootCapsule: "capsule material",
      repoRoot: "/tmp/test-repo",
    });
    const command = buildOrchestratorCommand({
      tool: "codex",
      port: 4317,
      executable: "/opt/tools/codex",
    });

    expect(instruction).toContain("memory material");
    expect(command.join("\n")).not.toContain("memory material");
    expect(command.join("\n")).not.toContain("capsule material");
  });

  test("NUL bytes are normalized before instructions are written", async () => {
    const instructions = await buildQueenLaunchContext({
      memoryIndex: "memory before\0memory after",
      repoRoot: "/tmp/test-repo",
    });
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

    const command = buildOrchestratorCommand({
      tool: "codex",
      port: 4317,
      executable: "/opt/tools/codex",
      codexAuthorized: true,
    });
    expect(command.join(" ")).not.toContain(required(path));
    expect(command).toContain(
      'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
    );
  });

  test("every vendor's root launch carries the queen credential, never the user's", async () => {
    // The env indirection vendors (grok, kimi, opencode): the bearer is the
    // queen's own credential.
    for (const tool of ["grok", "kimi", "opencode"] as const) {
      const environment = orchestratorLaunchEnvironment(tool, {
        codexToken: "",
        queenToken: "queen-token",
      });
      expect(environment.HIVE_CAPABILITY_TOKEN).toEqual("queen-token");
      expect(environment.HIVE_CAPABILITY_TOKEN).not.toEqual("user-token");
    }
    // Codex rides its own provisioned file's token; claude carries nothing
    // in the environment — her credential is read from the store at connect.
    expect(
      orchestratorLaunchEnvironment("codex", {
        codexToken: "queen-token",
        queenToken: "",
      }).HIVE_CAPABILITY_TOKEN,
    ).toEqual("queen-token");
    expect(
      orchestratorLaunchEnvironment("claude", {
        codexToken: "",
        queenToken: "queen-token",
      }),
    ).toEqual({});

    // Claude's on-disk config points her headersHelper at the queen's
    // credential, not the user's.
    const project = await mkdtemp(join(tmpdir(), "hive-claude-orch-"));
    try {
      await prepareOrchestratorConfig("claude", 4317, project);
      // SAFETY: The test owns this value and its fields.
      const mcp = JSON.parse(
        await readFile(
          join(hiveHome, "runtime", "orchestrator", ".mcp.json"),
          "utf8",
        ),
      ) as { mcpServers: { hive: { headersHelper: string } } };
      expect(mcp.mcpServers.hive.headersHelper).toContain(
        "credential --agent queen",
      );
      expect(mcp.mcpServers.hive.headersHelper).not.toContain("--agent user");
    } finally {
      await rm(project, { recursive: true, force: true });
    }

    // A daemon that cannot mint fails the launch loudly.
    expect(provisionQueenRootToken(4317, async () => null)).rejects.toThrow(
      "could not mint the queen root credential",
    );
    expect(
      provisionQueenRootToken(4317, async () => "queen-token"),
    ).resolves.toEqual("queen-token");
  });

  test("the queen's codex role: workspace-write sandbox with network for gh", () => {
    const command = buildOrchestratorCommand({
      tool: "codex",
      port: 4317,
      executable: "/opt/tools/codex",
    });
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
      const command = buildOrchestratorCommand({
        tool: "grok",
        port: 4317,
        executable: grok,
        effectiveModel: "grok-4",
      });
      const joined = command.join(" ");
      expect(joined).toContain("--always-approve");
      expect(joined).not.toContain("--deny");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the legacy Kimi command builder preserves its native --yolo argv", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-orch-"));
    const previous = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    try {
      await writeFile(
        join(home, "config.toml"),
        'default_model = "kimi-code/k3"\n',
      );
      const command = buildOrchestratorCommand({
        tool: "kimi",
        port: 4317,
        executable: "/opt/tools/kimi",
        effectiveModel: "kimi-code/k3",
      });
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
      writeCredential(USER_SUBJECT, "user-token");
      await prepareOrchestratorConfig("opencode", 4317, project);
      // SAFETY: The test owns this value and its fields.
      const config = JSON.parse(
        await readFile(join(project, "opencode.json"), "utf8"),
      ) as { agent: Record<string, JsonObject> };
      expect(config.agent.hive?.permission).toEqual({
        edit: { "*": "deny", ".hive/**": "allow" },
        bash: { "*": "ask", "gh *": "allow" },
      });
      // Positive lock: memory stays granted; planning/ is not a writable home.
      // SAFETY: The test owns this value and its fields.
      const editPermission = config.agent.hive?.permission as {
        edit: Record<string, string>;
      };
      expect(editPermission.edit[".hive/**"]).toBe("allow");
      expect(editPermission.edit["planning/**"]).toBeUndefined();
      const command = buildOrchestratorCommand({
        tool: "opencode",
        port: 4317,
        executable: "/opt/tools/opencode",
        effectiveModel: "openai/gpt-5.5",
      });
      expect(command).toContain("--agent");
      expect(command).not.toContain("--auto");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test("queen launch context includes mistakes from episodic store", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-queen-episodic-"));
    try {
      const { EpisodicStore } =
        await import("../../src/memory-service/episodic");
      const episodic = new EpisodicStore(":memory:");

      episodic.appendEvent({
        type: "mistake",
        summary: "Test mistake from episodic",
        provenance: {},
      });

      episodic.appendEvent({
        type: "pitfall",
        summary: "Test pitfall from episodic",
        provenance: {},
      });

      const launchContext = await buildQueenLaunchContext({
        repoRoot: root,
        episodic,
      });

      expect(launchContext).toContain("Test mistake from episodic");
      expect(launchContext).toContain("Test pitfall from episodic");

      episodic.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queen launch context handles missing episodic store gracefully", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-queen-no-episodic-"));
    try {
      const launchContext = await buildQueenLaunchContext({
        repoRoot: root,
      });

      expect(launchContext).toBeDefined();
      expect(launchContext.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
