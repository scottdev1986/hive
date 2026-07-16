import {
  hiveTmuxSocketName,
  isTmuxSessionForInstance,
} from "../daemon/tmux-sessions";

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

export interface TmuxPaneState {
  columns: number;
  rows: number;
  cursorColumn: number;
  cursorRow: number;
  cursorVisible: boolean;
}

/** Internal engine seam consumed only by SessionHost and substrate tests. */
export interface TmuxEngine {
  hasSession(session: string): Promise<boolean>;
  newSession(
    name: string,
    cwd: string,
    command: string,
    geometry?: { columns: number; rows: number },
  ): Promise<void>;
  capturePane(session: string): Promise<string>;
  listPanePids?: TmuxAdapter["listPanePids"];
  sendBytes?: TmuxAdapter["sendBytes"];
  listClientTtys?: TmuxAdapter["listClientTtys"];
  paneState?: TmuxAdapter["paneState"];
  resizeSession?: TmuxAdapter["resizeSession"];
  getSocketName?: TmuxAdapter["getSocketName"];
  killSession?: TmuxAdapter["killSession"];
  listSessions?: TmuxAdapter["listSessions"];
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

function isMissingSession(result: TmuxResult): boolean {
  if (result.exitCode === 0) return false;
  return result.stderr.includes("can't find session") ||
    result.stderr.includes("no server running") ||
    (result.stderr.includes("error connecting") &&
      result.stderr.includes("No such file or directory"));
}

export const shellQuote = (value: string): string =>
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
  private readonly socketName: string;
  private readonly validateInstanceOwnership: boolean;

  constructor(
    socketName?: string,
    options: TmuxAdapterOptions = {},
  ) {
    this.socketName = socketName ?? hiveTmuxSocketName();
    this.validateInstanceOwnership = socketName === undefined;
    this.run = options.run ?? runTmux;
    this.sleep = options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.enterDelayMs = options.enterDelayMs ?? SEND_ENTER_DELAY_MS;
  }

  private validateTarget(session: string): void {
    validateSessionName(session);
    if (
      this.validateInstanceOwnership &&
      !isTmuxSessionForInstance(session)
    ) {
      throw new Error(
        `tmux session belongs to a different Hive instance: ${session}`,
      );
    }
  }

  private async sessionExists(session: string): Promise<boolean> {
    this.validateTarget(session);
    const result = await this.run(
      ["has-session", "-t", `=${session}`],
      this.socketName,
    );
    if (result.exitCode === 0) return true;
    if (isMissingSession(result)) return false;
    assertSuccess(result, "has-session");
    return false;
  }

  async hasSession(session: string): Promise<boolean> {
    return this.sessionExists(session);
  }

  async newSession(
    name: string,
    cwd: string,
    command: string,
    geometry?: { columns: number; rows: number },
  ): Promise<void> {
    this.validateTarget(name);
    const result = await this.run(
      [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        ...(geometry === undefined
          ? []
          : ["-x", String(geometry.columns), "-y", String(geometry.rows)]),
        holdPaneOnFailure(command),
        ";",
        "set-option",
        "-g",
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
    if (!(await this.sessionExists(name))) {
      throw new Error(`tmux new-session did not create the session: ${name}`);
    }
  }

  /** Escape restores the cancelled prompt in the composer, so clear it before
   * pasting the urgent control. Interrupted turns cannot resume. */
  private async interruptComposer(session: string): Promise<void> {
    const escape = await this.run(
      ["send-keys", "-t", `=${session}:`, "Escape"],
      this.socketName,
    );
    assertSuccess(escape, "send-keys Escape");
    await this.sleep(this.enterDelayMs);
    const clear = await this.run(
      ["send-keys", "-t", `=${session}:`, "C-u"],
      this.socketName,
    );
    assertSuccess(clear, "send-keys C-u");
    await this.sleep(this.enterDelayMs);
  }

  async sendKeys(
    session: string,
    text: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    await this.sendBytes(session, new TextEncoder().encode(text), {
      interrupt: options.interrupt,
      submit: "return",
    });
  }

  async sendBytes(
    session: string,
    bytes: Uint8Array,
    options: {
      interrupt?: boolean;
      submit?: "none" | "return" | "control-enter";
    } = {},
  ): Promise<void> {
    this.validateTarget(session);
    if (options.interrupt === true) {
      await this.interruptComposer(session);
    }
    if (bytes.byteLength > 0) {
      const buffer = `hive-message-${crypto.randomUUID()}`;
      const load = await this.run(
        ["load-buffer", "-b", buffer, "-"],
        this.socketName,
        bytes,
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

    if ((options.submit ?? "return") === "none") return;
    await this.sleep(this.enterDelayMs);
    const enter = await this.run(
      [
        "send-keys",
        "-t",
        `=${session}:`,
        (options.submit ?? "return") === "control-enter" ? "C-Enter" : "Enter",
      ],
      this.socketName,
    );
    assertSuccess(enter, "send-keys Enter");
  }

  async capturePane(session: string): Promise<string> {
    this.validateTarget(session);
    const result = await this.run(
      ["capture-pane", "-p", "-t", `=${session}:`],
      this.socketName,
    );
    assertSuccess(result, "capture-pane");
    return result.stdout;
  }

  async paneState(session: string): Promise<TmuxPaneState> {
    this.validateTarget(session);
    const result = await this.run(
      [
        "display-message",
        "-p",
        "-t",
        `=${session}:`,
        "#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}",
      ],
      this.socketName,
    );
    assertSuccess(result, "display-message");
    const fields = result.stdout.trim().split("\t");
    if (fields.length !== 5 || fields.some((field) => !/^\d+$/.test(field))) {
      throw new Error("tmux display-message returned invalid pane geometry");
    }
    const [columns, rows, cursorColumn, cursorRow, cursorVisible] = fields.map(Number);
    if (columns! < 1 || rows! < 1) {
      throw new Error("tmux display-message returned empty pane geometry");
    }
    return {
      columns: columns!,
      rows: rows!,
      cursorColumn: cursorColumn!,
      cursorRow: cursorRow!,
      cursorVisible: cursorVisible === 1,
    };
  }

  async resizeSession(
    session: string,
    geometry: { columns: number; rows: number },
  ): Promise<void> {
    this.validateTarget(session);
    const result = await this.run(
      [
        "resize-window",
        "-t",
        `=${session}:`,
        "-x",
        String(geometry.columns),
        "-y",
        String(geometry.rows),
      ],
      this.socketName,
    );
    assertSuccess(result, "resize-window");
  }

  getSocketName(): string {
    return this.socketName;
  }

  async listClientTtys(session: string): Promise<string[]> {
    this.validateTarget(session);
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
    this.validateTarget(session);
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
    this.validateTarget(session);
    const result = await this.run(
      ["kill-session", "-t", `=${session}`],
      this.socketName,
    );
    const stillExists = await this.sessionExists(session);
    if (result.exitCode !== 0) {
      if ((options.ignoreMissing ?? true) && !stillExists) return;
      assertSuccess(result, "kill-session");
    }
    if (stillExists) {
      throw new Error(
        `tmux kill-session succeeded but the session still exists: ${session}`,
      );
    }
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

    const sessions = result.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return this.validateInstanceOwnership
      ? sessions.filter((session) => isTmuxSessionForInstance(session))
      : sessions;
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
