import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { grokAgentAdapter } from "../../../src/adapters/providers/grok-adapter";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  discoverGrokRecoverySessionId,
  findLatestGrokSessionId,
  GROK_COMPATIBILITY_ENV,
  grokHookFilename,
  inspectGrokProjectTrust,
  parseGrokCliVersion,
  probeGrokCliVersion,
  readLiveGrokModel,
  removeGrokAgentConfig,
  seedGrokRepositoryTrust,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
} from "../../../src/adapters/providers/grok-cli";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../../../src/adapters/providers/shared/capability-env";
import { RecoverySessionDiscoveryError } from "../../../src/adapters/providers/shared/recovery-session";

/** The path grok's trust store is keyed by: /tmp is a symlink on macOS. */
const resolveReal = (path: string): Promise<string> =>
  realpath(path).catch(() => resolve(path));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Grok adapter", () => {
  const writer = {
    model: "catalog-model",
    worktreePath: "/tmp/worktree",
    readOnly: false,
  } as const;

  test("launches a writer with model and optional effort on argv", () => {
    expect(buildGrokSpawnCommand(writer)).toEqual([
      "grok",
      "--no-auto-update",
      "-m",
      "catalog-model",
      "--always-approve",
    ]);
    expect(buildGrokSpawnCommand({ ...writer, effort: "high" })).toEqual([
      "grok",
      "--no-auto-update",
      "-m",
      "catalog-model",
      "--reasoning-effort",
      "high",
      "--always-approve",
    ]);
  });

  // Hive names the session at launch because Grok never reports one: it drives
  // no hook channel, so every reader otherwise has to guess which session on
  // disk belongs to this agent, and a respawn into a reused worktree reads its
  // dead predecessor's. Measured against the real CLI: --session-id accepts a
  // v4 crypto.randomUUID() and creates the session directory under that id.
  test("names a new session on argv, and never on a resume", () => {
    const sessionId = "3f8b2c1a-9d4e-4f6b-8a2c-1e5d7b9c3a0f";
    expect(buildGrokSpawnCommand({ ...writer, sessionId })).toEqual([
      "grok",
      "--no-auto-update",
      "-m",
      "catalog-model",
      "--always-approve",
      "--session-id",
      sessionId,
    ]);
    // The CLI rejects --session-id on resume (it names a NEW conversation), so
    // the resume path carries -r and nothing else.
    expect(buildGrokResumeCommand({ ...writer, sessionId }, sessionId)).toEqual(
      [
        "grok",
        "--no-auto-update",
        "-r",
        sessionId,
        "-m",
        "catalog-model",
        "--always-approve",
      ],
    );
  });

  test("uses the cross-model reader barrier", () => {
    expect(buildGrokSpawnCommand({ ...writer, readOnly: true })).toEqual([
      "grok",
      "--no-auto-update",
      "-m",
      "catalog-model",
      "--deny",
      "Bash",
      "--deny",
      "Write",
      "--deny",
      "Edit",
      "--allow",
      "MCPTool",
      "--allow",
      "Read",
      "--allow",
      "Grep",
    ]);
  });

  test("resume uses -r and replays current process flags, never --session-id", () => {
    const command = buildGrokResumeCommand(writer, "019f-session");
    expect(command).toEqual([
      "grok",
      "--no-auto-update",
      "-r",
      "019f-session",
      "-m",
      "catalog-model",
      "--always-approve",
    ]);
    expect(command).not.toContain("--session-id");
  });

  test("sets every compatibility import switch to false", () => {
    expect(Object.keys(GROK_COMPATIBILITY_ENV)).toHaveLength(10);
    expect(new Set(Object.values(GROK_COMPATIBILITY_ENV))).toEqual(
      new Set(["false"]),
    );
    const command = wrapGrokSpawnWithCompatibilityEnv("grok -m model");
    for (const key of Object.keys(GROK_COMPATIBILITY_ENV)) {
      expect(command).toContain(`${key}=false`);
    }
  });

  test("parses only the vendor version identity shape", () => {
    expect(
      parseGrokCliVersion("grok 0.2.93 (f00f96316d4b) [stable]\n"),
    ).toEqual({
      version: "0.2.93",
      buildHash: "f00f96316d4b",
      channel: "stable",
    });
    const current = parseGrokCliVersion("grok 0.2.101 (5bc4b5dfadcf)");
    expect(current).not.toBeNull();
    expect(current).toEqual({
      version: "0.2.101",
      buildHash: "5bc4b5dfadcf",
      channel: null,
    });
    expect(parseGrokCliVersion("0.2.93")).toBeNull();
  });

  test("gates availability on command success, not version recognition", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-version-"));
    roots.push(root);
    const executable = async (name: string, output: string, exitCode = 0) => {
      const path = join(root, name);
      await writeFile(
        path,
        [
          "#!/bin/sh",
          `printf '%s\\n' '${output}'`,
          `exit ${exitCode}`,
          "",
        ].join("\n"),
      );
      await chmod(path, 0o755);
      return path;
    };

    const current = await executable("current", "grok 0.2.101 (5bc4b5dfadcf)");
    expect(probeGrokCliVersion(current)).toEqual({
      version: "0.2.101",
      buildHash: "5bc4b5dfadcf",
      channel: null,
    });

    const future = await executable("future", "grok-cli v9 nightly");
    expect(probeGrokCliVersion(future)).toEqual({
      version: null,
      buildHash: null,
      channel: null,
    });

    const failed = await executable("failed", "grok-cli v9 nightly", 1);
    expect(probeGrokCliVersion(failed)).toBeNull();
    expect(probeGrokCliVersion(join(root, "missing"))).toBeNull();
  });

  test("writes project MCPs with capability auth and preserves unrelated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-config-"));
    roots.push(root);
    await mkdir(join(root, ".grok"));
    await writeFile(
      join(root, ".grok", "config.toml"),
      [
        'theme = "dark"',
        "[unrelated]",
        "keep = true",
        "[mcp_servers.hive]",
        'url = "http://stale"',
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n"),
    );
    await writeGrokAgentConfig(root, {
      daemonPort: 4317,
      name: "maya",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000220",
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    const content = await readFile(join(root, ".grok", "config.toml"), "utf8");
    expect(content).toContain('theme = "dark"');
    expect(content).toContain("[unrelated]\nkeep = true");
    expect(content).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(content).not.toContain("http://stale");
    expect(content).toContain('url = "http://127.0.0.1:4317/mcp"');
    // The bearer is named, never written: grok expands ${VAR} at load time, so
    // no live token lands in a file the project can commit.
    expect(content).toContain(
      `Authorization = "Bearer \${${HIVE_CAPABILITY_TOKEN_ENV}}"`,
    );
    expect(content).toContain('url = "http://127.0.0.1:7799/mcp"');
    expect(Bun.TOML.parse(content)).toBeDefined();

    expect(await removeGrokAgentConfig(root)).toBe(true);
    const cleaned = await readFile(join(root, ".grok", "config.toml"), "utf8");
    expect(cleaned).toContain('theme = "dark"');
    expect(cleaned).toContain("[mcp_servers.other]");
    expect(cleaned).not.toContain("[mcp_servers.hive]");
    expect(cleaned).not.toContain("[mcp_servers.graphify]");
    expect(await readdir(join(root, ".grok", "hooks"))).toEqual([]);
  });

  test("writes only real Grok lifecycle hooks with the exact run binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-hooks-"));
    roots.push(root);
    const runId = "018f1e90-7b5a-7cc0-8000-000000000221";
    await writeGrokAgentConfig(root, {
      daemonPort: 4317,
      name: "maya",
      providerRunId: runId,
      hiveCommand: ["/opt/Hive App/bin/hive"],
    });
    const parsed = JSON.parse(
      await readFile(join(root, ".grok", "hooks", grokHookFilename()), "utf8"),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      [
        "PostCompact",
        "PostToolUse",
        "PostToolUseFailure",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "StopFailure",
        "UserPromptSubmit",
      ].sort(),
    );
    expect(JSON.stringify(parsed)).not.toContain("TaskCreated");
    expect(JSON.stringify(parsed)).not.toContain("TaskCompleted");
    for (const entries of Object.values(parsed.hooks)) {
      expect(entries[0]?.hooks[0]?.command).toContain(
        `--provider-run-id '${runId}'`,
      );
      expect(entries[0]?.hooks[0]?.command).toContain(
        "'/opt/Hive App/bin/hive' event",
      );
    }
  });

  test("attaches the graphify gate hook only when graphify is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-graphify-"));
    roots.push(root);
    const base = {
      daemonPort: 4318,
      name: "maya",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000222",
    };
    const readHooks = async () =>
      JSON.parse(
        await readFile(
          join(root, ".grok", "hooks", grokHookFilename()),
          "utf8",
        ),
      ) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };

    await writeGrokAgentConfig(root, base);
    expect(JSON.stringify((await readHooks()).hooks.PreToolUse)).not.toContain(
      "hive-graphify-hook.sh",
    );
    expect(
      stat(join(root, ".grok", "hive-graphify-hook.sh")),
    ).rejects.toThrow();

    await writeGrokAgentConfig(root, {
      ...base,
      graphifyUrl: "http://127.0.0.1:4319/mcp",
    });
    const entries = (await readHooks()).hooks.PreToolUse ?? [];
    // The lifecycle hook keeps its slot; the gate is a second entry, and Grok's
    // own tool names — not a matcher — are what it filters on.
    expect(entries[0]?.hooks[0]?.command).toContain(" event tool-start");
    expect(entries[1]?.hooks[0]?.command).toBe(
      `'${join(root, ".grok", "hive-graphify-hook.sh")}' grok`,
    );
    expect(
      await readFile(join(root, ".grok", "hive-graphify-hook.sh"), "utf8"),
    ).toContain("*read_file*|*search_tool*|*list_dir*");
  });

  test("preserves a user's colliding hook file instead of overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-user-hook-"));
    roots.push(root);
    await mkdir(join(root, ".grok", "hooks"), { recursive: true });
    const userHook =
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}\n';
    await writeFile(join(root, ".grok", "hooks", grokHookFilename()), userHook);
    await writeGrokAgentConfig(root, {
      daemonPort: 4317,
      name: "maya",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000222",
    });
    expect(
      await readFile(join(root, ".grok", "hooks", grokHookFilename()), "utf8"),
    ).toBe(userHook);
    expect(
      (await readdir(join(root, ".grok", "hooks"))).filter(
        (name) => name !== grokHookFilename(),
      ),
    ).toHaveLength(1);
  });

  test("detects both grok inspect trust states without changing capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-trust-"));
    roots.push(root);
    const executable = async (name: string, trusted: "yes" | "no") => {
      const path = join(root, name);
      await writeFile(
        path,
        `#!/bin/sh\nprintf '%s\\n' 'Project trusted: ${trusted}'\n`,
      );
      await chmod(path, 0o755);
      return path;
    };
    expect(
      inspectGrokProjectTrust(root, await executable("trusted", "yes")),
    ).toBe("trusted");
    expect(
      inspectGrokProjectTrust(root, await executable("untrusted", "no")),
    ).toBe("untrusted");
    expect(inspectGrokProjectTrust(root, join(root, "missing"))).toBe(
      "unknown",
    );
  });

  // Trust withholds repo-local MCP servers, not just hooks: an untrusted
  // worktree never reaches the daemon and dies on the reporting deadline.
  // Refuse up front, naming the gate and the one-time remedy.
  test("an untrusted worktree is REFUSED, naming the gate and the one-time remedy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-grok-untrusted-"));
    roots.push(root);
    const executable = join(root, "grok");
    await writeFile(
      executable,
      "#!/bin/sh\nprintf '%s\\n' 'Project trusted: no'\n",
    );
    await chmod(executable, 0o755);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refusal = await grokAgentAdapter
        .prepareSpawn({
          name: "maya",
          model: "grok-4",
          worktreePath: root,
          daemonPort: 4317,
          readOnly: false,
          dangerous: false,
          executable,
          providerRunId: "018f1e90-7b5a-7cc0-8000-000000000224",
        })
        .then(
          () => null,
          (error: Error) => error.message,
        );
      expect(refusal).not.toBeNull();
      // The refusal has to name what is withheld and what to do about it. A
      // message that only said "untrusted" would reproduce the original bug in
      // a faster form: a user who cannot act on it still loses the agent.
      expect(refusal).toContain("MCP server");
      expect(refusal).toContain("trust prompt");
      expect(refusal).toContain("inherits");
      // The config is still written before the check, and still on disk. The
      // trust decision is ABOUT that config, so skipping the write would make
      // the folder read trusted and the refusal would never fire.
      expect(
        await readFile(
          join(root, ".grok", "hooks", grokHookFilename()),
          "utf8",
        ),
      ).toContain("018f1e90-7b5a-7cc0-8000-000000000224");

      warning.mockClear();
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, ".claude", "settings.json"), "{}\n");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf '%s\\n' 'Project trusted: yes'\n",
      );
      await grokAgentAdapter.prepareSpawn({
        name: "maya",
        model: "grok-4",
        worktreePath: root,
        daemonPort: 4317,
        readOnly: false,
        dangerous: false,
        executable,
        providerRunId: "018f1e90-7b5a-7cc0-8000-000000000225",
      });
      // The disclosure must name settings.local.json, which is the file that
      // actually exists in a Hive worktree; naming only settings.json warned
      // about the one least likely to fire.
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(".claude/settings.local.json"),
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(".claude/settings.json"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("seeds a repository's trust once, preserving every other decision", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-trusthome-"));
    const repository = await mkdtemp(join(tmpdir(), "hive-grok-repo-"));
    roots.push(home, repository);
    const store = join(home, "trusted_folders.toml");
    await writeFile(
      store,
      '[folders."/Users/someone/Projects/theirs"]\ntrusted = true\ndecided_at = 1784143367\n',
    );

    expect(await seedGrokRepositoryTrust(repository, home)).toBe("seeded");
    const seeded = await readFile(store, "utf8");
    // The operator's own decisions are not collateral. Losing one would revoke
    // trust they granted for a repository Hive has nothing to do with.
    expect(seeded).toContain("/Users/someone/Projects/theirs");
    expect(seeded).toContain(await resolveReal(repository));
    expect(seeded).toContain("trusted = true");

    // Running Hive again is not a new decision.
    expect(await seedGrokRepositoryTrust(repository, home)).toBe(
      "already-decided",
    );
    expect(await readFile(store, "utf8")).toBe(seeded);
  });

  test("a deliberate `trusted = false` survives Hive seeding", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-trusthome-"));
    const repository = await mkdtemp(join(tmpdir(), "hive-grok-repo-"));
    roots.push(home, repository);
    const store = join(home, "trusted_folders.toml");
    const key = await resolveReal(repository);
    await writeFile(
      store,
      `[folders.${JSON.stringify(key)}]\ntrusted = false\ndecided_at = 1784143367\n`,
    );

    expect(await seedGrokRepositoryTrust(repository, home)).toBe(
      "already-decided",
    );
    // Seeding fills a gap. Turning a refusal into a grant would be Hive
    // overruling the user on the one decision this whole path says is theirs.
    expect(await readFile(store, "utf8")).toContain("trusted = false");
  });

  test("a vendor lock file left lying around does not block the seed", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-trusthome-"));
    const repository = await mkdtemp(join(tmpdir(), "hive-grok-repo-"));
    roots.push(home, repository);
    // Grok keeps `trusted_folders.toml.lock` present permanently. The first
    // version of the seed locked on exactly that path, and Hive's lock is
    // create-exclusive — so every seed timed out, returned "unwritable", and
    // the spawn then refused a repository Hive had just decided to trust. The
    // failure was silent and cost a whole live run to find.
    await writeFile(join(home, "trusted_folders.toml.lock"), "");

    expect(await seedGrokRepositoryTrust(repository, home)).toBe("seeded");
    expect(
      await readFile(join(home, "trusted_folders.toml"), "utf8"),
    ).toContain("trusted = true");
  });

  test.todo("trusted Grok 0.2.112 fires the written hook after quota resets 2026-07-26T17:18Z", () => {});

  test("resolves encoded and long-path sessions only by summary cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-home-"));
    roots.push(home);
    const worktree = resolve(join(home, "worktree"));
    const encoded = join(home, "sessions", encodeURIComponent(worktree));
    const long = join(home, "sessions", "worktree-deadbeef");
    await mkdir(join(encoded, "old"), { recursive: true });
    await mkdir(join(long, "new"), { recursive: true });
    await writeFile(
      join(encoded, "old", "summary.json"),
      JSON.stringify({
        info: { id: "old-id", cwd: worktree },
      }),
    );
    await writeFile(join(long, ".cwd"), `${worktree}\n`);
    await writeFile(
      join(long, "new", "summary.json"),
      JSON.stringify({
        info: { id: "new-id", cwd: worktree },
        current_model_id: "observed-model",
      }),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    const summary = join(long, "new", "summary.json");
    await writeFile(summary, await readFile(summary, "utf8"));
    expect(await findLatestGrokSessionId(worktree, home)).toBe("new-id");
    expect(await readLiveGrokModel(worktree, "new-id", home)).toBe(
      "observed-model",
    );

    await writeFile(
      summary,
      JSON.stringify({
        info: { id: "wrong-id", cwd: join(home, "other") },
      }),
    );
    expect(await findLatestGrokSessionId(worktree, home)).toBe("old-id");
  });

  test("refuses a summary whose session id key is unknown", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-drift-home-"));
    roots.push(home);
    const worktree = resolve(join(home, "worktree"));
    const project = join(home, "sessions", encodeURIComponent(worktree));
    await mkdir(join(project, "session"), { recursive: true });
    await writeFile(
      join(project, "session", "summary.json"),
      JSON.stringify({
        info: { sessionID: "drifted-session", cwd: worktree },
        current_model_id: "observed-model",
      }),
    );

    expect(findLatestGrokSessionId(worktree, home)).rejects.toThrow(
      "Invalid Grok summary",
    );
  });

  test("recovery discovery uses summary creation evidence and refuses ambiguity", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-recovery-home-"));
    roots.push(home);
    const worktree = resolve(join(home, "worktree"));
    const project = join(home, "sessions", encodeURIComponent(worktree));
    const summary = async (
      directory: string,
      id: string,
      timestampKey: string,
      timestamp: string,
    ) => {
      await mkdir(join(project, directory), { recursive: true });
      await writeFile(
        join(project, directory, "summary.json"),
        JSON.stringify({
          info: { id, cwd: worktree },
          [timestampKey]: timestamp,
        }),
      );
    };
    await summary(
      "predecessor",
      "predecessor",
      "created_at",
      "2026-07-13T11:59:59.000Z",
    );

    expect(
      await discoverGrokRecoverySessionId(
        worktree,
        "2026-07-13T12:00:00.000Z",
        home,
      ),
    ).toBeNull();
    await summary(
      "current",
      "current",
      "created_at",
      "2026-07-13T12:00:01.000Z",
    );
    await summary(
      "predecessor",
      "predecessor",
      "created_at",
      "2026-07-13T11:59:59.000Z",
    );

    expect(
      await discoverGrokRecoverySessionId(
        worktree,
        "2026-07-13T12:00:00.000Z",
        home,
      ),
    ).toBe("current");

    await summary(
      "second-current",
      "second-current",
      "created_at",
      "2026-07-13T12:00:02.000Z",
    );
    expect(
      discoverGrokRecoverySessionId(worktree, "2026-07-13T12:00:00.000Z", home),
    ).rejects.toBeInstanceOf(RecoverySessionDiscoveryError);
    await rm(join(project, "second-current"), { recursive: true });

    await summary(
      "unknown-evidence",
      "unknown-evidence",
      "createdAt",
      "2026-07-13T12:00:03.000Z",
    );
    expect(
      discoverGrokRecoverySessionId(worktree, "2026-07-13T12:00:00.000Z", home),
    ).rejects.toMatchObject({
      name: "RecoverySessionDiscoveryError",
      reason: "invalid-evidence",
    });
  });
});
