/**
 * What is ON a terminal screen, reconstructed from the bytes that were sent to
 * it.
 *
 * A pane's output stream and its screen are the same thing only for a program
 * that prints and never revises. Every vendor TUI revises: it addresses the
 * cursor, erases regions, and swaps to an alternate screen. Reading the tail of
 * such a stream reports text the terminal has already replaced and can miss
 * text that remains visible elsewhere on the screen.
 *
 * This is a deliberately small VT subset: the sequences a coding TUI actually
 * uses to paint. Anything else is consumed and dropped rather than passed
 * through, because a control sequence rendered as text is worse than a missing
 * one — the reader cannot tell which characters the user would have seen.
 */

const ESC = 0x1b;
const BEL = 0x07;

type Cell = string;

class Screen {
  rows: Cell[][];
  cursorRow = 0;
  cursorColumn = 0;

  constructor(
    readonly columns: number,
    readonly rowCount: number,
  ) {
    this.rows = Array.from({ length: rowCount }, () =>
      Array.from({ length: columns }, () => " "),
    );
  }

  clear(): void {
    for (const row of this.rows) row.fill(" ");
  }

  /** Drop the top line and add a blank one, keeping the NEWEST content. */
  scroll(): void {
    const first = this.rows.shift();
    if (first === undefined) return;
    first.fill(" ");
    this.rows.push(first);
  }

  write(text: string): void {
    for (const character of text) {
      if (this.cursorColumn >= this.columns) {
        this.cursorColumn = 0;
        this.newline();
      }
      const row = this.rows[this.cursorRow];
      if (row !== undefined) row[this.cursorColumn] = character;
      this.cursorColumn += 1;
    }
  }

  newline(): void {
    if (this.cursorRow + 1 >= this.rowCount) this.scroll();
    else this.cursorRow += 1;
  }

  text(): string {
    return this.rows
      .map((row) => row.join("").replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }
}

/** Parameters of a CSI sequence, with a default for the empty case. */
function parameters(raw: string, fallback: number): number[] {
  const values = raw
    .split(";")
    .map((value) => (value === "" ? fallback : Number.parseInt(value, 10)));
  return values.map((value) => (Number.isFinite(value) ? value : fallback));
}

/**
 * A terminal that can be fed a session's bytes in pieces and asked, at any
 * point, what is on its screen.
 *
 * Incremental matters for more than convenience. A viewer receives a pane's
 * output as a series of frames chosen by the host's chunking, not by where
 * escape sequences happen to end, so a parser that starts fresh per chunk
 * prints the tail of a split sequence as literal text. It also removes the
 * reason to cap the input: a screen is bounded by its own rows and columns, so
 * the emulator can consume a megabyte and still occupy one window. Capping the
 * BYTES instead discards the head of the stream — which is precisely where a
 * repainting TUI puts the full-screen paint everything after it revises.
 */
export class TerminalScreen {
  private primary: Screen;
  private alternate: Screen | null = null;
  /** An escape sequence cut in half by a frame boundary, awaiting its rest. */
  private leftover = "";
  private readonly width: number;
  private readonly height: number;

  constructor(columns: number, rows: number) {
    this.width = Math.max(1, Math.floor(columns));
    this.height = Math.max(1, Math.floor(rows));
    this.primary = new Screen(this.width, this.height);
  }

  private active(): Screen {
    return this.alternate ?? this.primary;
  }

  /** Apply the next piece of the stream. */
  write(chunk: string): void {
    const stream = this.leftover + chunk;
    this.leftover = "";

    let index = 0;
    let pending = "";
    const flush = (): void => {
      if (pending === "") return;
      this.active().write(pending);
      pending = "";
    };

    while (index < stream.length) {
      const code = stream.charCodeAt(index);

      if (code === ESC) {
        flush();
        if (index + 1 >= stream.length) {
          // A lone ESC at the boundary: hold it for the next frame.
          this.leftover = stream.slice(index);
          return;
        }
        const next = stream[index + 1];
        if (next === "[") {
          // CSI: parameters, then a final byte in @..~
          let cursor = index + 2;
          while (
            cursor < stream.length &&
            /[0-9;?<>!]/.test(stream[cursor] ?? "")
          ) {
            cursor += 1;
          }
          if (cursor >= stream.length) {
            this.leftover = stream.slice(index);
            return;
          }
          const final = stream[cursor] ?? "";
          const raw = stream.slice(index + 2, cursor).replace(/^[?<>!]/, "");
          const private_ = /^[?<>!]/.test(stream.slice(index + 2, cursor));
          this.applyCsi(final, raw, private_);
          index = cursor + 1;
          continue;
        }
        if (next === "]") {
          // OSC runs to BEL or ST; it sets titles and never paints cells.
          let cursor = index + 2;
          let terminated = false;
          while (cursor < stream.length) {
            if (stream.charCodeAt(cursor) === BEL) {
              terminated = true;
              break;
            }
            if (stream.charCodeAt(cursor) === ESC) {
              if (cursor + 1 >= stream.length) break;
              if (stream[cursor + 1] === "\\") {
                cursor += 1;
                terminated = true;
                break;
              }
            }
            cursor += 1;
          }
          if (!terminated) {
            this.leftover = stream.slice(index);
            return;
          }
          index = cursor + 1;
          continue;
        }
        if (next === "(" || next === ")" || next === "#") {
          if (index + 2 >= stream.length) {
            this.leftover = stream.slice(index);
            return;
          }
          index += 3;
          continue;
        }
        if (next === "M") {
          // Reverse index: scroll down at the top of the screen.
          const screen = this.active();
          if (screen.cursorRow > 0) screen.cursorRow -= 1;
          index += 2;
          continue;
        }
        // Two-byte escapes we do not model (=, >, 7, 8, …) paint nothing.
        index += 2;
        continue;
      }

      const character = stream[index] ?? "";
      if (character === "\n") {
        flush();
        this.active().newline();
        index += 1;
        continue;
      }
      if (character === "\r") {
        flush();
        this.active().cursorColumn = 0;
        index += 1;
        continue;
      }
      if (character === "\b") {
        flush();
        const screen = this.active();
        screen.cursorColumn = Math.max(0, screen.cursorColumn - 1);
        index += 1;
        continue;
      }
      if (character === "\t") {
        flush();
        const screen = this.active();
        screen.cursorColumn = Math.min(
          screen.columns - 1,
          (Math.floor(screen.cursorColumn / 8) + 1) * 8,
        );
        index += 1;
        continue;
      }
      if (code < 0x20 && character !== "") {
        // Any other C0 control paints nothing.
        flush();
        index += 1;
        continue;
      }
      pending += character;
      index += 1;
    }
    flush();
  }

