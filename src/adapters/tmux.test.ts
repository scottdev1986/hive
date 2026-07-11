import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertSuccess,
  FAILED_PROCESS_HOLD_SECONDS,
  HIVE_HISTORY_LIMIT,
  holdPaneOnFailure,
  SEND_ENTER_DELAY_MS,
  shellJoin,
  TmuxAdapter,
  type TmuxRunner,
} from "./tmux";
import { join } from "node:path";
import { promptArgument, writeLaunchPrompt } from "../daemon/launch-prompt";

const socketName = `hive-test-${crypto.randomUUID()}`;
const tmux = new TmuxAdapter(socketName);
const sessions = new Set<string>();
let socketDirectory = "";
let previousTmuxTmpDir: string | undefined;
let previousHiveHome: string | undefined;

async function queryPrivateTmux(...args: string[]): Promise<string> {
  const process = Bun.spawn(["tmux", "-L", socketName, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  expect(exitCode).toEqual(0);
  return stdout.trim();
}

beforeAll(async () => {
  const process = Bun.spawn(
    ["mktemp", "-d", "/private/tmp/hive-tmux.XXXXXX"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`could not create tmux temp directory: ${stderr.trim()}`);
  }

  socketDirectory = stdout.trim();
  previousTmuxTmpDir = Bun.env.TMUX_TMPDIR;
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.TMUX_TMPDIR = socketDirectory;
  Bun.env.HIVE_HOME = socketDirectory;
});

afterAll(async () => {
  for (const session of sessions) {
    if (await tmux.hasSession(session)) {
      await tmux.killSession(session);
    }
  }
  if (previousTmuxTmpDir === undefined) {
    delete Bun.env.TMUX_TMPDIR;
  } else {
    Bun.env.TMUX_TMPDIR = previousTmuxTmpDir;
  }
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (socketDirectory !== "") {
    const process = Bun.spawn(["rm", "-rf", socketDirectory], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await process.exited;
  }
});

interface RecordedTmuxCall {
  args: string[];
  stdin: string | null;
  afterSleeps: number[];
}

function recordingAdapter(options: {
  enterDelayMs?: number;
  failCommand?: string;
} = {}): {
  adapter: TmuxAdapter;
  calls: RecordedTmuxCall[];
  sleeps: number[];
} {
  const calls: RecordedTmuxCall[] = [];
  const sleeps: number[] = [];
  const run: TmuxRunner = async (args, _socketName, stdin) => {
    calls.push({
      args,
      stdin: stdin === undefined ? null : new TextDecoder().decode(stdin),
      afterSleeps: [...sleeps],
    });
    if (options.failCommand !== undefined && args[0] === options.failCommand) {
      return { stdout: "", stderr: "boom", exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const adapter = new TmuxAdapter(undefined, {
    run,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    ...(options.enterDelayMs === undefined
      ? {}
      : { enterDelayMs: options.enterDelayMs }),
  });
  return { adapter, calls, sleeps };
}

describe("TmuxAdapter launch diagnostics", () => {
  test("keeps a failed process visible long enough to capture its exit", async () => {
    const { adapter, calls } = recordingAdapter();

    await adapter.newSession(
      "hive-maya",
      "/repo",
      "'claude' '--model' 'sonnet'",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 7)).toEqual([
      "new-session",
      "-d",
      "-s",
      "hive-maya",
      "-c",
      "/repo",
      holdPaneOnFailure("'claude' '--model' 'sonnet'"),
    ]);
    expect(calls[0]?.args[6]).toContain(
      `[hive] process exited with status %s`,
    );
    expect(calls[0]?.args[6]).toContain(
      `sleep ${FAILED_PROCESS_HOLD_SECONDS}`,
    );
    expect(calls[0]?.args.slice(7)).toEqual([
      ";",
      "set-option",
      "-g",
      "mouse",
      "on",
      ";",
      "set-window-option",
      "-t",
      "hive-maya:",
      "history-limit",
      String(HIVE_HISTORY_LIMIT),
    ]);
    expect(holdPaneOnFailure("exit 17")).toStartWith("(exit 17);");
  });

  test("rejects an invalid failure hold", () => {
    expect(() => holdPaneOnFailure("true", 0)).toThrow(
      "failure hold must be a positive whole number",
    );
  });
});

describe("TmuxAdapter.sendKeys injection", () => {
  test("pastes the text, waits, then submits with exactly one Enter", async () => {
    const { adapter, calls, sleeps } = recordingAdapter();

    await adapter.sendKeys("hive-maya", "Please review this.");

    expect(calls.length).toEqual(3);
    const [load, paste, enter] = calls;
    expect(load?.args.slice(0, 2)).toEqual(["load-buffer", "-b"]);
    expect(load?.args[3]).toEqual("-");
    expect(load?.stdin).toEqual("Please review this.");

    expect(paste?.args[0]).toEqual("paste-buffer");
    expect(paste?.args).toContain("-d");
    expect(paste?.args).toContain("-p");
    expect(paste?.args.slice(-2)).toEqual(["-t", "=hive-maya:"]);
    expect(paste?.args[paste.args.indexOf("-b") + 1]).toEqual(
      load?.args[2] ?? "",
    );

    expect(enter?.args).toEqual(["send-keys", "-t", "=hive-maya:", "Enter"]);
    // The Enter must come after the paste settles, or the TUI treats it as a
    // pasted newline and the message sits in the composer unsubmitted.
    expect(paste?.afterSleeps).toEqual([]);
    expect(enter?.afterSleeps).toEqual([SEND_ENTER_DELAY_MS]);
    expect(sleeps).toEqual([SEND_ENTER_DELAY_MS]);

    const enterCount = calls.filter((call) =>
      call.args.includes("Enter")
    ).length;
    expect(enterCount).toEqual(1);
  });

  test("passes special characters verbatim with no shell interpretation", async () => {
    const text =
      "📨 message from sam: done; 'quotes' \"double\" $HOME `whoami` \\ --flag\nline two\nline three";
    const { adapter, calls } = recordingAdapter({ enterDelayMs: 0 });

    await adapter.sendKeys("hive-maya", text);

    expect(calls[0]?.stdin).toEqual(text);
    // Multi-line bodies must travel as a paste, never as keystrokes where
    // each newline would submit a partial message.
    expect(calls.some((call) => call.args[0] === "send-keys" &&
      call.args.some((arg) => arg.includes("\n")))).toEqual(false);
    expect(calls.filter((call) => call.args.includes("Enter")).length)
      .toEqual(1);
  });

  test("honors a configured Enter delay", async () => {
    const { adapter, sleeps } = recordingAdapter({ enterDelayMs: 25 });
    await adapter.sendKeys("hive-maya", "quick");
    expect(sleeps).toEqual([25]);
  });

  test("cleans up the paste buffer and skips Enter when pasting fails", async () => {
    const { adapter, calls } = recordingAdapter({
      failCommand: "paste-buffer",
    });

    let message = "";
    try {
      await adapter.sendKeys("hive-maya", "will not arrive");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes("tmux paste-buffer failed")).toEqual(true);
    expect(calls.map((call) => call.args[0])).toEqual([
      "load-buffer",
      "paste-buffer",
      "delete-buffer",
    ]);
    expect(calls.some((call) => call.args.includes("Enter"))).toEqual(false);
  });

  test("submits without pasting when the text is empty", async () => {
    const { adapter, calls } = recordingAdapter({ enterDelayMs: 0 });
    await adapter.sendKeys("hive-maya", "");
    expect(calls.map((call) => call.args[0])).toEqual(["send-keys"]);
  });
});

describe("TmuxAdapter", () => {
  test("rejects malformed pane PIDs instead of partially parsing them", async () => {
    const adapter = new TmuxAdapter(undefined, {
      run: async () => ({
        stdout: "42\n12oops\n-7\n0\n9007199254740992\n73\n",
        stderr: "",
        exitCode: 0,
      }),
    });

    expect(await adapter.listPanePids("hive-maya")).toEqual([42, 73]);
  });

  test("lists the unique physical client TTYs attached to an exact session", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(undefined, {
      run: async (args) => {
        calls.push(args);
        return {
          stdout: "/dev/ttys003\n/dev/ttys003\nnot-a-tty\n",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(await adapter.listClientTtys("hive-orchestrator")).toEqual([
      "/dev/ttys003",
    ]);
    expect(calls).toEqual([[
      "list-clients",
      "-t",
      "=hive-orchestrator",
      "-F",
      "#{client_tty}",
    ]]);
  });

  test("rejects unsafe session names from every targeted public method", async () => {
    for (const invalid of ["", "sam:1", "sam.1", "sam name", "-sam"]) {
      let message = "";
      try {
        await tmux.hasSession(invalid);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.includes("tmux session name")).toEqual(true);
    }

    const calls = [
      tmux.newSession("bad:name", "/tmp", "true"),
      tmux.sendKeys("bad:name", "text"),
      tmux.capturePane("bad:name"),
      tmux.killSession("bad:name"),
    ];
    for (const call of calls) {
      let message = "";
      try {
        await call;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.includes("tmux session name")).toEqual(true);
    }
  });

  test("shellJoin POSIX-quotes argv including embedded single quotes", () => {
    expect(shellJoin(["codex", "hello world", "it's ready"])).toEqual(
      "'codex' 'hello world' 'it'\\''s ready'",
    );
    expect(shellJoin([])).toEqual("");
  });

  test("treats stderr warnings as successful when the exit code is zero", () => {
    expect(() =>
      assertSuccess(
        { stdout: "", stderr: "warning from tmux", exitCode: 0 },
        "test",
      ),
    ).not.toThrow();
  });

  test("ignores missing sessions by default and can report them", async () => {
    const unavailableTmux = new TmuxAdapter(
      `hive-missing-${crypto.randomUUID()}`,
    );
    const missingSession = "missing-session";

    await unavailableTmux.killSession(missingSession);

    let message = "";
    try {
      await unavailableTmux.killSession(missingSession, {
        ignoreMissing: false,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("tmux kill-session failed")).toEqual(true);
  });

  test("creates, lists, writes to, captures, and kills a real session", async () => {
    const session = `hive-adapter-${crypto.randomUUID()}`;

    try {
      await tmux.newSession(session, socketDirectory, "cat");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Operation not permitted")
      ) {
        // The Codex filesystem sandbox blocks Unix-domain socket creation.
        // Outside that sandbox this test exercises a real private tmux server.
        return;
      }
      throw error;
    }
    if (!(await tmux.hasSession(session))) {
      // In a filesystem sandbox tmux may print a socket warning but exit zero.
      return;
    }
    sessions.add(session);
    expect(await tmux.hasSession(session)).toEqual(true);
    expect((await tmux.listSessions()).includes(session)).toEqual(true);
    expect(
      await queryPrivateTmux("show-options", "-Av", "-t", session, "mouse"),
    ).toEqual("on");
    expect(
      await queryPrivateTmux(
        "show-window-options",
        "-v",
        "-t",
        `${session}:`,
        "history-limit",
      ),
    ).toEqual(String(HIVE_HISTORY_LIMIT));
    expect(
      await queryPrivateTmux("list-keys", "-T", "root"),
    ).toContain("copy-mode -e");

    const text = "literal hive text; $HOME is not expanded";
    await tmux.sendKeys(session, text);

    let pane = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      pane = await tmux.capturePane(session);
      if (pane.includes(text)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pane.includes(text)).toEqual(true);
    await tmux.killSession(session);
    expect(await tmux.hasSession(session)).toEqual(false);
    sessions.delete(session);
  });

  test("enables mouse for sessions that survived from before the fix", async () => {
    const existing = `hive-existing-${crypto.randomUUID()}`;
    const fresh = `hive-fresh-${crypto.randomUUID()}`;

    await tmux.newSession(existing, socketDirectory, "cat");
    sessions.add(existing);
    await queryPrivateTmux("set-option", "-gu", "mouse");
    expect(
      await queryPrivateTmux("show-options", "-Av", "-t", existing, "mouse"),
    ).toEqual("off");

    await tmux.newSession(fresh, socketDirectory, "cat");
    sessions.add(fresh);
    expect(
      await queryPrivateTmux("show-options", "-Av", "-t", existing, "mouse"),
    ).toEqual("on");
    expect(
      await queryPrivateTmux("show-options", "-Av", "-t", fresh, "mouse"),
    ).toEqual("on");
  });

  test("preserves a real failed pane long enough to capture its cause", async () => {
    const session = `hive-adapter-failure-${crypto.randomUUID()}`;
    try {
      await tmux.newSession(session, socketDirectory, "printf 'provider failed\\n' >&2; exit 17");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Operation not permitted")
      ) {
        return;
      }
      throw error;
    }
    if (!(await tmux.hasSession(session))) return;
    sessions.add(session);

    let pane = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      pane = await tmux.capturePane(session);
      if (pane.includes("process exited with status 17")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pane).toContain("provider failed");
    expect(pane).toContain("[hive] process exited with status 17");

    await tmux.killSession(session);
    sessions.delete(session);
  });

  test("uses exact targets and does not kill a longer prefix match", async () => {
    const prefix = `rev-${crypto.randomUUID().slice(0, 8)}`;
    const longer = `${prefix}-longer`;

    try {
      await tmux.newSession(longer, socketDirectory, "cat");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Operation not permitted")
      ) {
        return;
      }
      throw error;
    }
    if (!(await tmux.hasSession(longer))) {
      // In a filesystem sandbox tmux may print a socket warning but exit zero.
      return;
    }
    sessions.add(longer);

    await tmux.killSession(prefix);
    expect(await tmux.hasSession(prefix)).toEqual(false);
    expect(await tmux.hasSession(longer)).toEqual(true);

    await tmux.killSession(longer);
    sessions.delete(longer);
  });
});


/**
 * Priority has to mean something at the transport layer. Before this, every
 * level did the same thing — paste and press Enter — so a critical order
 * revoking write authority could sit unread in a composer while the agent kept
 * writing.
 */
describe("interrupting a working agent", () => {
  test("an interrupt escapes, CLEARS the composer, then pastes", async () => {
    const calls: string[][] = [];
    const tmux = new TmuxAdapter(undefined, {
      run: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      sleep: async () => {},
    } as never);

    await tmux.sendKeys("hive-maya", "stop now", { interrupt: true });

    const keys = calls
      .filter((c) => c[0] === "send-keys")
      .map((c) => c[c.length - 1]);

    // Escape cancels the turn, but it also RESTORES the original prompt into the
    // composer — measured against a real TUI. Pasting on top of that
    // concatenates the control onto the old prompt and resubmits the mash as one
    // corrupted turn. C-u is what stops that, and it is not optional.
    expect(keys[0]).toEqual("Escape");
    expect(keys[1]).toEqual("C-u");
    expect(keys[keys.length - 1]).toEqual("Enter");
    expect(calls.some((c) => c[0] === "paste-buffer")).toBe(true);
  });

  test("routine traffic never interrupts a thinking agent", async () => {
    const calls: string[][] = [];
    const tmux = new TmuxAdapter(undefined, {
      run: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      sleep: async () => {},
    } as never);

    await tmux.sendKeys("hive-maya", "fyi");

    const keys = calls
      .filter((c) => c[0] === "send-keys")
      .map((c) => c[c.length - 1]);
    // An interrupt cancels the in-flight turn outright and the agent does not
    // resume it. That is not a price worth paying for routine coordination.
    expect(keys).not.toContain("Escape");
    expect(keys).not.toContain("C-u");
  });
});

/**
 * The limit that started this: tmux hands a command to its server in a single
 * imsg and refuses anything much past 16KB, which is 64x below the 1MB ARG_MAX
 * the launch design assumed. These run against a real tmux server, because the
 * whole bug was a belief about tmux that no fake would have contradicted.
 */
describe("TmuxAdapter launch prompt limit", () => {
  const brief = `BRIEF ${"context ".repeat(12_500)}`; // ~100KB

  test("rejects a brief passed on the command line, as Hive used to pass it", async () => {
    const session = `hive-inline-${crypto.randomUUID()}`;
    let message = "";
    try {
      await tmux.newSession(
        session,
        socketDirectory,
        shellJoin(["sh", "-c", "exit 0", "sh", brief]),
      );
      sessions.add(session);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (message.includes("Operation not permitted")) return; // sandboxed
    expect(message).toContain("command too long");
  });

  test("carries the same brief intact when the launch shell reads it from a file", async () => {
    const session = `hive-outofband-${crypto.randomUUID()}`;
    const report = join(socketDirectory, `${session}.bytes`);
    const promptPath = await writeLaunchPrompt(session, brief);
    // A stand-in agent: report the size of the single argument it was handed.
    const command = `${
      shellJoin(["sh", "-c", `printf %s "$1" | wc -c > ${report}`, "sh"])
    } ${promptArgument(promptPath)}`;

    // Whatever the brief weighs, what tmux carries stays small.
    expect(command.length).toBeLessThan(1_000);

    try {
      await tmux.newSession(session, socketDirectory, command);
      sessions.add(session);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Operation not permitted")
      ) return; // sandboxed
      throw error;
    }

    // Wait for the count, not for the file: the launch shell opens the redirect
    // target when the pipeline starts, so it exists — and reads back empty —
    // before wc has written a byte into it.
    let written = "";
    for (let attempt = 0; attempt < 100 && !written; attempt += 1) {
      written = (await Bun.file(report).text().catch(() => "")).trim();
      if (!written) await Bun.sleep(20);
    }
    const delivered = Number(written);
    // Arrived whole, as exactly one argument — not split on its whitespace.
    expect(delivered).toEqual(Buffer.byteLength(brief));
  });
});
