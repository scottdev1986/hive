/**
 * What the user watches while Hive downloads itself.
 *
 * A self-updating binary asking to replace itself has to earn that. The bar is
 * not decoration: it names the artifact, states the size *before* the first byte
 * arrives (the manifest already carries it, so this costs no round trip), and
 * then shows the download actually happening. Silence for ten seconds and a
 * "done" at the end asks the user to take our word for it. This does not.
 *
 * Two degradations, both required, because a progress bar that only works on a
 * developer's terminal is a progress bar that corrupts every CI log:
 *
 *   - **Not a TTY** (a pipe, a CI runner, `hive update > log`): no ANSI, no
 *     carriage returns, no redraws. One line when the download starts and one
 *     when it ends. A `\r`-redrawn bar in a log file is a single 400 KB line of
 *     garbage, which is worse than no bar at all.
 *   - **No `Content-Length`**: no percentage and no bar — there is nothing to be
 *     a percentage *of*. We show bytes so far and the rate, which is everything
 *     we actually know. Inventing a denominator from the manifest's declared
 *     size would be a bar that lies when the two disagree, and the two
 *     disagreeing is exactly the truncated-download case worth seeing.
 *
 * Rendering is pure (`renderProgressLine`) so the shapes above can be asserted
 * without a terminal; the reporter below is the thin effectful shell.
 */

const ESC = "\u001B";
const dim = (text: string): string => `${ESC}[2m${text}${ESC}[0m`;
/** Erase the whole line and park the cursor at column 0, ready to redraw. */
const CLEAR_LINE = `\r${ESC}[2K`;

/** Redraw at most this often. Faster is invisible to a human and costs syscalls. */
const REDRAW_INTERVAL_MS = 80;
/** Rate is averaged over a trailing window, so a stalled connection reads as slow. */
const RATE_WINDOW_MS = 1_000;

const BAR_WIDTH = 24;
/** Below this a bar conveys less than the digits it crowds out. */
const MIN_BAR_WIDTH = 8;
const FALLBACK_COLUMNS = 80;

/**
 * A terminal's width, or 80 when it will not say.
 *
 * Not paranoia: a PTY that is not a real terminal — `script`, some CI runners,
 * a pipe promoted to a TTY — reports `columns` as **0**, and `??` does not catch
 * a zero. Left alone, that zero makes every optional segment "not fit" and the
 * bar silently degrades to a bare percentage on exactly the machines whose
 * output someone is most likely to be reading. Found by running the thing, not
 * by testing it: every unit test passes an explicit width and so cannot see this.
 */
function usableColumns(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : FALLBACK_COLUMNS;
}

/** `14.2 MB`. Decimal MB, because that is what every download UI and CDN uses. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** `9.6 MB/s`, or `—` before enough time has passed to divide by. */
export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "—";
  }
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

export interface ProgressState {
  readonly name: string;
  readonly read: number;
  /** Null when the server sent no `Content-Length`. */
  readonly total: number | null;
  readonly bytesPerSecond: number | null;
  /** Terminal width, for sizing the bar. */
  readonly columns?: number;
}

/**
 * One line, no newline. With a known total:
 *
 *   `hive-darwin-arm64  [############------------]  52%  34.1/65.2 MB  9.6 MB/s`
 *
 * Without one, the same line minus the two things we would have to invent:
 *
 *   `hive-darwin-arm64  34.1 MB  9.6 MB/s`
 */
