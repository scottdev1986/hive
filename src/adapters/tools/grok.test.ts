import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  discoverGrokRecoverySessionId,
  findLatestGrokSessionId,
  GROK_COMPATIBILITY_ENV,
  parseGrokCliVersion,
  probeGrokCliVersion,
  readLiveGrokModel,
  removeGrokAgentConfig,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
} from "./grok";
import { RecoverySessionDiscoveryError } from "./recovery-session";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("Grok adapter", () => {
  const writer = {
    model: "catalog-model",
    worktreePath: "/tmp/worktree",
    readOnly: false,
  } as const;

  test("launches a writer with model and optional effort on argv", () => {
    expect(buildGrokSpawnCommand(writer)).toEqual([
      "grok", "-m", "catalog-model", "--always-approve",
    ]);
    expect(buildGrokSpawnCommand({ ...writer, effort: "high" })).toEqual([
      "grok", "-m", "catalog-model", "--reasoning-effort", "high",
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
      "grok", "-m", "catalog-model", "--always-approve",
      "--session-id", sessionId,
    ]);
    // The CLI rejects --session-id on resume (it names a NEW conversation), so
    // the resume path carries -r and nothing else.
    expect(buildGrokResumeCommand({ ...writer, sessionId }, sessionId)).toEqual([
      "grok", "-r", sessionId, "-m", "catalog-model", "--always-approve",
    ]);
  });

  test("uses the cross-model reader barrier", () => {
    expect(buildGrokSpawnCommand({ ...writer, readOnly: true })).toEqual([
      "grok", "-m", "catalog-model",
      "--deny", "Bash",
      "--deny", "Write",
      "--deny", "Edit",
      "--allow", "MCPTool",
      "--allow", "Read",
      "--allow", "Grep",
    ]);
  });

  test("resume uses -r and replays current process flags, never --session-id", () => {
    const command = buildGrokResumeCommand(writer, "019f-session");
    expect(command).toEqual([
      "grok", "-r", "019f-session", "-m", "catalog-model",
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
    expect(parseGrokCliVersion("grok 0.2.93 (f00f96316d4b) [stable]\n"))
      .toEqual({ version: "0.2.93", buildHash: "f00f96316d4b", channel: "stable" });
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
      await writeFile(path, [
        "#!/bin/sh",
        `printf '%s\\n' '${output}'`,
        `exit ${exitCode}`,
        "",
      ].join("\n"));
      await chmod(path, 0o755);
      return path;
    };

    const current = await executable(
      "current",
      "grok 0.2.101 (5bc4b5dfadcf)",
    );
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
    await writeFile(join(root, ".grok", "config.toml"), [
      'theme = "dark"',
      "[unrelated]",
      "keep = true",
      "[mcp_servers.hive]",
      'url = "http://stale"',
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n"));
    await writeGrokAgentConfig(root, {
      daemonPort: 4317,
      capabilityToken: "secret-token",
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    });
    const content = await readFile(join(root, ".grok", "config.toml"), "utf8");
    expect(content).toContain('theme = "dark"');
    expect(content).toContain("[unrelated]\nkeep = true");
    expect(content).toContain("[mcp_servers.other]\ncommand = \"other\"");
    expect(content).not.toContain("http://stale");
    expect(content).toContain('url = "http://127.0.0.1:4317/mcp"');
    expect(content).toContain('Authorization = "Bearer secret-token"');
    expect(content).toContain('url = "http://127.0.0.1:7799/mcp"');
    expect(Bun.TOML.parse(content)).toBeDefined();

    expect(await removeGrokAgentConfig(root)).toBe(true);
    const cleaned = await readFile(join(root, ".grok", "config.toml"), "utf8");
    expect(cleaned).toContain('theme = "dark"');
    expect(cleaned).toContain("[mcp_servers.other]");
    expect(cleaned).not.toContain("[mcp_servers.hive]");
    expect(cleaned).not.toContain("[mcp_servers.graphify]");
  });

  test("resolves encoded and long-path sessions only by summary cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-home-"));
    roots.push(home);
    const worktree = resolve(join(home, "worktree"));
    const encoded = join(home, "sessions", encodeURIComponent(worktree));
    const long = join(home, "sessions", "worktree-deadbeef");
    await mkdir(join(encoded, "old"), { recursive: true });
    await mkdir(join(long, "new"), { recursive: true });
    await writeFile(join(encoded, "old", "summary.json"), JSON.stringify({
      info: { id: "old-id", cwd: worktree },
    }));
    await writeFile(join(long, ".cwd"), `${worktree}\n`);
    await writeFile(join(long, "new", "summary.json"), JSON.stringify({
      info: { id: "new-id", cwd: worktree },
      current_model_id: "observed-model",
    }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    const summary = join(long, "new", "summary.json");
    await writeFile(summary, await readFile(summary, "utf8"));
    expect(await findLatestGrokSessionId(worktree, home)).toBe("new-id");
    expect(await readLiveGrokModel(worktree, "new-id", home)).toBe(
      "observed-model",
    );

    await writeFile(summary, JSON.stringify({
      info: { id: "wrong-id", cwd: join(home, "other") },
    }));
    expect(await findLatestGrokSessionId(worktree, home)).toBe("old-id");
  });

  test("refuses a summary whose session id key is unknown", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-grok-drift-home-"));
    roots.push(home);
    const worktree = resolve(join(home, "worktree"));
    const project = join(home, "sessions", encodeURIComponent(worktree));
    await mkdir(join(project, "session"), { recursive: true });
    await writeFile(join(project, "session", "summary.json"), JSON.stringify({
      info: { sessionID: "drifted-session", cwd: worktree },
      current_model_id: "observed-model",
    }));

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
      await writeFile(join(project, directory, "summary.json"), JSON.stringify({
        info: { id, cwd: worktree },
        [timestampKey]: timestamp,
      }));
    };
    await summary(
      "predecessor",
      "predecessor",
      "created_at",
      "2026-07-13T11:59:59.000Z",
    );

    expect(await discoverGrokRecoverySessionId(
      worktree,
      "2026-07-13T12:00:00.000Z",
      home,
    )).toBeNull();
    await summary("current", "current", "created_at", "2026-07-13T12:00:01.000Z");
    await summary(
      "predecessor",
      "predecessor",
      "created_at",
      "2026-07-13T11:59:59.000Z",
    );

    expect(await discoverGrokRecoverySessionId(
      worktree,
      "2026-07-13T12:00:00.000Z",
      home,
    )).toBe("current");

    await summary(
      "second-current",
      "second-current",
      "created_at",
      "2026-07-13T12:00:02.000Z",
    );
    expect(discoverGrokRecoverySessionId(
      worktree,
      "2026-07-13T12:00:00.000Z",
      home,
    )).rejects.toBeInstanceOf(RecoverySessionDiscoveryError);
    await rm(join(project, "second-current"), { recursive: true });

    await summary(
      "unknown-evidence",
      "unknown-evidence",
      "createdAt",
      "2026-07-13T12:00:03.000Z",
    );
    expect(discoverGrokRecoverySessionId(
      worktree,
      "2026-07-13T12:00:00.000Z",
      home,
    )).rejects.toMatchObject({
      name: "RecoverySessionDiscoveryError",
      reason: "invalid-evidence",
    });
  });
});
