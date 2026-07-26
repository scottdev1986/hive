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
import { join, resolve } from "node:path";
import { getAgentAdapter } from "../../../src/adapters/tools/agents/agent-factory";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../../../src/adapters/tools/capability-env";
import {
  buildKimiResumeCommand,
  buildKimiSpawnCommand,
  discoverKimiRecoverySessionId,
  kimiReadOnlyContainmentGap,
  probeKimiDefaultModel,
  wrapKimiSpawnWithEffort,
  wrapKimiWithInstructionFile,
  writeKimiAgentConfig,
} from "../../../src/adapters/tools/kimi";
import { RecoverySessionDiscoveryError } from "../../../src/adapters/tools/recovery-session";
import { credentialPath } from "../../../src/daemon/credentials";

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

  test("resume uses --session and replays current process flags", () => {
    expect(buildKimiResumeCommand(writer, "session_abc")).toEqual([
      "kimi",
      "--session",
      "session_abc",
      "-m",
      "kimi-code/k3",
      "--yolo",
    ]);
    expect(buildKimiSpawnCommand(writer)).not.toContain("--session");
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

  test("reads the effective default only from the config file", async () => {
    const home = await worktree();
    expect(probeKimiDefaultModel(home)).toBeNull();
    await writeFile(
      join(home, "config.toml"),
      'default_model = "kimi-code/k3"\n',
    );
    expect(probeKimiDefaultModel(home)).toBe("kimi-code/k3");
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
  });

  test("prepareSpawn keeps the token out of argv and the launch command", async () => {
    const root = await worktree();
    const prepared = await getAgentAdapter("kimi").prepareSpawn({
      name: "maya",
      model: "kimi-code/k3",
      worktreePath: root,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      withCapability: true,
      instructionPath: "/tmp/prompt.txt",
      kickoff: "Begin the assigned task.",
      effort: "high",
    });
    expect(prepared.argv).toEqual(["kimi", "-m", "kimi-code/k3", "--yolo"]);
    expect(prepared.command).toContain(
      "install -m 600 '/tmp/prompt.txt' '.kimi-code/AGENTS.md'",
    );
    expect(prepared.command).not.toContain("Begin the assigned task.");
    expect(prepared.command).toContain("KIMI_MODEL_THINKING_EFFORT='high'");
    expect(prepared.command).not.toContain("secret-token");
    // Both env prefixes belong directly in front of kimi, after the brief
    // install: an assignment placed ahead of `install` would reach that
    // command instead, and kimi would connect unauthorized.
    expect(prepared.command).toContain(
      ` && ${HIVE_CAPABILITY_TOKEN_ENV}="$(cat '${credentialPath("maya")}')" ` +
        `KIMI_MODEL_THINKING_EFFORT='high' 'kimi'`,
    );
    const mcp = await readFile(join(root, ".kimi-code", "mcp.json"), "utf8");
    expect(mcp).not.toContain("secret-token");
    expect(mcp).toContain(
      `"bearerTokenEnvVar": "${HIVE_CAPABILITY_TOKEN_ENV}"`,
    );
    expect(mcp).toContain("http://127.0.0.1:41000/mcp");
  });

  test("recovery discovery uses state.json creation evidence and refuses ambiguity", async () => {
    const home = await worktree();
    const target = resolve(join(home, "worktree"));
    const state = async (
      session: string,
      createdAt: string,
      workDir = target,
    ) => {
      const directory = join(home, "sessions", "wd_test", session);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "state.json"),
        JSON.stringify({
          createdAt,
          workDir,
        }),
      );
    };
    await state("session_old", "2026-07-13T11:59:59.000Z");
    expect(
      await discoverKimiRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        home,
      ),
    ).toBeNull();

    await state("session_current", "2026-07-13T12:00:01.000Z");
    // A session for another worktree is never a candidate.
    await state(
      "session_elsewhere",
      "2026-07-13T12:00:02.000Z",
      join(home, "other"),
    );
    expect(
      await discoverKimiRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        home,
      ),
    ).toBe("session_current");

    await state("session_second", "2026-07-13T12:00:03.000Z");
    expect(
      discoverKimiRecoverySessionId(target, "2026-07-13T12:00:00.000Z", home),
    ).rejects.toBeInstanceOf(RecoverySessionDiscoveryError);

    // A state file without a valid creation timestamp is invalid evidence.
    await rm(join(home, "sessions", "wd_test", "session_second"), {
      recursive: true,
    });
    await mkdir(join(home, "sessions", "wd_test", "session_broken"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "wd_test", "session_broken", "state.json"),
      JSON.stringify({ workDir: target }),
    );
    expect(
      discoverKimiRecoverySessionId(target, "2026-07-13T12:00:00.000Z", home),
    ).rejects.toMatchObject({
      name: "RecoverySessionDiscoveryError",
      reason: "invalid-evidence",
    });
  });
});

describe("read-only containment is reported, never faked", () => {
  /**
   * Kimi has no per-launch deny channel: its only permission surface is the
   * operator's global config.toml, which Hive must not write (that gate belongs
   * to the user). So a Hive "read-only" Kimi agent under an operator default of
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
        expect(gap).toContain("Hive does not write vendor config");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reporting the gap never writes the operator's config", async () => {
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