export function renderProgressLine(state: ProgressState): string {
  const rate = formatRate(state.bytesPerSecond);
  const columns = usableColumns(state.columns);

  if (state.total === null || state.total <= 0) {
    return `${state.name}  ${formatBytes(state.read)}  ${rate}`;
  }

  const fraction = Math.min(1, Math.max(0, state.read / state.total));
  const percent = `${Math.floor(fraction * 100)}`.padStart(3);
  const counts = `${formatBytes(state.read)}/${formatBytes(state.total)}`;

  // The line must never reach the terminal's width: a wrapped line makes `\r`
  // redraw the wrong row and smears the bar down the screen. So it sheds parts
  // rather than overflowing, cheapest first — the bar is the most decorative
  // thing here and the percentage the least, so the bar goes first and the
  // percentage goes last. A 40-column terminal gets a true, ugly line instead of
  // a pretty, broken one.
  const fits = (line: string): boolean => line.length < columns;

  const bar = (width: number): string => {
    const filled = Math.round(fraction * width);
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
  };

  const withoutBar = `${state.name}  ${percent}%  ${counts}  ${rate}`;
  const room = columns - withoutBar.length - 3; // 2 spaces + the closing bound
  if (room >= MIN_BAR_WIDTH) {
    const width = Math.min(BAR_WIDTH, room);
    return `${state.name}  ${bar(width)}  ${percent}%  ${counts}  ${rate}`;
  }
  if (fits(withoutBar)) return withoutBar;

  const withoutRate = `${state.name}  ${percent}%  ${counts}`;
  if (fits(withoutRate)) return withoutRate;

  return `${state.name}  ${percent}%`;
}

/** Called with bytes-so-far after each chunk; `total` is null without a header. */
export type ProgressCallback = (read: number, total: number | null) => void;

export interface ReporterDeps {
  /** Where the bar is drawn. stderr, so stdout stays pipeable. */
  readonly write?: (text: string) => void;
  /** Redraws only happen when this is true. */
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly now?: () => number;
}

export interface ProgressReporter {
  readonly onProgress: ProgressCallback;
  /** Retire the bar. Leaves a single settled line behind on a TTY. */
  readonly finish: (summary?: string) => void;
}

interface RateSample {
  readonly at: number;
  readonly read: number;
}

/**
 * Announce a download and return the callback that drives its bar.
 *
 * `declaredSize` comes from the verified manifest, so the size is on screen
 * before the connection is even open — the one number a user most wants at the
 * moment they are asked to wait, and the one that costs nothing to show.
 */
export function startDownload(
  name: string,
  declaredSize: number | null,
  deps: ReporterDeps = {},
): ProgressReporter {
  const write = deps.write ?? ((text: string) => process.stderr.write(text));
  const isTTY = deps.isTTY ?? (process.stderr.isTTY === true);
  const now = deps.now ?? (() => Date.now());

  const size = declaredSize === null ? "" : ` (${formatBytes(declaredSize)})`;

  if (!isTTY) {
    // One line, no escapes, no redraw. Safe in a log file and a pipe.
    write(`downloading ${name}${size}\n`);
    return {
      onProgress: () => {},
      finish: (summary?: string) => {
        if (summary !== undefined) write(`${summary}\n`);
      },
    };
  }

  write(dim(`downloading ${name}${size}`) + "\n");

  const startedAt = now();
  let samples: RateSample[] = [{ at: startedAt, read: 0 }];
  let lastDraw = 0;
  let drawn = false;

  const rateFrom = (at: number, read: number): number | null => {
    samples.push({ at, read });
    // Keep only the trailing window, plus the one sample just outside it that
    // gives the window something to subtract from.
    const cutoff = at - RATE_WINDOW_MS;
    const firstInside = samples.findIndex((sample) => sample.at >= cutoff);
    if (firstInside > 0) samples = samples.slice(firstInside - 1);

    const oldest = samples[0];
    if (oldest === undefined) return null;
    const seconds = (at - oldest.at) / 1_000;
    if (seconds <= 0) return null;
    return (read - oldest.read) / seconds;
  };

  const draw = (read: number, total: number | null, force: boolean): void => {
    const at = now();
    if (!force && at - lastDraw < REDRAW_INTERVAL_MS) return;
    lastDraw = at;
    const line = renderProgressLine({
      name,
      read,
      total,
      bytesPerSecond: rateFrom(at, read),
      columns: usableColumns(deps.columns ?? process.stderr.columns),
    });
    write(`${CLEAR_LINE}${dim(line)}`);
    drawn = true;
  };

  return {
    onProgress: (read: number, total: number | null) => draw(read, total, false),
    finish: (summary?: string) => {
      // Replace the bar in place rather than leaving a 99%-complete bar above
      // the result. The bar is scaffolding; the summary is the thing to keep.
      if (drawn) write(CLEAR_LINE);
      if (summary !== undefined) write(`${summary}\n`);
    },
  };
}
