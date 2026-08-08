import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKimiSpawnCommand,
  kimiReadOnlyContainmentGap,
  wrapKimiSpawnWithEffort,
  wrapKimiWithInstructionFile,
  wrapKimiWithTurnHookContext,
  writeKimiAgentConfig,
  writeKimiTurnHook,
} from "../../../src/adapters/providers/kimi-cli";
import { getAgentAdapter } from "../../../src/adapters/providers/provider-registry";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../../../src/adapters/providers/shared/capability-env";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-kimi-test-"));
  roots.push(root);
  return root;
}

describe("Kimi adapter", () => {
  const writer = { model: "kimi-code/k3", readOnly: false, dangerous: false };

  test("launches a writer with the model alias and --yolo on argv", () => {
    expect(buildKimiSpawnCommand(writer)).toEqual([
      "kimi",
      "-m",
      "kimi-code/k3",
      "--yolo",
    ]);
    expect(
      buildKimiSpawnCommand({ ...writer, executable: "/opt/kimi" }),
    ).toEqual(["/opt/kimi", "-m", "kimi-code/k3", "--yolo"]);
  });

  test("maps the permission posture to kimi's native modes", () => {
    // readOnly is Hive's manual posture: kimi's default mode, no flag.
    expect(buildKimiSpawnCommand({ ...writer, readOnly: true })).toEqual([
      "kimi",
      "-m",
      "kimi-code/k3",
    ]);
    // dangerous is the unsafe bypass: --auto, never stacked with --yolo.
    const dangerous = buildKimiSpawnCommand({ ...writer, dangerous: true });
    expect(dangerous).toEqual(["kimi", "-m", "kimi-code/k3", "--auto"]);
    const both = buildKimiSpawnCommand({
      ...writer,
      readOnly: true,
      dangerous: true,
    });
    expect(both).toContain("--auto");
    expect(both).not.toContain("--yolo");
  });

  test("the instruction wrap installs the 0600 prompt as project AGENTS.md", () => {
    const command = wrapKimiWithInstructionFile(
      "kimi -m model --yolo",
      "/tmp/prompt.txt",
    );
    expect(command).toContain(
      "install -m 600 '/tmp/prompt.txt' '.kimi-code/AGENTS.md'",
    );
    expect(command).toContain("&& kimi -m model --yolo");
    expect(command).not.toContain("Opening instruction");
  });

  test("effort enters through the environment, never an argv", () => {
    expect(wrapKimiSpawnWithEffort("kimi -m model", "high")).toBe(
      "KIMI_MODEL_THINKING_EFFORT='high' kimi -m model",
    );
  });

  test("the shared Stop hook reports only a Hive-bound Kimi turn", async () => {
    const root = await worktree();
    await writeKimiTurnHook(["/opt/hive"], root);
    const config = await readFile(join(root, "config.toml"), "utf8");
    expect(config).toContain('event = "Stop"');
    expect(config).toContain("HIVE_AGENT_NAME");
    expect(config).toContain("'/opt/hive' event turn-end");
    // The graphify gate rides the same Hive-owned block: a PreToolUse entry
    // that runs the worktree-local script only for a Hive launch that has one.
    expect(config).toContain('event = "PreToolUse"');
    expect(config).toContain("[ -x .kimi-code/hive-graphify-hook.sh ]");
    expect(config).toContain("exec .kimi-code/hive-graphify-hook.sh kimi");

    const wrapped = wrapKimiWithTurnHookContext("kimi -m model", {
      name: "maya",
      daemonPort: 4317,
      instanceId: "hive-test",
      providerRunId: "11111111-1111-4111-8111-111111111111",
    });
    expect(wrapped).toContain("HIVE_AGENT_NAME='maya'");
    expect(wrapped).toContain("HIVE_PROVIDER_RUN_ID=");
  });

  test("writes project MCPs with capability auth and preserves unrelated servers", async () => {
    const root = await worktree();
    await mkdir(join(root, ".kimi-code"), { recursive: true });
    await writeFile(
      join(root, ".kimi-code", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "other" },
          hive: { url: "http://stale" },
        },
      }),
    );
    await writeKimiAgentConfig(root, {
      daemonPort: 4317,
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    const path = join(root, ".kimi-code", "mcp.json");
    const written = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers.other).toEqual({ command: "other" });
    // The bearer is named, never written: kimi reads it from the environment at
    // connect time, so no live token lands in a file the project can commit.
    expect(written.mcpServers.hive).toEqual({
      url: "http://127.0.0.1:4317/mcp",
      bearerTokenEnvVar: HIVE_CAPABILITY_TOKEN_ENV,
    });
    expect(written.mcpServers.graphify).toEqual({
      url: "http://127.0.0.1:7799/mcp",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The gate script the user-level PreToolUse hook runs, executable and
    // dispatching on the kimi arm.
    const hookPath = join(root, ".kimi-code", "hive-graphify-hook.sh");
    expect((await stat(hookPath)).mode & 0o111).toBe(0o111);
    expect(await readFile(hookPath, "utf8")).toContain("kimi)");

    // A respawn moves the port and a missing graphify URL removes the stale
    // endpoint.
    await writeKimiAgentConfig(root, { daemonPort: 4400 });
    const respawned = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(respawned.mcpServers.hive).toEqual({
      url: "http://127.0.0.1:4400/mcp",
      bearerTokenEnvVar: HIVE_CAPABILITY_TOKEN_ENV,
    });
    expect(respawned.mcpServers.graphify).toBeUndefined();
    expect(stat(hookPath)).rejects.toThrow();
  });

  test("protocol runtime preparation writes token-free MCP config", async () => {
    const root = await worktree();
    const promptPath = join(root, "launch-prompt.txt");
    await writeFile(promptPath, "You are maya.\n");
    const prepared = await getAgentAdapter("kimi").prepareRuntime({
      name: "maya",
      model: "kimi-code/k3",
      worktreePath: root,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      withCapability: true,
      instructionPath: promptPath,
      effort: "high",
    });
    expect(prepared.argv).toEqual([]);
    // The prompt is installed while preparing the worktree, so the launch
    // command stays one command and a leading VAR=value assignment reaches it.
    const agents = join(root, ".kimi-code", "AGENTS.md");
    expect(await readFile(agents, "utf8")).toBe("You are maya.\n");
    expect(((await stat(agents)).mode & 0o777).toString(8)).toBe("600");
    const mcp = await readFile(join(root, ".kimi-code", "mcp.json"), "utf8");
    expect(mcp).not.toContain("secret-token");
    expect(mcp).toContain(
      `"bearerTokenEnvVar": "${HIVE_CAPABILITY_TOKEN_ENV}"`,
    );
    expect(mcp).toContain("http://127.0.0.1:41000/mcp");
  });

  test("protocol runtime preparation writes a turn hook independent of the spawner worktree", async () => {
    const home = await worktree();
    const previousHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    try {
      await getAgentAdapter("kimi").prepareRuntime({
        name: "maya",
        model: "kimi-code/k3",
        worktreePath: await worktree(),
        daemonPort: 41000,
        readOnly: false,
        dangerous: false,
        hiveCommand: ["/tmp/deleted-worktree/src/cli.ts"],
        providerRunId: "11111111-1111-4111-8111-111111111111",
      });
      const config = await readFile(join(home, "config.toml"), "utf8");
      expect(config).toContain(
        "'bun' '/Users/scottkellar/Projects/hive/src/cli.ts' event turn-end",
      );
      expect(config).not.toContain("/tmp/deleted-worktree");
    } finally {
      if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousHome;
    }
  });
});

