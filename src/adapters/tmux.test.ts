import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertSuccess,
  SEND_ENTER_DELAY_MS,
  shellJoin,
  TmuxAdapter,
  type TmuxRunner,
} from "./tmux";

const socketName = `hive-test-${crypto.randomUUID()}`;
const tmux = new TmuxAdapter(socketName);
const sessions = new Set<string>();
let socketDirectory = "";
let previousTmuxTmpDir: string | undefined;
let previousHiveHome: string | undefined;

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
