interface TmuxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KillSessionOptions {
  ignoreMissing?: boolean;
}

const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function validateSessionName(session: string): void {
  if (!SESSION_NAME_PATTERN.test(session)) {
    throw new Error(
      "tmux session name must be 1-100 characters using only letters, numbers, underscores, or dashes",
    );
  }
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

async function runTmux(
  args: string[],
  socketName?: string,
): Promise<TmuxResult> {
  const socketArgs = socketName === undefined ? [] : ["-L", socketName];
  const process = Bun.spawn(["tmux", ...socketArgs, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export function assertSuccess(result: TmuxResult, operation: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new Error(`tmux ${operation} failed: ${detail}`);
  }
}

export class TmuxAdapter {
  constructor(private readonly socketName?: string) {}

  async hasSession(session: string): Promise<boolean> {
    validateSessionName(session);
    const result = await runTmux(
      ["has-session", "-t", `=${session}`],
      this.socketName,
    );
    return result.exitCode === 0;
  }

  async newSession(
    name: string,
    cwd: string,
    command: string,
  ): Promise<void> {
    validateSessionName(name);
    const result = await runTmux(
      ["new-session", "-d", "-s", name, "-c", cwd, command],
      this.socketName,
    );
    assertSuccess(result, "new-session");
  }

  async sendKeys(session: string, text: string): Promise<void> {
    validateSessionName(session);
    const literal = await runTmux(
      ["send-keys", "-t", `=${session}:`, "-l", "--", text],
      this.socketName,
    );
    assertSuccess(literal, "send-keys");

    const enter = await runTmux(
      ["send-keys", "-t", `=${session}:`, "Enter"],
      this.socketName,
    );
    assertSuccess(enter, "send-keys Enter");
  }

  async capturePane(session: string): Promise<string> {
    validateSessionName(session);
    const result = await runTmux(
      ["capture-pane", "-p", "-t", `=${session}:`],
      this.socketName,
    );
    assertSuccess(result, "capture-pane");
    return result.stdout;
  }

  async killSession(
    session: string,
    options: KillSessionOptions = {},
  ): Promise<void> {
    validateSessionName(session);
    const result = await runTmux(
      ["kill-session", "-t", `=${session}`],
      this.socketName,
    );
    if (
      result.exitCode !== 0 &&
      (options.ignoreMissing ?? true) &&
      !(await this.hasSession(session))
    ) {
      return;
    }
    assertSuccess(result, "kill-session");
  }

  async listSessions(): Promise<string[]> {
    const result = await runTmux(
      ["list-sessions", "-F", "#{session_name}"],
      this.socketName,
    );

    if (result.exitCode !== 0) {
      if (
        result.stderr.includes("no server running") ||
        (result.stderr.includes("error connecting") &&
          result.stderr.includes("No such file or directory"))
      ) {
        return [];
      }
      assertSuccess(result, "list-sessions");
    }

    return result.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }
}

export const hasSession = (
  session: string,
  socketName?: string,
): Promise<boolean> => new TmuxAdapter(socketName).hasSession(session);

export const newSession = (
  name: string,
  cwd: string,
  command: string,
  socketName?: string,
): Promise<void> => new TmuxAdapter(socketName).newSession(name, cwd, command);

export const sendKeys = (
  session: string,
  text: string,
  socketName?: string,
): Promise<void> => new TmuxAdapter(socketName).sendKeys(session, text);

export const capturePane = (
  session: string,
  socketName?: string,
): Promise<string> => new TmuxAdapter(socketName).capturePane(session);

export const killSession = (
  session: string,
  options: KillSessionOptions = {},
  socketName?: string,
): Promise<void> => new TmuxAdapter(socketName).killSession(session, options);

export const listSessions = (socketName?: string): Promise<string[]> =>
  new TmuxAdapter(socketName).listSessions();
