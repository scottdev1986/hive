/**
 * The real thing, end to end — the regression suite for the field-test
 * failures. No in-process fakes anywhere: every scenario runs the actual CLI
 * (`bun src/cli.ts …`) as a subprocess against the real daemon it spawns, a
 * real sqlite file under a throwaway HIVE_HOME, real HTTP on a real port, and
 * a real (private-socket) tmux server.
 *
 * Two hard rules:
 *   - Never invoke the real `claude` or `codex` binaries: they bill. The
 *     daemon's startup quota probes would exec them, so the suite prepends a
 *     PATH shim directory whose `claude`/`codex` stubs exit 1 — a process
 *     boundary, not an in-process mock.
 *   - Opt-in only: the suite skips (visibly) unless HIVE_E2E=1 and tmux is on
 *     PATH. CI sets HIVE_E2E=1; locally run `HIVE_E2E=1 bun test`.
 *
 * The scenarios are ordered. Init is proved daemon-free first; the suite then
 * starts one real daemon explicitly for the remaining transport checks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunTmuxSender } from "../daemon/delivery";
import { TmuxAdapter } from "../adapters/tmux";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";

const enabled = process.env.HIVE_E2E === "1" && Bun.which("tmux") !== null;
if (!enabled) {
  console.warn(
    "Skipping the real-CLI e2e suite (src/cli/e2e-real.test.ts): " +
      "set HIVE_E2E=1 with tmux on PATH to run it.",
  );
}
const e2e = enabled ? describe : describe.skip;

const CLI = join(import.meta.dir, "../cli.ts");
const MINUTE = 60_000;

let hiveHome = "";
let installRoot = "";
let repo = "";
let shims = "";
let port = 0;
let env: Record<string, string> = {};
let daemonProcess: ReturnType<typeof Bun.spawn> | null = null;

const tmuxSocket = `hive-e2e-${process.pid}`;
const tmux = new TmuxAdapter(tmuxSocket);

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${root}`);
  }
}

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run the real binary: `bun src/cli.ts <args>` in the temp repo. */
async function runCli(args: string[]): Promise<CliRun> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: repo,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function until(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Reads NDJSON lines off a subprocess pipe as they arrive. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];
  return {
    async next(timeoutMs = 15_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (pending.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for a feed line");
        }
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => null),
        ]);
        if (chunk === null) {
          throw new Error("Timed out waiting for a feed line");
        }
        if (chunk.done) {
          if (buffer.trim().length > 0) {
            pending.push(buffer.trim());
            buffer = "";
            break;
          }
          throw new Error("Feed stdout ended before a line arrived");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        pending.push(...lines.filter((line) => line.trim().length > 0));
      }
      return pending.shift()!;
    },
    release(): void {
      reader.releaseLock();
    },
  };
}

