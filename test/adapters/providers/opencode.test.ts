import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  writeOpencodeAgentConfig,
  writeOpencodeTurnPlugin,
} from "../../../src/adapters/providers/opencode-cli";
import { getAgentAdapter } from "../../../src/adapters/providers/provider-registry";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../../../src/adapters/providers/shared/capability-env";
import type { JsonObject } from "../../../src/shared/json";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-opencode-test-"));
  roots.push(root);
  return root;
}

describe("opencode adapter", () => {
  const writer = {
    model: "openai/gpt-5.5",
    readOnly: false,
    dangerous: false,
  };

  test("launches a writer with the model and no permission flags", () => {
    expect(buildOpencodeSpawnCommand(writer)).toEqual([
      "opencode",
      "-m",
      "openai/gpt-5.5",
    ]);
    expect(
      buildOpencodeSpawnCommand({ ...writer, executable: "/opt/opencode" }),
    ).toEqual(["/opt/opencode", "-m", "openai/gpt-5.5"]);
  });

  test("a null model launches bare: opencode applies its own config default", () => {
    // The root queen's path on a machine whose opencode config pins no
    // model — proven live, where a probe-and-refuse gate blocked any
    // opencode queen. No -m flag, and no throw.
    expect(buildOpencodeSpawnCommand({ ...writer, model: null })).toEqual([
      "opencode",
    ]);
    expect(
      buildOpencodeSpawnCommand({ ...writer, model: null, agent: "hive" }),
    ).toEqual(["opencode", "--agent", "hive"]);
  });

  test("the read-only barrier lives in config; dangerous is --auto on argv", () => {
    // readOnly changes no argv: the barrier is agent.hive's permission set
    // in the worktree opencode.json (see the config test below).
    expect(buildOpencodeSpawnCommand({ ...writer, readOnly: true })).toEqual([
      "opencode",
      "-m",
      "openai/gpt-5.5",
    ]);
    expect(buildOpencodeSpawnCommand({ ...writer, dangerous: true })).toEqual([
      "opencode",
      "-m",
      "openai/gpt-5.5",
      "--auto",
    ]);
  });

  test("the hive agent rides argv only when the brief is configured", () => {
    expect(
      buildOpencodeSpawnCommand({ ...writer, agent: OPENCODE_HIVE_AGENT }),
    ).toEqual(["opencode", "-m", "openai/gpt-5.5", "--agent", "hive"]);
  });

  test("the project plugin reports only OpenCode's session.idle event", async () => {
    const root = await worktree();
    await writeOpencodeTurnPlugin(root, {
      name: "maya",
      daemonPort: 4317,
      instanceId: "hive-test",
      providerRunId: "11111111-1111-4111-8111-111111111111",
      hiveCommand: ["/opt/hive"],
    });
    const source = await readFile(
      join(root, ".opencode", "plugins", "hive-turn-events.ts"),
      "utf8",
    );
    expect(source).toContain('event.type !== "session.idle"');
    expect(source).toContain('"/opt/hive"');
    expect(source).toContain('"--provider-run-id"');
  });

  test("writes project config with capability auth, the brief agent, and the barrier", async () => {
    const root = await worktree();
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({
        agent: { review: { description: "the repo's own agent" } },
        mcp: { other: { type: "local", command: ["other"] } },
      }),
    );
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
      instructionPath: "/tmp/prompt.txt",
      readOnly: true,
    });
    const path = join(root, "opencode.json");
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(await readFile(path, "utf8")) as {
      default_agent: string;
      agent: Record<string, JsonObject>;
      mcp: Record<string, JsonObject>;
      permission: JsonObject;
    };
    // The repo's own entries survive.
    expect(written.agent.review).toEqual({
      description: "the repo's own agent",
    });
    expect(written.mcp.other).toEqual({
      type: "local",
      command: ["other"],
    });
    expect(written.mcp.hive).toEqual({
      type: "remote",
      url: "http://127.0.0.1:4317/mcp",
      enabled: true,
      oauth: false,
      // The bearer is named, never written: opencode substitutes {env:VAR} at
      // load time, so no live token lands in a file the project can commit.
      headers: {
        Authorization: `Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}`,
      },
    });
    expect(written.mcp.graphify).toEqual({
      type: "remote",
      url: "http://127.0.0.1:7799/mcp",
      enabled: true,
    });
    expect(written.default_agent).toBe(OPENCODE_HIVE_AGENT);
    expect(written.agent.hive).toEqual({
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      prompt: "{file:/tmp/prompt.txt}",
      permission: { edit: "deny", bash: "deny" },
    });
    // The agent block alone is not the barrier. A subagent spawned through the
    // `task` tool runs as a different agent and falls back to the global block,
    // so read-only has to be global or the subagent keeps bash and edit.
    expect(written.permission).toEqual({ edit: "deny", bash: "deny" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The decline-once gate: the shared script plus the plugin that adapts
    // opencode's tool.execute.before to it and relays only an explicit deny.
    const hookPath = join(root, ".opencode", "hive-graphify-hook.sh");
    expect((await stat(hookPath)).mode & 0o111).toBe(0o111);
    expect(await readFile(hookPath, "utf8")).toContain("opencode)");
    const plugin = await readFile(
      join(root, ".opencode", "plugins", "hive-graphify-gate.ts"),
      "utf8",
    );
    expect(plugin).toContain('"tool.execute.before"');
    expect(plugin).toContain(JSON.stringify([hookPath, "opencode"]));
    expect(plugin).toContain('"deny"');

    // A respawn without a fresh token or brief keeps both, and a missing
    // graphify URL removes the stale endpoint.
    await writeOpencodeAgentConfig(root, { daemonPort: 4400 });
    // SAFETY: The test owns this value and its fields.
    const respawned = JSON.parse(await readFile(path, "utf8")) as {
      default_agent: string;
      agent: Record<string, JsonObject>;
      mcp: Record<string, JsonObject>;
    };
    expect(respawned.mcp.hive).toEqual({
      type: "remote",
      url: "http://127.0.0.1:4400/mcp",
      enabled: true,
      oauth: false,
      // The bearer is named, never written: opencode substitutes {env:VAR} at
      // load time, so no live token lands in a file the project can commit.
      headers: {
        Authorization: `Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}`,
      },
    });
    expect(respawned.mcp.graphify).toBeUndefined();
    expect(respawned.default_agent).toBe(OPENCODE_HIVE_AGENT);
    expect(respawned.agent.hive).toEqual(written.agent.hive);
    // No graphify means no gate: both the script and its plugin are removed
    // rather than leaving a plugin shelling out to a deleted script.
    expect(stat(hookPath)).rejects.toThrow();
    expect(
      stat(join(root, ".opencode", "plugins", "hive-graphify-gate.ts")),
    ).rejects.toThrow();
  });

  test("the written gate plugin relays only an explicit deny", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    const responses = [
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "Graphify gate",
        },
      }),
      "{}",
      "{}",
    ];
    const inputs: string[] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () =>
        // SAFETY: The test owns this value and its fields.
        ({
          stdin: {
            write: (input: string) => inputs.push(input),
            end: () => {},
          },
          stdout: new Blob([responses.shift() ?? "{}"]).stream(),
          exited: Promise.resolve(0),
        }) as never,
    );
    try {
      // SAFETY: The test owns this value and its fields.
      const { HiveGraphifyGate } = (await import(
        join(root, ".opencode", "plugins", "hive-graphify-gate.ts")
      )) as {
        HiveGraphifyGate: () => Promise<
          Record<
            string,
            (
              input: { tool: string },
              output: { args?: unknown },
            ) => Promise<void>
          >
        >;
      };
      const before = (await HiveGraphifyGate())["tool.execute.before"];
      if (before === undefined) throw new Error("hook missing");
      await expect(
        before({ tool: "grep" }, { args: { pattern: "reserveQuota" } }),
      ).rejects.toThrow("Graphify gate");
      await before({ tool: "grep" }, { args: { pattern: "reserveQuota" } });
      await before({ tool: "hive_hive_send" }, { args: { to: "queen" } });
      expect(inputs.map((input) => JSON.parse(input))).toEqual([
        { tool_name: "grep", tool_input: { pattern: "reserveQuota" } },
        { tool_name: "grep", tool_input: { pattern: "reserveQuota" } },
        { tool_name: "hive_hive_send", tool_input: { to: "queen" } },
      ]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a writer's agent carries no permission set, so bash stays reachable", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      readOnly: false,
    });
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as { agent: Record<string, JsonObject> };
    // Measured against opencode 1.18.5: a blanket `bash: "deny"` removes the
    // tool from the model's tool list rather than refusing calls, so a writer
    // that inherits the barrier has no shell at all and cannot run `git log`.
    expect(written.agent.hive).not.toHaveProperty("permission");
  });

  test("dangerous mode makes the Hive agent native-ACP autonomous", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      dangerous: true,
    });
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as { agent: Record<string, JsonObject> };
    expect(written.agent.hive?.permission).toEqual({
      doom_loop: "allow",
      external_directory: "allow",
      read: { "*.env": "allow", "*.env.*": "allow" },
    });
  });

  test("an autonomous reader keeps its read-only barrier", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      readOnly: true,
      dangerous: true,
    });
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as {
      agent: Record<string, JsonObject>;
      permission: JsonObject;
    };
    expect(written.agent.hive?.permission).toEqual({
      doom_loop: "allow",
      external_directory: "allow",
      read: { "*.env": "allow", "*.env.*": "allow" },
      edit: "deny",
      bash: "deny",
    });
    expect(written.permission).toEqual({ edit: "deny", bash: "deny" });
  });

  test("protocol runtime preparation writes token-free config and instructions", async () => {
    const root = await worktree();
    const prepared = await getAgentAdapter("opencode").prepareRuntime({
      name: "maya",
      model: "openai/gpt-5.5",
      worktreePath: root,
      daemonPort: 41000,
      readOnly: false,
      dangerous: true,
      withCapability: true,
      instructionPath: "/tmp/prompt.txt",
    });
    expect(prepared.argv).toEqual([]);
    const config = await readFile(join(root, "opencode.json"), "utf8");
    expect(config).not.toContain("secret-token");
    expect(config).toContain(`Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}`);
    expect(config).toContain("{file:/tmp/prompt.txt}");
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(config) as {
      agent: Record<string, JsonObject>;
    };
    expect(written.agent.hive?.permission).toEqual({
      doom_loop: "allow",
      external_directory: "allow",
      read: { "*.env": "allow", "*.env.*": "allow" },
    });
  });

  test("the orchestrator role replaces the read-only barrier with scoped grants", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      orchestrator: true,
    });
    // SAFETY: The test owns this value and its fields.
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as { agent: Record<string, JsonObject> };
    expect(written.agent.hive).toEqual({
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      prompt: "{file:/tmp/prompt.txt}",
      permission: {
        edit: { "*": "deny", ".hive/**": "allow" },
        bash: { "*": "ask", "gh *": "allow" },
      },
    });
    // Positive lock: memory stays granted; planning/ is not a writable home.
    // SAFETY: The test owns this value and its fields.
    const permission = written.agent.hive?.permission as {
      edit: Record<string, string>;
    };
    expect(permission.edit[".hive/**"]).toBe("allow");
    expect(permission.edit["planning/**"]).toBeUndefined();
  });
});
