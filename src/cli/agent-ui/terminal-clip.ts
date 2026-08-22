const ESC = "\u001b";
const CSI = "\u009b";
const OSC = "\u009d";
const STRING_TERMINATOR = "\u009c";
const ELLIPSIS = "…";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface TextToken {
  readonly text: string;
  readonly escape: boolean;
}

interface ParsedLine {
  readonly tokens: TextToken[];
  visible: boolean;
}

export interface TerminalTextClipOptions {
  readonly maxCells?: number;
  readonly maxLines?: number;
  readonly edge?: "head" | "tail";
  readonly inline?: boolean;
  readonly omitEmptyLines?: boolean;
}

export interface TerminalTextClip {
  readonly text: string;
  readonly cells: number | null;
  readonly clipped: boolean;
  readonly cellClipped: boolean;
  readonly lineCount: number;
  readonly omittedLines: number;
}

function csiEnd(text: string, bodyStart: number): number | null {
  for (let index = bodyStart; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return null;
  }
  return null;
}

function controlStringEnd(
  text: string,
  bodyStart: number,
  bellTerminates: boolean,
): number | null {
  for (let index = bodyStart; index < text.length; index += 1) {
    if (bellTerminates && text.charCodeAt(index) === 0x07) return index + 1;
    if (text[index] === STRING_TERMINATOR) return index + 1;
    if (text[index] === ESC && text[index + 1] === "\\") return index + 2;
  }
  return null;
}

function escapeEnd(text: string, start: number): number | null {
  const first = text[start];
  if (first === CSI) return csiEnd(text, start + 1);
  if (first === OSC) return controlStringEnd(text, start + 1, true);
  if (
    first === "\u0090" ||
    first === "\u0098" ||
    first === "\u009e" ||
    first === "\u009f"
  ) {
    return controlStringEnd(text, start + 1, false);
  }
  if (first !== ESC) return start + 1;
  const second = text[start + 1];
  if (second === undefined) return null;
  if (second === "[") return csiEnd(text, start + 2);
  if (second === "]") return controlStringEnd(text, start + 2, true);
  if (second === "P" || second === "X" || second === "^" || second === "_") {
    return controlStringEnd(text, start + 2, false);
  }
  let final = start + 1;
  while (final < text.length) {
    const code = text.charCodeAt(final);
    if (code >= 0x30 && code <= 0x7e) return final + 1;
    if (code < 0x20 || code > 0x2f) return null;
    final += 1;
  }
  return null;
}

function isEscapeStart(character: string): boolean {
  return (
    character === ESC ||
    character === CSI ||
    character === OSC ||
    character === "\u0090" ||
    character === "\u0098" ||
    character === "\u009e" ||
    character === "\u009f"
  );
}

function parseLines(text: string) {
  const lines: ParsedLine[] = [{ tokens: [], visible: false }];
  let incompleteEscape = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (isEscapeStart(character)) {
      const end = escapeEnd(text, index);
      if (end === null) {
        incompleteEscape = true;
        break;
      }
      lines.at(-1)?.tokens.push({
        text: text.slice(index, end),
        escape: true,
      });
      index = end;
      continue;
    }
    if (character === "\n") {
      lines.push({ tokens: [], visible: false });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < text.length &&
      text[end] !== "\n" &&
      !isEscapeStart(text[end] ?? "")
    ) {
      end += 1;
    }
    const plain = text.slice(index, end);
    const line = lines.at(-1);
    line?.tokens.push({ text: plain, escape: false });
    if (line !== undefined && Bun.stringWidth(plain) > 0) line.visible = true;
    index = end;
  }
  return { lines, incompleteEscape };
}

function inlineTokens(tokens: readonly TextToken[]): TextToken[] {
  const normalized: TextToken[] = [];
  let hasText = false;
  let pendingSpace = false;
  for (const token of tokens) {
    if (token.escape) {
      normalized.push(token);
      continue;
    }
    for (const part of token.text.split(/(\s+)/u)) {
      if (part === "") continue;
      if (/^\s+$/u.test(part)) {
        pendingSpace = hasText;
      } else {
        if (pendingSpace) normalized.push({ text: " ", escape: false });
        normalized.push({ text: part, escape: false });
        hasText = true;
        pendingSpace = false;
      }
    }
  }
  return normalized;
}

function closeTerminalState(text: string): string {
  return Bun.sliceAnsi(text, 0, Bun.stringWidth(text));
}

function clipCells(tokens: readonly TextToken[], maximum: number): string {
  if (maximum === 0) return "";
  const target = Math.max(0, maximum - Bun.stringWidth(ELLIPSIS));
  const kept: TextToken[] = [];
  let cells = 0;
  let full = false;
  for (const token of tokens) {
    if (token.escape) {
      kept.push(token);
      continue;
    }
    let text = "";
    for (const segment of graphemes.segment(token.text)) {
      const width = Bun.stringWidth(segment.segment);
      if (cells + width > target) {
        full = true;
        break;
      }
      text += segment.segment;
      cells += width;
    }
    if (text !== "") kept.push({ text, escape: false });
    if (full) break;
  }
  const prefix = closeTerminalState(kept.map((token) => token.text).join(""));
  return `${prefix}${ELLIPSIS}`;
}

/** Clips provider-owned terminal text without cutting an escape sequence or a grapheme. Width is measured only here, when view state admits changed text; OpenTUI remains responsible for width during layout and rendering. */
export function clipTerminalText(
  text: string,
  options: TerminalTextClipOptions = {},
): TerminalTextClip {
  const parsed = parseLines(text);
  const sourceLines = options.omitEmptyLines
    ? parsed.lines.filter((line) => line.visible)
    : parsed.lines;
  const lineLimit = Math.max(0, options.maxLines ?? sourceLines.length);
  const omittedLines = Math.max(0, sourceLines.length - lineLimit);
  const selectedLines =
    lineLimit === 0
      ? []
      : omittedLines === 0
        ? sourceLines
        : options.edge === "tail"
          ? sourceLines.slice(-lineLimit)
          : sourceLines.slice(0, lineLimit);
  const tokens: TextToken[] = [];
  for (const [index, line] of selectedLines.entries()) {
    if (index > 0) tokens.push({ text: "\n", escape: false });
    tokens.push(...line.tokens);
  }
  const projected = options.inline ? inlineTokens(tokens) : tokens;
  const joined = projected.map((token) => token.text).join("");
  const width = Bun.stringWidth(joined);
  const maximum =
    options.maxCells === undefined ? width : Math.max(0, options.maxCells);
  const cellClipped = width > maximum;
  const clipped = cellClipped
    ? clipCells(projected, maximum)
    : closeTerminalState(joined);
  return {
    text: clipped,
    cells: options.maxCells === undefined ? null : Bun.stringWidth(clipped),
    clipped: cellClipped || omittedLines > 0 || parsed.incompleteEscape,
    cellClipped,
    lineCount: sourceLines.length,
    omittedLines,
  };
}
