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

// One root per case, all removed at the end.
const temporaryRoots: string[] = [];

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
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

// Both roles launch identically except for their authority, so the watch is
// written once and run for each. `readOnly` is the axis that regressed: a
// reader was pinned to manual approval regardless of autonomy, and — because a
// reader still reaches its first *turn* perfectly well, and only stalls later
// at its first *tool* — reaching the turn is not on its own enough to prove the
// fix. Each case therefore also names the mode it must launch in, which is the
// assertion the broken build actually fails.
const CASES = [
  { role: "writer", agent: "maya", readOnly: false },
  { role: "read-only", agent: "dennis", readOnly: true },
] as const;

suite("Claude spawn launch watch", () => {
  for (const { role, agent, readOnly } of CASES) {
  test(
    `a fresh ${role} worktree reaches its first turn with no interactive prompt`,
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "hive-launch-watch-"));
      temporaryRoots.push(temporaryRoot);
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

      // Exactly what a real spawn does under full autonomy ("dangerous"), for
      // this role.
      await seedClaudeWorktreeTrust(worktree, home);
      await writeClaudeAgentConfig(worktree, {
        name: agent,
        daemonPort: 41999,
        readOnly,
        dangerous: true,
        channels: false,
      });
      const argv = buildClaudeSpawnCommand({
        name: agent,
        model: "default",
        worktreePath: worktree,
        daemonPort: 41999,
        readOnly,
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
      expect(hooks).toContain(`event session-start --agent ${agent}`);
      expect(hooks).toContain(`event turn-start --agent ${agent}`);
      // The worktree settings really took effect, so the agent is autonomous.
      // This is the line that fails for the read-only case on the build that
      // shipped the bug: it launched with `--permission-mode default`, whose
      // pane never says this, and its first WebFetch then raised a dialog
      // while Hive went on reporting the agent as "working".
      expect(pane).toContain("bypass permissions on");

      if (readOnly) {
        // Autonomy bought no write authority. Under bypassPermissions a denied
        // tool is absent from the session, not merely unprompted (claude
        // 2.1.207), so the reader still cannot touch the worktree — and the
        // reader capability refuses its landing server-side.
        const settings = JSON.parse(
          await readFile(
            join(worktree, ".claude", "settings.local.json"),
            "utf8",
          ),
        ) as { permissions: { deny: string[] } };
        expect(settings.permissions.deny).toEqual([
          "Edit",
          "Write",
          "NotebookEdit",
          "Bash",
        ]);
      }
    },
    60_000,
  );
  }
});
