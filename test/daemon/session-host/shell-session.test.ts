import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  prepareSessionZdotdir,
  shellSessionLaunch,
  TERMINAL_SHELL,
} from "../../../src/daemon/session-host/shell-session";
import { tempRoot } from "../../temp-root";

describe("shell-backed terminal sessions", () => {
  test("starts a conventional interactive login zsh with command in environment", () => {
    const launch = shellSessionLaunch("codex --model gpt-5.6-sol");

    expect(launch.argv).toEqual([TERMINAL_SHELL, "-l", "-i"]);
    expect(launch.expectedExecutable).toBe(TERMINAL_SHELL);
    expect(launch.env.HIVE_AGENT_UI_COMMAND).toBe("codex --model gpt-5.6-sol");
    expect(launch.env.HIVE_TUI_LAUNCHED).toBe("0");
  });

  test("refuses a command that cannot be entered into a terminal", () => {
    expect(() => shellSessionLaunch("codex\0ignored")).toThrow(
      "terminal command contains a NUL byte",
    );
  });

  test("prepares ZDOTDIR with init files that source user's config", async () => {
    const sessionId = "ses_test123";
    const zdotdir = await prepareSessionZdotdir(sessionId);
    
    // ZDOTDIR should exist
    expect(zdotdir).toContain(sessionId);
    const Bun = (await import("bun")).default;
    
    // .zshrc should exist and contain the bootstrap
    const zshrc = await Bun.file(`${zdotdir}/.zshrc`).text();
    expect(zshrc).toContain("HIVE_AGENT_UI_COMMAND");
    expect(zshrc).toContain("HIVE_TUI_LAUNCHED");
    expect(zshrc).toContain("HIVE_USER_ZDOTDIR");
    
    // .zprofile should forward to user's file
    const zprofile = await Bun.file(`${zdotdir}/.zprofile`).text();
    expect(zprofile).toContain("HIVE_USER_ZDOTDIR");
    
    // .zlogin should forward to user's file
    const zlogin = await Bun.file(`${zdotdir}/.zlogin`).text();
    expect(zlogin).toContain("HIVE_USER_ZDOTDIR");
  });

  test("provider exit leaves the same terminal at a working zsh", async () => {
    const launch = shellSessionLaunch(
      "print -r -- __HIVE_PROVIDER_RAN__; false",
    );
    const shellHome = tempRoot("hive-shell-session-");
    await mkdir(shellHome, { recursive: true });
    
    // Prepare a real ZDOTDIR for the test
    const zdotdir = await prepareSessionZdotdir("test-session");
    
    const child = Bun.spawn([...launch.argv], {
      cwd: shellHome,
      env: {
        HOME: shellHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        ZDOTDIR: zdotdir,
        HIVE_USER_ZDOTDIR: shellHome,
        ...launch.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Own session, so the shell has no controlling terminal to reach for. An
      // interactive zsh that can open /dev/tty reads its line editor from there
      // and never sees the stdin pipe, so the command written below would be
      // dropped and this test would hang on whatever that terminal does next.
      detached: true,
    });
    child.stdin.write("print -r -- __HIVE_SHELL_SURVIVED__\nexit\n");
    await child.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("__HIVE_PROVIDER_RAN__");
    expect(stdout).toContain("__HIVE_SHELL_SURVIVED__");
    expect(stderr).not.toContain("command not found");
  });
});
