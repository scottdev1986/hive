interface TmuxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KillSessionOptions {
  ignoreMissing?: boolean;
}

export type TmuxRunner = (
  args: string[],
  socketName?: string,
  stdin?: Uint8Array,
) => Promise<TmuxResult>;

export interface TmuxAdapterOptions {
  run?: TmuxRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  enterDelayMs?: number;
}

// TUIs treat input arriving in one burst as a paste; an Enter inside that
// window becomes a literal newline in the composer instead of a submit.
export const SEND_ENTER_DELAY_MS = 500;
export const FAILED_PROCESS_HOLD_SECONDS = 5;
export const TMUX_TIMEOUT_MS = 10_000;
export const HIVE_HISTORY_LIMIT = 50_000;

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

/** Keep a failed pane alive briefly so readiness monitoring can capture the
 * real stderr instead of reporting only that the tmux session vanished. */
export function holdPaneOnFailure(
  command: string,
  seconds = FAILED_PROCESS_HOLD_SECONDS,
): string {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error("failure hold must be a positive whole number of seconds");
  }
  // Run the provider in a subshell: a provider is allowed to call `exit`, and
  // that must not bypass the diagnostic/hold wrapper in tmux's shell.
  return `(${command}); hive_status=$?; ` +
    `if [ "$hive_status" -ne 0 ]; then ` +
    `printf '\\n[hive] process exited with status %s\\n' "$hive_status" >&2; ` +
    `sleep ${seconds}; fi; exit "$hive_status"`;
}

async function runTmux(
  args: string[],
  socketName?: string,
  stdin?: Uint8Array,
): Promise<TmuxResult> {
  const socketArgs = socketName === undefined ? [] : ["-L", socketName];
  const process = Bun.spawn(["tmux", ...socketArgs, ...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
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
  private readonly run: TmuxRunner;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly enterDelayMs: number;

  constructor(
    private readonly socketName?: string,
    options: TmuxAdapterOptions = {},
  ) {
    this.run = options.run ?? runTmux;
    this.sleep = options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.enterDelayMs = options.enterDelayMs ?? SEND_ENTER_DELAY_MS;
  }

  async hasSession(session: string): Promise<boolean> {
    validateSessionName(session);
    const result = await this.run(
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
    const result = await this.run(
      [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        holdPaneOnFailure(command),
        ";",
        "set-option",
        "-t",
        name,
        "mouse",
        "on",
        ";",
        "set-window-option",
        "-t",
        `${name}:`,
        "history-limit",
        String(HIVE_HISTORY_LIMIT),
      ],
      this.socketName,
    );
    assertSuccess(result, "new-session");
  }

  async sendKeys(session: string, text: string): Promise<void> {
    validateSessionName(session);
    if (text.length > 0) {
      const buffer = `hive-message-${crypto.randomUUID()}`;
      const load = await this.run(
        ["load-buffer", "-b", buffer, "-"],
        this.socketName,
        new TextEncoder().encode(text),
      );
      assertSuccess(load, "load-buffer");
      try {
        const paste = await this.run(
          ["paste-buffer", "-d", "-p", "-b", buffer, "-t", `=${session}:`],
          this.socketName,
        );
        assertSuccess(paste, "paste-buffer");
      } catch (error) {
        await this.run(["delete-buffer", "-b", buffer], this.socketName)
          .catch(() => undefined);
        throw error;
      }
    }

    await this.sleep(this.enterDelayMs);
    const enter = await this.run(
      ["send-keys", "-t", `=${session}:`, "Enter"],
      this.socketName,
    );
    assertSuccess(enter, "send-keys Enter");
  }

  async capturePane(session: string): Promise<string> {
    validateSessionName(session);
    const result = await this.run(
      ["capture-pane", "-p", "-t", `=${session}:`],
      this.socketName,
    );
    assertSuccess(result, "capture-pane");
    return result.stdout;
  }

  async listClientTtys(session: string): Promise<string[]> {
    validateSessionName(session);
    const result = await this.run(
      ["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"],
      this.socketName,
    );
    assertSuccess(result, "list-clients");
    return [...new Set(result.stdout
      .split("\n")
      .map((tty) => tty.trim())
      .filter((tty) => tty.startsWith("/dev/")))];
  }

  /** PIDs of the root process in every pane of the session. These anchor the
   * resource watchdog's process-tree walk, so a runaway grandchild (e.g. a
   * hung test run inside an agent's shell) is still attributable. */
  async listPanePids(session: string): Promise<number[]> {
    validateSessionName(session);
    const result = await this.run(
      ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"],
      this.socketName,
    );
    assertSuccess(result, "list-panes");
    return result.stdout
      .split("\n")
      .map((pid) => pid.trim())
      .filter((pid) => /^[1-9][0-9]*$/.test(pid))
      .map((pid) => Number(pid))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  }

  async killSession(
    session: string,
    options: KillSessionOptions = {},
  ): Promise<void> {
    validateSessionName(session);
    const result = await this.run(
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
    const result = await this.run(
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
