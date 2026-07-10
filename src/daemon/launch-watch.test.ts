// Launch watch: drives a REAL `claude` CLI in a REAL tmux pane, inside a REAL
// linked git worktree, using exactly the config and argv a Hive spawn produces.
// It proves the property the whole spawn path exists to guarantee: a freshly
// created agent worktree reaches its first real turn with zero human input.
//
// Every first-run dialog Claude Code can raise at startup is a deadlock for an
// unattended agent, and each is suppressed by different state:
//
//   "Yes, I trust this folder"     <- projects[<worktree>].hasTrustDialogAccepted
//   "WARNING: Bypass Permissions"  <- skipDangerousModePermissionPrompt
//   "I am using this for local development"
//                                  <- unsuppressable; so we never pass
//                                     --dangerously-load-development-channels
//
// The run costs nothing: HOME points at a throwaway config with no credentials,
// so the session stops at "Not logged in" — but only *after* the UserPromptSubmit
// hook fires, which is the signal that the prompt was accepted and the turn
// began. A dialog would have blocked before that hook, so the hook is a precise
// witness. `hasCompletedOnboarding` is seeded because global onboarding is
// account-level state that Hive neither owns nor should touch.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSpawnCommand,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { shellJoin } from "../adapters/tmux";

const SESSION = `hive-launch-watch-${process.pid}`;
const PROMPT = "Reply with the single word READY.";
const DIALOG_MARKER = "Enter to confirm";

const claudeBinary = Bun.which("claude");
const tmuxBinary = Bun.which("tmux");
// Skip rather than fail on a machine without the real CLIs; there is nothing to
// watch and a red test there would say nothing about Hive.
const runnable = claudeBinary !== null && tmuxBinary !== null;
const suite = runnable ? describe : describe.skip;

let temporaryRoot = "";

const run = async (argv: string[], cwd?: string): Promise<void> => {
  const child = Bun.spawn(argv, {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await child.exited !== 0) {
    throw new Error(`command failed: ${argv.join(" ")}`);
  }
};

const tmux = (...args: string[]): Promise<void> => run([tmuxBinary!, ...args]);

const capturePane = async (): Promise<string> => {
  const child = Bun.spawn([tmuxBinary!, "capture-pane", "-p", "-t", SESSION], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return text;
};

afterAll(async () => {
  if (!runnable) return;
  await tmux("kill-session", "-t", SESSION).catch(() => undefined);
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

suite("Claude spawn launch watch", () => {
  test(
    "a fresh agent worktree reaches its first turn with no interactive prompt",
    async () => {
      temporaryRoot = await mkdtemp(join(tmpdir(), "hive-launch-watch-"));
      const repository = join(temporaryRoot, "repo");
      const worktree = join(temporaryRoot, "worktree");
      const home = join(temporaryRoot, "home");
      const binectory = join(temporaryRoot, "bin");
      const hookLog = join(temporaryRoot, "hooks.log");

      // A Hive worktree is a *linked* worktree, and Claude Code resolves trust
      // differently for those than for a standalone clone. Reproduce the shape.
      await mkdir(repository, { recursive: true });
      await run(["git", "init", "-q", repository]);
      await run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "--allow-empty", "-m", "init"], repository);
      await run(["git", "worktree", "add", "-q", worktree, "-b",
        "hive/launch-watch"], repository);

      // An onboarded but unauthenticated operator: no project is trusted, and
      // nothing here grants the bypass disclaimer.
      //
      // tengu_harbor is the cached flag that turns Channels on. Without it the
      // CLI skips the development-channels dialog entirely, and this watch
      // would go green even if a spawn started passing the flag again. Seed it
      // so the third dialog is armed and a regression is actually caught.
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          oauthAccount: { emailAddress: "launch-watch@example.invalid" },
          cachedGrowthBookFeatures: { tengu_harbor: true },
          cachedGrowthBookFeaturesAt: Date.now(),
        }),
      );

      // Hive's hooks shell out to `hive`. Shim it so the hooks are observable
      // and can never reach a real daemon.
      await mkdir(binectory, { recursive: true });
      const shim = join(binectory, "hive");
      await writeFile(shim, `#!/bin/sh\necho "$@" >> ${JSON.stringify(hookLog)}\nexit 0\n`);
      await chmod(shim, 0o755);

      // Exactly what a real spawn of a dangerous writer does.
      await seedClaudeWorktreeTrust(worktree, home);
      await writeClaudeAgentConfig(worktree, {
        name: "maya",
        daemonPort: 41999,
        readOnly: false,
        dangerous: true,
        channels: false,
      });
      const argv = buildClaudeSpawnCommand({
        name: "maya",
        model: "default",
        worktreePath: worktree,
        daemonPort: 41999,
        readOnly: false,
        dangerous: true,
        channels: false,
        executable: claudeBinary!,
      });

      // tmux's `-e` does not reliably reach the pane's process, and inheriting
      // the real PATH would let the hooks find the real `hive`. Set the
      // environment in the command itself.
      const command = shellJoin([
        "env",
        `PATH=${binectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
        `HOME=${home}`,
        ...argv,
        PROMPT,
      ]);

      await tmux("kill-session", "-t", SESSION).catch(() => undefined);
      await tmux("new-session", "-d", "-s", SESSION, "-c", worktree,
        "-x", "200", "-y", "50", command);

      let pane = "";
      let reachedTurn = false;
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        pane = await capturePane();
        // Fail fast and loudly: a dialog here is the bug this test guards.
        if (pane.includes(DIALOG_MARKER)) break;
        const hooks = await readFile(hookLog, "utf8").catch(() => "");
        if (hooks.includes("turn-start")) {
          reachedTurn = true;
          break;
        }
        await Bun.sleep(500);
      }

      expect(pane).not.toContain(DIALOG_MARKER);
      // UserPromptSubmit only fires once the prompt is submitted, which is only
      // possible if nothing blocked the launch.
      expect(reachedTurn).toBe(true);

      const hooks = await readFile(hookLog, "utf8");
      expect(hooks).toContain("event session-start --agent maya");
      expect(hooks).toContain("event turn-start --agent maya");
      // The worktree settings really took effect, so the writer is autonomous.
      expect(pane).toContain("bypass permissions on");
    },
    60_000,
  );
});
