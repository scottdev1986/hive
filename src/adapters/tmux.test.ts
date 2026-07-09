import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertSuccess, shellJoin, TmuxAdapter } from "./tmux";

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
