import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  readTerminalLaunchSpec,
  shellSessionLaunch,
  writeTerminalLaunchSpec,
} from "../../../src/daemon/session-host/shell-session";

describe("shell-backed terminal sessions", () => {
  test("execs the TUI immediately and drops to the user shell after it exits", () => {
    const launch = shellSessionLaunch("'hive' 'agent-ui' '--subject' 'queen'");

    expect(launch.ghosttyCommand).toBe(
      `/usr/bin/env 'hive' 'agent-ui' '--subject' 'queen'; exec "\${SHELL:-/bin/zsh}"`,
    );
    expect(launch.argv).toEqual(["/bin/sh", "-c", launch.ghosttyCommand]);
    expect(launch.env).toEqual({});
  });

  test("macOS Ghostty exec -l can run a capability-wrapped command", () => {
    const launch = shellSessionLaunch(
      `HIVE_CAPABILITY_TOKEN=secret /usr/bin/true`,
    );
    const wrapped = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", `exec -l ${launch.ghosttyCommand}`],
      { encoding: "utf8" },
    );
    expect(wrapped.status).toBe(0);
    expect(wrapped.stderr).not.toContain("not found");
  });

  test("a headless pane is only the user shell", () => {
    const launch = shellSessionLaunch("");
    expect(launch.ghosttyCommand).toBe(`"\${SHELL:-/bin/zsh}"`);
  });

  test("refuses a command that cannot be entered into a terminal", () => {
    expect(() => shellSessionLaunch("codex\0ignored")).toThrow(
      "terminal command contains a NUL byte",
    );
  });

  test("persists the Ghostty exec spec for a session", async () => {
    const sessionId = `ses_launch_${crypto.randomUUID()}`;
    const spec = {
      cwd: "/tmp/hive-project",
      command: `'hive' 'agent-ui'; exec "\${SHELL:-/bin/zsh}"`,
      environment: { TERM: "xterm-256color" },
    };
    await writeTerminalLaunchSpec(sessionId, spec);
    expect(readTerminalLaunchSpec(sessionId)).toEqual(spec);
  });
});