beforeAll(async () => {
  if (!enabled) return;
  hiveHome = await mkdtemp(join(tmpdir(), "hive-e2e-home-"));
  installRoot = await mkdtemp(join(tmpdir(), "hive-e2e-install-"));
  repo = await mkdtemp(join(tmpdir(), "hive-e2e-repo-"));
  shims = join(hiveHome, "shims");
  await mkdir(shims, { recursive: true });

  // Billable-CLI tripwires. The daemon's startup quota probes exec `claude`
  // and `codex`; these stubs take the exec instead and fail fast, which the
  // probes treat as "provider unavailable" and carry on.
  for (const tool of ["claude", "codex"]) {
    const shim = join(shims, tool);
    await writeFile(shim, `#!/bin/sh\necho "${tool} shim: refusing" >&2\nexit 1\n`);
    await chmod(shim, 0o755);
  }

  // A repo the profiler can read: a manifest with scripts, a doc, one commit.
  git(repo, ["init"]);
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "e2e-fixture", scripts: { test: "bun test" } }),
  );
  await writeFile(join(repo, "SPEC.md"), "# Spec\n\nv1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init", "--no-gpg-sign"]);

  // A port nothing else is using: bind 0, note the number, release it.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port!;
  probe.stop(true);

  env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH ?? ""}`,
    HIVE_HOME: hiveHome,
    HIVE_PORT: String(port),
    HIVE_INSTALL_ROOT: installRoot,
  };
  delete (env as Record<string, string | undefined>).HIVE_PROJECT_ROOT;
  delete (env as Record<string, string | undefined>).HIVE_PROJECT_ID;
});

afterAll(async () => {
  if (!enabled) return;
  // Belt and braces: `hive stop` is itself under test, so never rely on it.
  try {
    const pid = Number.parseInt(
      await readFile(join(hiveHome, "daemon.pid"), "utf8"),
      10,
    );
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // Already stopped, as the last scenario asserts.
  }
  daemonProcess?.kill("SIGKILL");
  await Bun.spawn(["tmux", "-L", tmuxSocket, "kill-server"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  for (const dir of [hiveHome, installRoot, repo]) {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  }
});

e2e("real hive CLI against a real daemon and real tmux", () => {
  /** The profile Hive cached for `repo`, wherever under its home it put it. */
  const cachedProfile = async (): Promise<string> => {
    const glob = new Bun.Glob("projects/*/profile.toml");
    for await (const hit of glob.scan({ cwd: hiveHome, absolute: true })) return hit;
    throw new Error(`no profile cached under ${hiveHome}`);
  };

  test("hive init profiles a fresh repo without starting a daemon", async () => {
    const run = await runCli(["init"]);
    const output = run.stdout + run.stderr;
    expect(run.exitCode).toEqual(0);
    // The profile is Hive's own state: it goes under HIVE_HOME…
    expect(existsSync(await cachedProfile())).toEqual(true);
    // …and the repo is left exactly as the user had it. Nothing to commit.
    expect(existsSync(join(repo, ".hive", "profile.toml"))).toEqual(false);
    expect(output).not.toContain("daemon port");
    expect(existsSync(join(hiveHome, "daemon.lock"))).toEqual(false);
    expect(existsSync(join(hiveHome, "daemon.pid"))).toEqual(false);
    expect(existsSync(join(hiveHome, "daemon.port"))).toEqual(false);
    expect(await health()).toEqual(false);
  }, MINUTE);

  test("a second hive init is a no-op, and never asks for a third — the field-test regression", async () => {
    const profilePath = await cachedProfile();
    const before = await readFile(profilePath, "utf8");
    const mtimeBefore = (await stat(profilePath)).mtimeMs;

    const run = await runCli(["init"]);
    const output = run.stdout + run.stderr;
    expect(run.exitCode).toEqual(0);
    // Not rewritten, not even touched.
    expect(await readFile(profilePath, "utf8")).toEqual(before);
    expect((await stat(profilePath)).mtimeMs).toEqual(mtimeBefore);
    // And it does not close by naming another command to run. The profile is
    // never stale in a way anyone has to fix, so there is nothing to say.
    expect(output).not.toContain("--refresh");
    expect(output).not.toContain("hive memory reindex");
    expect(output).not.toContain("stale");
    expect(await health()).toEqual(false);
  }, MINUTE);

  test("the daemon begins only when the launch boundary is crossed", async () => {
    daemonProcess = Bun.spawn([process.execPath, CLI, "daemon"], {
      cwd: repo,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await until(health, "daemon /health");
    expect(await health()).toEqual(true);
  }, MINUTE);

  test("the removed start subcommand is rejected", async () => {
    const run = await runCli(["start"]);
    const output = run.stdout + run.stderr;
    expect(run.exitCode).not.toEqual(0);
    expect(output).toContain("too many arguments");
    expect(output).not.toContain(`daemon port ${port}`);
  }, MINUTE);

  test("workspace-feed streams NDJSON snapshots and stops cleanly", async () => {
    const feed = Bun.spawn(
      [
        process.execPath,
        CLI,
        "workspace-feed",
        "--port",
        String(port),
        "--instance-id",
        hiveInstanceSuffix(hiveHome),
      ],
      {
        cwd: repo,
        env,
        stdin: "pipe", // held open: the app's end of the wire
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const lines = lineReader(feed.stdout);
    try {
      const first = JSON.parse(await lines.next()) as {
        v: number;
        agents?: unknown;
        error?: string;
      };
      expect(first.v).toEqual(1);
      expect(first.error).toBeUndefined();
      expect(Array.isArray(first.agents)).toEqual(true);

      feed.kill("SIGTERM");
      expect(await feed.exited).toEqual(0);
    } finally {
      lines.release();
      feed.kill("SIGKILL");
      await feed.exited;
    }
  }, MINUTE);

  test("the real tmux delivery path lands a message in a real pane", async () => {
    // BunTmuxSender is the exact sender the daemon's MessageDelivery uses;
    // pointing it at a private-socket tmux server keeps the user's own tmux
    // untouched while everything else — load-buffer, paste-buffer, the Enter
    // keystroke — is the production code path.
    const session = "hive-e2e-delivery";
    await tmux.newSession(session, repo, "cat");
    const sender = new BunTmuxSender(tmux);
    const probe = `hive e2e delivery probe ${Date.now()}`;
    await sender.sendMessage(session, probe);
    await until(
      async () => (await tmux.capturePane(session)).includes(probe),
      "the message to appear in the pane",
    );
    await tmux.killSession(session);
  }, MINUTE);

  test("hive stop tears the daemon down and cleans the lifecycle files", async () => {
    const run = await runCli(["stop"]);
    expect(run.exitCode).toEqual(0);
    expect(run.stdout).toContain("Hive daemon");
    await until(async () => !(await health()), "the daemon to stop answering");
    expect(existsSync(join(hiveHome, "daemon.pid"))).toEqual(false);
    expect(existsSync(join(hiveHome, "daemon.port"))).toEqual(false);
  }, MINUTE);
});
