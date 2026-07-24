import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellSessionLaunch,
  TERMINAL_SHELL,
} from "../../../src/daemon/session-host/shell-session";

describe("shell-backed terminal sessions", () => {
  test("starts a login zsh and enters the provider as its first command", () => {
    const launch = shellSessionLaunch("codex --model gpt-5.6-sol");

    expect(launch.argv.slice(0, 5)).toEqual([
      TERMINAL_SHELL,
      "-l",
      "-i",
      "-c",
      expect.stringContaining('eval "$hive_terminal_command"'),
    ]);
    expect(launch.argv.at(-2)).toBe("hive-terminal");
    expect(launch.argv.at(-1)).toBe("codex --model gpt-5.6-sol");
    expect(launch.expectedExecutable).toBe(TERMINAL_SHELL);
    expect(launch.initialInput).toEqual(new Uint8Array());
  });

  test("refuses a command that cannot be entered into a terminal", () => {
    expect(() => shellSessionLaunch("codex\0ignored"))
      .toThrow("terminal command contains a NUL byte");
  });

  test("provider exit leaves the same terminal at a working zsh", async () => {
    const launch = shellSessionLaunch(
      "print -r -- __HIVE_PROVIDER_RAN__; false",
    );
    const shellHome = mkdtempSync(join(tmpdir(), "hive-shell-session-"));
    const child = Bun.spawn([...launch.argv], {
      cwd: shellHome,
      env: {
        HOME: shellHome,
        ZDOTDIR: shellHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