describe("read-only containment is reported, never faked", () => {
  /**
   * Kimi has no per-launch deny channel: its only permission surface is the
   * user's global config.toml, which Hive must not write (that gate belongs
   * to the user). So a Hive "read-only" Kimi agent under a user default of
   * yolo/auto holds write authority and Hive cannot stop it. The contract Hive
   * CAN keep is refusing to pretend, and these cases pin exactly when it speaks.
   */
  test.each([
    ["no config file at all", null, false],
    ['pinned "manual"', 'default_permission_mode = "manual"\n', false],
    ["a config with no permission key", 'default_model = "k2"\n', false],
    ['pinned "yolo"', 'default_permission_mode = "yolo"\n', true],
    ['pinned "auto"', 'default_permission_mode = "auto"\n', true],
  ])("%s", async (_label, toml, expectGap) => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-perm-"));
    try {
      if (toml !== null) await writeFile(join(home, "config.toml"), toml);
      const gap = kimiReadOnlyContainmentGap(home);
      expect(gap === null).toBe(!expectGap);
      if (expectGap) {
        // It must name the vendor gate and hand the fix to the user.
        expect(gap).toContain("NOT enforced");
        expect(gap).toContain("Hive does not change these permission settings");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reporting the gap never writes the user's config", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-perm-"));
    try {
      const original = 'default_permission_mode = "yolo"\n';
      await writeFile(join(home, "config.toml"), original);
      kimiReadOnlyContainmentGap(home);
      expect(await readFile(join(home, "config.toml"), "utf8")).toBe(original);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
