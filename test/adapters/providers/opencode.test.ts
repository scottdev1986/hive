import { afterEach, describe, expect, test } from "bun:test";
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
import { join, resolve } from "node:path";
import {
  buildOpencodeResumeCommand,
  buildOpencodeSpawnCommand,
  discoverOpencodeRecoverySessionId,
  OPENCODE_HIVE_AGENT,
  probeOpencodeDefaultModel,
  writeOpencodeAgentConfig,
} from "../../../src/adapters/providers/opencode-cli";
import { getAgentAdapter } from "../../../src/adapters/providers/provider-registry";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../../../src/adapters/providers/shared/capability-env";
import { RecoverySessionDiscoveryError } from "../../../src/adapters/providers/shared/recovery-session";
import { credentialPath } from "../../../src/daemon/credentials";

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

  test("resume uses -s and replays current process flags", () => {
    expect(
      buildOpencodeResumeCommand(
        { ...writer, agent: OPENCODE_HIVE_AGENT },
        "ses_abc",
      ),
    ).toEqual([
      "opencode",
      "-s",
      "ses_abc",
      "-m",
      "openai/gpt-5.5",
      "--agent",
      "hive",
    ]);
    expect(buildOpencodeSpawnCommand(writer)).not.toContain("-s");
  });

  test("reads the effective default only from the global config model key", async () => {
    const directory = await worktree();
    expect(probeOpencodeDefaultModel(directory)).toBeNull();
    await writeFile(
      join(directory, "opencode.jsonc"),
      '// comment\n{ "model": "openai/gpt-5.5" }\n',
    );
    expect(probeOpencodeDefaultModel(directory)).toBe("openai/gpt-5.5");
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
    const written = JSON.parse(await readFile(path, "utf8")) as {
      agent: Record<string, Record<string, unknown>>;
      mcp: Record<string, Record<string, unknown>>;
      permission: Record<string, unknown>;
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
    expect(written.agent.hive).toEqual({
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      prompt: "{file:/tmp/prompt.txt}",
      permission: { edit: "deny", bash: "deny" },
    });
    // The agent block alone is not the barrier. A subagent spawned through the
    // `task` tool runs as a different agent and falls back to the global block,
    // so read-only has to be global or the subagent keeps bash and edit.
    // Source: https://opencode.ai/docs/permissions/ (checked 2026-07-25).
    expect(written.permission).toEqual({ edit: "deny", bash: "deny" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // A respawn without a fresh token or brief keeps both, and a missing
    // graphify URL removes the stale endpoint.
    await writeOpencodeAgentConfig(root, { daemonPort: 4400 });
    const respawned = JSON.parse(await readFile(path, "utf8")) as {
      agent: Record<string, Record<string, unknown>>;
      mcp: Record<string, Record<string, unknown>>;
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
    expect(respawned.agent.hive).toEqual(written.agent.hive);
  });

  test("a writer's agent carries no permission set, so bash stays reachable", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      readOnly: false,
    });
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as { agent: Record<string, Record<string, unknown>> };
    // Measured against opencode 1.18.5: a blanket `bash: "deny"` removes the
    // tool from the model's tool list rather than refusing calls, so a writer
    // that inherits the barrier has no shell at all and cannot run `git log`.
    expect(written.agent.hive).not.toHaveProperty("permission");
  });

  test("prepareSpawn keeps the token out of argv and passes the kickoff as --prompt", async () => {
    const root = await worktree();
    const prepared = await getAgentAdapter("opencode").prepareSpawn({
      name: "maya",
      model: "openai/gpt-5.5",
      worktreePath: root,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      withCapability: true,
      instructionPath: "/tmp/prompt.txt",
      kickoff: "Begin the assigned task.",
    });
    expect(prepared.argv).toEqual([
      "opencode",
      "-m",
      "openai/gpt-5.5",
      "--agent",
      "hive",
    ]);
    expect(prepared.command).toBe(
      `${HIVE_CAPABILITY_TOKEN_ENV}="$(cat '${credentialPath("maya")}')" ` +
        `${prepared.argv.map((token) => `'${token}'`).join(" ")} '--prompt' 'Begin the assigned task.'`,
    );
    expect(prepared.command).not.toContain("secret-token");
    const config = await readFile(join(root, "opencode.json"), "utf8");
    expect(config).not.toContain("secret-token");
    expect(config).toContain(`Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}`);
    expect(config).toContain("{file:/tmp/prompt.txt}");
  });

  test("the orchestrator role replaces the read-only barrier with scoped grants", async () => {
    const root = await worktree();
    await writeOpencodeAgentConfig(root, {
      daemonPort: 4317,
      instructionPath: "/tmp/prompt.txt",
      orchestrator: true,
    });
    const written = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as { agent: Record<string, Record<string, unknown>> };
    expect(written.agent.hive).toEqual({
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      prompt: "{file:/tmp/prompt.txt}",
      permission: {
        edit: { "*": "deny", ".hive/**": "allow", "planning/**": "allow" },
        bash: { "*": "ask", "gh *": "allow" },
      },
    });
  });

  test("recovery discovery matches the session's own directory and refuses ambiguity", async () => {
    const home = await worktree();
    const target = resolve(join(home, "worktree"));
    await mkdir(target, { recursive: true });
    // A fake opencode CLI answering `session list --format json`.
    const sessions: Array<Record<string, unknown>> = [];
    const fake = join(home, "opencode-fake");
    await writeFile(
      fake,
      ["#!/bin/sh", `printf '%s' '${JSON.stringify(sessions)}'`, ""].join("\n"),
    );
    await chmod(fake, 0o755);
    expect(
      await discoverOpencodeRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        fake,
      ),
    ).toBeNull();

    const writeSessions = async (entries: Array<Record<string, unknown>>) =>
      writeFile(
        fake,
        ["#!/bin/sh", `printf '%s' '${JSON.stringify(entries)}'`, ""].join(
          "\n",
        ),
      );
    // A session for another directory is never a candidate.
    await writeSessions([
      {
        id: "ses_other",
        created: 1783952059000,
        directory: join(home, "other"),
      },
      {
        id: "ses_old",
        created: Date.parse("2026-07-13T11:59:59.000Z"),
        directory: target,
      },
    ]);
    expect(
      await discoverOpencodeRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        fake,
      ),
    ).toBeNull();

    await writeSessions([
      {
        id: "ses_old",
        created: Date.parse("2026-07-13T11:59:59.000Z"),
        directory: target,
      },
      {
        id: "ses_current",
        created: Date.parse("2026-07-13T12:00:01.000Z"),
        directory: target,
      },
    ]);
    expect(
      await discoverOpencodeRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        fake,
      ),
    ).toBe("ses_current");

    await writeSessions([
      {
        id: "ses_a",
        created: Date.parse("2026-07-13T12:00:01.000Z"),
        directory: target,
      },
      {
        id: "ses_b",
        created: Date.parse("2026-07-13T12:00:02.000Z"),
        directory: target,
      },
    ]);
    expect(
      discoverOpencodeRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        fake,
      ),
    ).rejects.toBeInstanceOf(RecoverySessionDiscoveryError);

    // A CLI that cannot answer at all is no candidates, never an error.
    await writeFile(fake, "#!/bin/sh\nexit 1\n");
    await chmod(fake, 0o755);
    expect(
      await discoverOpencodeRecoverySessionId(
        target,
        "2026-07-13T12:00:00.000Z",
        fake,
      ),
    ).toBeNull();
  });
});