  /** What the screen is showing now. */
  text(): string {
    return this.active().text();
  }

  private applyCsi(final: string, raw: string, private_: boolean): void {
    const screen = this.active();
    const width = this.width;
    const height = this.height;
    switch (final) {
      case "H":
      case "f": {
        const [row = 1, column = 1] = parameters(raw, 1);
        screen.cursorRow = Math.min(
          screen.rowCount - 1,
          Math.max(0, (row ?? 1) - 1),
        );
        screen.cursorColumn = Math.min(
          screen.columns - 1,
          Math.max(0, (column ?? 1) - 1),
        );
        return;
      }
      case "A": {
        const [count = 1] = parameters(raw, 1);
        screen.cursorRow = Math.max(0, screen.cursorRow - (count ?? 1));
        return;
      }
      case "B": {
        const [count = 1] = parameters(raw, 1);
        screen.cursorRow = Math.min(
          screen.rowCount - 1,
          screen.cursorRow + (count ?? 1),
        );
        return;
      }
      case "C": {
        const [count = 1] = parameters(raw, 1);
        screen.cursorColumn = Math.min(
          screen.columns - 1,
          screen.cursorColumn + (count ?? 1),
        );
        return;
      }
      case "D": {
        const [count = 1] = parameters(raw, 1);
        screen.cursorColumn = Math.max(0, screen.cursorColumn - (count ?? 1));
        return;
      }
      case "G": {
        const [column = 1] = parameters(raw, 1);
        screen.cursorColumn = Math.min(
          screen.columns - 1,
          Math.max(0, (column ?? 1) - 1),
        );
        return;
      }
      case "J": {
        const [mode = 0] = parameters(raw, 0);
        if (mode === 2 || mode === 3) {
          screen.clear();
          return;
        }
        if (mode === 0) {
          const row = screen.rows[screen.cursorRow];
          if (row !== undefined) row.fill(" ", screen.cursorColumn);
          for (let i = screen.cursorRow + 1; i < screen.rowCount; i += 1) {
            screen.rows[i]?.fill(" ");
          }
          return;
        }
        // mode 1: erase from the start of the display to the cursor.
        for (let i = 0; i < screen.cursorRow; i += 1) screen.rows[i]?.fill(" ");
        screen.rows[screen.cursorRow]?.fill(" ", 0, screen.cursorColumn + 1);
        return;
      }
      case "K": {
        const [mode = 0] = parameters(raw, 0);
        const row = screen.rows[screen.cursorRow];
        if (row === undefined) return;
        if (mode === 0) row.fill(" ", screen.cursorColumn);
        else if (mode === 1) row.fill(" ", 0, screen.cursorColumn + 1);
        else row.fill(" ");
        return;
      }
      case "h":
      case "l": {
        if (!private_) return;
        const [mode] = parameters(raw, 0);
        // 1049/47/1047 are the alternate screen. Entering gives a blank buffer
        // and hides the primary; leaving throws the alternate away.
        if (mode === 1049 || mode === 47 || mode === 1047) {
          if (final === "h") this.alternate = new Screen(width, height);
          else this.alternate = null;
        }
        return;
      }
      case "r": {
        // Scroll region: not modelled, but it must not paint.
        return;
      }
      default:
        // SGR (m), device queries, and everything else change no cell.
        return;
    }
  }
}

/**
 * Render `stream` as the screen a terminal of this size would be showing.
 *
 * The stream may begin mid-session — a viewer attaches to a pane that has been
 * running — so an unmatched "leave alternate screen" is normal and simply means
 * the capture started inside one.
 */
export function renderVisibleScreen(
  stream: string,
  columns: number,
  rows: number,
): string {
  const screen = new TerminalScreen(columns, rows);
  screen.write(stream);
  return screen.text();
}
