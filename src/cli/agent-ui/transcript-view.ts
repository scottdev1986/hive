import {
  BoxRenderable,
  bold,
  type CliRenderer,
  fg,
  italic,
  MarkdownRenderable,
  type Renderable,
  type ScrollBoxRenderable,
  StyledText,
  type SyntaxStyle,
  type TextChunk,
  TextRenderable,
  type TreeSitterClient,
} from "@opentui/core";
import type { ElicitationOption } from "../../adapters/providers/protocol/types";
import { definedFields } from "../../shared/defined-fields";
import { clipTerminalText } from "./terminal-clip";
import { clockLabel, compactElapsedLabel } from "./events-format";
import {
  answerSummary,
  currentQuestion,
  customRowIndex,
  isQuestionAnswered,
  pickerOptions,
  type TranscriptEntry,
} from "./view-state";

type ElicitationEntry = Extract<TranscriptEntry, { kind: "elicitation" }>;

/** What the chat draws: what people and agents said to each other, the questions put to a person with their answers, and diagnostics that need one. Compaction stays because a person typed the command. */
export function isChatEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case "user":
    case "agent":
    case "message":
    case "elicitation":
    case "diagnostic":
    case "compaction":
      return true;
    case "tool":
    case "thought":
    case "mail":
    case "plan":
    case "diff":
      return false;
  }
}

/** A renderable of its own paints a final newline as an empty row, where the same chunks inside a longer text would not. */
function withoutTrailingNewline(chunks: TextChunk[]): TextChunk[] {
  const last = chunks.at(-1);
  if (last === undefined || !last.text.endsWith("\n")) return chunks;
  return [...chunks.slice(0, -1), { ...last, text: last.text.slice(0, -1) }];
}

export interface TranscriptColors {
  readonly text: string;
  readonly dim: string;
  readonly gray: string;
  readonly blue: string;
  readonly purple: string;
  readonly teal: string;
  readonly green: string;
  readonly orange: string;
  readonly red: string;
  readonly yellow: string;
  readonly headerAlt: string;
}

export interface TranscriptIdentity {
  readonly mark: string;
  readonly accent: string;
  readonly workspacePath?: string;
}

const PROSE_WIDTH = 104;
const RENDER_WINDOW_ENTRIES = 256;
const RENDER_WINDOW_OVERFLOW = 64;
/** A tab carries its answer so the strip doubles as the running record, clipped so four answered questions still fit one row. */
const TAB_ANSWER_CELLS = 24;

class StreamingTextRenderable extends TextRenderable {
  private renderedText = this.plainText;

  updateStreamingText(text: string): void {
    if (text === this.renderedText) return;
    if (!text.startsWith(this.renderedText)) {
      this.content = text;
      this.renderedText = text;
      return;
    }
    const tail = text.slice(this.renderedText.length);
    this.renderedText = text;
    if (tail === "") return;
    this.textBuffer.append(tail);
    this.updateTextInfo();
  }
}

function line(
  chunks: TextChunk[],
  text: string,
  color: string,
  emphasis = false,
): void {
  const colored = fg(color)(`${text}\n`);
  chunks.push(emphasis ? bold(colored) : colored);
}

export class TranscriptView {
  private readonly built: { entry: TranscriptEntry; renderable: Renderable }[] =
    [];
  /** The transcript the owner last handed over, and the indexes into it of the entries the chat shows. Tool calls, thoughts, mail notices, plans and diffs are not conversation; they belong to the events view, and the window and paging below count only what is drawn. */
  private source: readonly TranscriptEntry[] = [];
  private visible: number[] = [];
  private entries: TranscriptEntry[] = [];
  private windowStart = 0;
  private windowEnd = 0;
  private followsTail = true;
  private historyNote: TextRenderable | null = null;
  private readonly leadingCount: number;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly content: ScrollBoxRenderable,
    private readonly colors: TranscriptColors,
    private readonly syntaxStyle: SyntaxStyle,
    private readonly treeSitter: TreeSitterClient | null,
    private readonly identity: TranscriptIdentity,
    leading?: Renderable,
  ) {
    if (leading !== undefined) this.content.add(leading);
    this.leadingCount = leading === undefined ? 0 : 1;
  }

  /** Set by the owner: a click on an elicitation row, by request id and row index. */
  onPickRow: ((requestId: string, row: number) => void) | null = null;

  update(source: readonly TranscriptEntry[], sourceChangedStart = 0): void {
    // Re-derive the visible list from the first changed source entry; everything before it is unchanged by construction. A different buffer object starts over.
    const from = source === this.source ? Math.max(0, sourceChangedStart) : 0;
    let keep = this.visible.length;
    // SAFETY: keep is bounded by the array length.
    while (keep > 0 && (this.visible[keep - 1] as number) >= from) keep -= 1;
    this.visible.length = keep;
    this.entries.length = keep;
    for (let index = from; index < source.length; index += 1) {
      const entry = source[index];
      if (entry === undefined || !isChatEntry(entry)) continue;
      this.visible.push(index);
      this.entries.push(entry);
    }
    this.source = source;
    const changedStart = keep;
    const entries = this.entries;
    let nextStart = this.windowStart;
    let nextEnd: number;
    if (this.followsTail) {
      if (
        entries.length - nextStart >
        RENDER_WINDOW_ENTRIES + RENDER_WINDOW_OVERFLOW
      ) {
        nextStart = Math.max(0, entries.length - RENDER_WINDOW_ENTRIES);
      }
      nextEnd = entries.length;
    } else {
      nextStart = Math.min(nextStart, Math.max(0, entries.length - 1));
      nextEnd = Math.min(entries.length, nextStart + RENDER_WINDOW_ENTRIES);
    }
    if (nextStart !== this.windowStart) {
      this.windowStart = nextStart;
      this.windowEnd = nextEnd;
      this.rebuildWindow();
      return;
    }
    this.windowEnd = nextEnd;
    this.updateHistoryNote();
    const first = Math.max(
      0,
      Math.min(changedStart - this.windowStart, this.built.length),
    );
    const count = this.windowEnd - this.windowStart;
    for (let index = first; index < count; index += 1) {
      const entry = entries[this.windowStart + index];
      if (entry === undefined) continue;
      const existing = this.built[index];
      if (existing !== undefined && existing.entry === entry) continue;
      if (existing !== undefined && existing.entry.kind === entry.kind) {
        this.refill(existing.renderable, entry);
        existing.entry = entry;
        continue;
      }
      this.replace(index, entry, existing?.renderable);
    }
    while (this.built.length > count) {
      const extra = this.built.pop();
      if (extra === undefined) break;
      this.content.remove(extra.renderable);
      extra.renderable.destroyRecursively();
    }
  }

  pageEarlier(): boolean {
    if (this.windowStart === 0) return false;
    this.followsTail = false;
    this.windowEnd = this.windowStart;
    this.windowStart = Math.max(0, this.windowEnd - RENDER_WINDOW_ENTRIES);
    this.rebuildWindow();
    return true;
  }

  pageLater(): boolean {
    if (this.windowEnd >= this.entries.length) return false;
    this.windowStart = this.windowEnd;
    this.windowEnd = Math.min(
      this.entries.length,
      this.windowStart + RENDER_WINDOW_ENTRIES,
    );
    this.followsTail = this.windowEnd === this.entries.length;
    this.rebuildWindow();
    return true;
  }

  private rebuildWindow(): void {
    while (this.built.length > 0) {
      const built = this.built.pop();
      if (built === undefined) break;
      this.content.remove(built.renderable);
      built.renderable.destroyRecursively();
    }
    this.updateHistoryNote();
    for (let index = this.windowStart; index < this.windowEnd; index += 1) {
      const entry = this.entries[index];
      if (entry !== undefined) {
        this.replace(index - this.windowStart, entry, undefined);
      }
    }
  }

  private updateHistoryNote(): void {
    const earlier = this.windowStart;
    const later = this.entries.length - this.windowEnd;
    if (earlier === 0 && later === 0) {
      if (this.historyNote !== null) {
        this.content.remove(this.historyNote);
        this.historyNote.destroyRecursively();
        this.historyNote = null;
      }
      return;
    }
    const hidden = [
      earlier === 0 ? "" : `${earlier} earlier`,
      later === 0 ? "" : `${later} later`,
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const content = `Transcript window · ${hidden} · PageUp/PageDown at the edge`;
    if (this.historyNote === null) {
      this.historyNote = new TextRenderable(this.renderer, {
        height: 1,
        content,
        fg: this.colors.dim,
      });
      this.content.add(this.historyNote, this.leadingCount);
    } else if (this.historyNote.plainText !== content) {
      this.historyNote.content = content;
    }
  }

  private entryOffset(): number {
    return this.leadingCount + (this.historyNote === null ? 0 : 1);
  }

  private replace(
    index: number,
    entry: TranscriptEntry,
    previous: Renderable | undefined,
  ): void {
    if (previous !== undefined) {
      this.content.remove(previous);
      previous.destroyRecursively();
    }
    const renderable = this.build(entry);
    this.markSelectionSurface(renderable);
    this.content.add(renderable, index + this.entryOffset());
    this.built[index] = { entry, renderable };
  }

  private markSelectionSurface(renderable: Renderable): void {
    if (!renderable.selectable) {
      renderable.selectable = true;
      renderable.shouldStartSelection = () => true;
    }
    for (const child of renderable.getChildren()) {
      this.markSelectionSurface(child);
    }
  }

  private build(entry: TranscriptEntry): Renderable {
    if (entry.kind === "user") return this.buildUser(entry);
    if (entry.kind === "agent") return this.buildAgent(entry);
    if (entry.kind === "message") return this.buildMessage(entry);
    if (entry.kind === "elicitation") return this.buildElicitation(entry);
    return this.buildText(entry);
  }

  private refill(renderable: Renderable, entry: TranscriptEntry): void {
    if (entry.kind === "agent") {
      const streaming = renderable
        .getChildren()
        .find((child) => child instanceof StreamingTextRenderable);
      if (entry.streaming && streaming instanceof StreamingTextRenderable) {
        streaming.updateStreamingText(entry.text);
        return;
      }
      const markdown = renderable
        .getChildren()
        .find((child) => child instanceof MarkdownRenderable);
      if (!entry.streaming && markdown instanceof MarkdownRenderable) {
        if (markdown.content !== entry.text) markdown.content = entry.text;
        return;
      }
      const index = this.built.findIndex(
        (built) => built.renderable === renderable,
      );
      if (index !== -1) this.replace(index, entry, renderable);
      return;
    }
    if (
      entry.kind === "user" ||
      entry.kind === "message" ||
      entry.kind === "elicitation"
    ) {
      const index = this.built.findIndex(
        (built) => built.renderable === renderable,
      );
      if (index !== -1) this.replace(index, entry, renderable);
      return;
    }
    if (renderable instanceof TextRenderable) {
      renderable.content = this.textContent(entry);
    }
  }

  private buildAgent(
    entry: Extract<TranscriptEntry, { kind: "agent" }>,
  ): Renderable {
    const row = new BoxRenderable(this.renderer, {
      width: "100%",
      maxWidth: PROSE_WIDTH,
      height: "auto",
      flexDirection: "row",
      marginTop: 1,
    });
    row.add(
      new TextRenderable(this.renderer, {
        width: 3,
        height: 1,
        content: this.identity.mark,
        fg: this.identity.accent,
      }),
    );
    row.add(
      entry.streaming
        ? this.buildStreamingText(entry)
        : this.buildMarkdown(entry),
    );
    return row;
  }

  private buildStreamingText(
    entry: Extract<TranscriptEntry, { kind: "agent" }>,
  ): StreamingTextRenderable {
    return new StreamingTextRenderable(this.renderer, {
      id: `agent-ui-stream-${entry.turnId}`,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      height: "auto",
      content: entry.text,
      fg: this.colors.text,
      wrapMode: "word",
    });
  }

  private buildMarkdown(
    entry: Extract<TranscriptEntry, { kind: "agent" }>,
  ): MarkdownRenderable {
    return new MarkdownRenderable(this.renderer, {
      id: `agent-ui-markdown-${entry.turnId}`,
      flexGrow: 1,
      // Yoga's default flexShrink is 0, so without this a wide block — a table, a long code line — sets the flex basis to its natural width and pushes the whole reply off the screen edge.
      flexShrink: 1,
      minWidth: 1,
      height: "auto",
      syntaxStyle: this.syntaxStyle,
      conceal: true,
      streaming: false,
      content: entry.text,
      ...definedFields({
        treeSitterClient: this.treeSitter ?? undefined,
      }),
    });
  }

  /** Mail between this agent and another as conversation. Inbound carries a left rule so another voice reads as another voice; both directions say who, which lane, and when. */
  private buildMessage(
    entry: Extract<TranscriptEntry, { kind: "message" }>,
  ): Renderable {
    const inbound = entry.direction === "in";
    const box = new BoxRenderable(this.renderer, {
      id: `agent-ui-message-${entry.key}`,
      width: "100%",
      maxWidth: PROSE_WIDTH,
      height: "auto",
      flexDirection: "column",
      marginTop: 1,
    });
    // Border set only when a border is wanted: OpenTUI treats a borderColor in the constructor options as a request for a border, so a "borderless" box that still names a color is drawn with all four sides.
    if (inbound) {
      box.border = ["left"];
      box.borderColor = this.colors.gray;
      box.paddingLeft = 1;
    }
    const from = inbound ? entry.peer : "you";
    const to = inbound ? "you" : entry.peer;
    const topic = entry.topic === null ? "" : ` · ${entry.topic}`;
    const header = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      truncate: true,
      selectable: true,
    });
    header.content = new StyledText([
      bold(
        fg(inbound ? this.colors.blue : this.colors.teal)(
          inbound ? "↓ " : "↑ ",
        ),
      ),
      fg(this.colors.gray)(`${from} → ${to}`),
      fg(this.colors.dim)(` · ${entry.lane}${topic} · ${clockLabel(entry.at)}`),
    ]);
    box.add(header);
    box.add(
      new MarkdownRenderable(this.renderer, {
        width: "100%",
        height: "auto",
        // Padding, not margin: a margin shifts the full-width child past the box edge, so line-final words print on top of the border. Padding keeps the wrap width inside the box.
        paddingLeft: 2,
        syntaxStyle: this.syntaxStyle,
        conceal: true,
        streaming: false,
        content: entry.body,
        ...definedFields({
          treeSitterClient: this.treeSitter ?? undefined,
        }),
      }),
    );
    return box;
  }

  private buildUser(
    entry: Extract<TranscriptEntry, { kind: "user" }>,
  ): Renderable {
    const status =
      entry.delivery === "accepted" || entry.delivery === "queued"
        ? ""
        : entry.delivery === "submitting"
          ? " · sending"
          : entry.delivery === "rejected"
            ? " · not sent"
            : " · delivery unknown";
    const statusColor =
      entry.delivery === "rejected" || entry.delivery === "unknown"
        ? this.colors.red
        : this.colors.dim;
    const chunks: TextChunk[] = [
      bold(fg(this.colors.dim)("> ")),
      fg(this.colors.gray)(entry.text),
    ];
    if (status !== "") chunks.push(fg(statusColor)(status));
    const text = new TextRenderable(this.renderer, {
      width: "100%",
      maxWidth: PROSE_WIDTH,
      height: "auto",
      marginTop: 1,
      wrapMode: "word",
      selectable: true,
    });
    text.content = new StyledText(chunks);
    return text;
  }

  /** An elicitation card: a titled, bordered block that reads as one thing needing an answer rather than as more transcript. A pending ask is the only thing on screen the person must act on, so it is the only thing given a full border and an accent colour. Once settled it drops to a quiet grey rule carrying what was asked and answered, no longer competing with whatever is live. */
  private buildElicitation(entry: ElicitationEntry): Renderable {
    const accent = entry.settled
      ? this.colors.gray
      : entry.ask === "approval"
        ? this.colors.orange
        : this.colors.blue;
    const box = new BoxRenderable(this.renderer, {
      width: "100%",
      maxWidth: PROSE_WIDTH,
      height: "auto",
      flexDirection: "column",
      border: entry.settled ? ["left"] : true,
      borderStyle: "rounded",
      borderColor: accent,
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: 1,
      ...definedFields({
        title: entry.settled ? undefined : this.cardTitle(entry),
        titleAlignment: entry.settled ? undefined : ("left" as const),
      }),
    });
    if (entry.settled) {
      box.add(this.styledLines(this.settledSummary(entry), true));
      return box;
    }
    const head: TextChunk[] = [];
    if (entry.questions.length > 1)
      head.push(...this.questionTabs(entry, accent));
    head.push(...this.prompt(entry));
    box.add(this.styledLines(head, true));
    const rows = this.optionRows(entry, accent);
    for (const row of rows) box.add(row);
    const hints = this.keyHints(entry);
    if (hints.length > 0) {
      box.add(
        this.styledLines(
          rows.length > 0 ? [fg(this.colors.dim)("\n"), ...hints] : hints,
          true,
        ),
      );
    }
    return box;
  }

  /** One renderable per row so a click can name the row it landed on; the highlight still lives in view state, never in the renderable. */
  private pickableRow(
    requestId: string,
    row: number,
    chunks: TextChunk[],
  ): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
      selectable: true,
      onMouseUp: (event) => {
        const selected = this.renderer.getSelection()?.getSelectedText() ?? "";
        if (selected !== "") return;
        event.preventDefault();
        this.onPickRow?.(requestId, row);
      },
    });
    text.content = new StyledText(withoutTrailingNewline(chunks));
    return text;
  }

  private styledLines(
    chunks: TextChunk[],
    selectable: boolean,
  ): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
      selectable,
    });
    text.content = new StyledText(withoutTrailingNewline(chunks));
    return text;
  }

  private cardTitle(entry: ElicitationEntry): string {
    if (entry.ask === "approval") return " Approval ";
    const total = entry.questions.length;
    return total > 1
      ? ` Question ${entry.focus + 1} of ${total} `
      : " Question ";
  }

  /** One pill per question so a multi-question ask reads as a set to move through rather than a chute: the focused one is bracketed, answered ones carry a tick. */
  private questionTabs(entry: ElicitationEntry, accent: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    for (const [index, question] of entry.questions.entries()) {
      const answered = isQuestionAnswered(entry, question.questionId);
      const answer = answered ? answerSummary(entry, question) : null;
      const shown =
        answer === null
          ? ""
          : `: ${clipTerminalText(answer, { maxCells: TAB_ANSWER_CELLS, inline: true }).text}`;
      const label = `${answered ? "✓ " : ""}${question.header ?? `Q${index + 1}`}${shown}`;
      if (index > 0) chunks.push(fg(this.colors.dim)("  "));
      chunks.push(
        index === entry.focus
          ? bold(fg(accent)(`[ ${label} ]`))
          : fg(answered ? this.colors.green : this.colors.dim)(label),
      );
    }
    chunks.push(fg(this.colors.dim)("\n\n"));
    return chunks;
  }

  private prompt(entry: ElicitationEntry): TextChunk[] {
    const question = currentQuestion(entry);
    if (entry.ask === "approval") {
      const chunks: TextChunk[] = [fg(this.colors.dim)(`${entry.summary}\n`)];
      if (entry.detail !== null) {
        chunks.push(bold(fg(this.colors.text)(`${entry.detail}\n`)));
      }
      chunks.push(fg(this.colors.dim)("\n"));
      return chunks;
    }
    const chunks: TextChunk[] = [];
    // The header is the tab label once there are tabs; repeating it above the question would say the same word twice in two rows.
    if (question?.header != null && entry.questions.length === 1) {
      chunks.push(fg(this.colors.dim)(`${question.header}\n`));
    }
    chunks.push(
      fg(this.colors.text)(
        `${question?.text ?? entry.detail ?? entry.summary}\n\n`,
      ),
    );
    return chunks;
  }

  /** The option rows, drawn as text rather than a focusable Select. The composer keeps focus the whole time a question is up, so a person can still type instead of choosing, and OpenTUI delivers arrow keys to the focused renderable. Owning the highlight here keeps one component reading the keyboard rather than two negotiating over it. */
  private optionRows(entry: ElicitationEntry, accent: string): Renderable[] {
    const question = currentQuestion(entry);
    const options = pickerOptions(entry);
    const multi = question?.multiSelect === true;
    const picked = new Set(
      question === null ? [] : (entry.chosen[question.questionId] ?? []),
    );
    const rows: Renderable[] = [];
    const rowStyle = (focused: boolean, on: boolean, text: string) =>
      focused
        ? bold(fg(accent)(text))
        : fg(on ? this.colors.green : this.colors.text)(text);
    for (const [index, option] of options.entries()) {
      const chunks: TextChunk[] = [];
      const focused = index === entry.selection;
      const on = picked.has(option.optionId);
      const mark = multi ? (on ? "[x] " : "[ ] ") : "";
      const tick = !multi && on ? "  ✓" : "";
      chunks.push(
        rowStyle(
          focused,
          on,
          `${focused ? "❯" : " "} ${mark}${index + 1}  ${option.name}${tick}\n`,
        ),
      );
      const indent = `   ${multi ? "    " : ""}   `;
      const description = option.description ?? null;
      if (description !== null && description !== "") {
        chunks.push(fg(this.colors.dim)(`${indent}${description}\n`));
      }
      // A preview is the option shown rather than described, so only the highlighted one gets the room.
      const preview = focused ? (option.preview ?? null) : null;
      if (preview !== null && preview.trim() !== "") {
        for (const line of preview.trimEnd().split("\n")) {
          chunks.push(fg(this.colors.text)(`${indent}│ ${line}\n`));
        }
      }
      rows.push(this.pickableRow(entry.requestId, index, chunks));
    }
    const customRow = customRowIndex(entry);
    if (customRow !== null) {
      rows.push(
        this.pickableRow(
          entry.requestId,
          customRow,
          this.customRow(
            entry,
            options,
            customRow === entry.selection,
            multi,
            accent,
          ),
        ),
      );
    }
    return rows;
  }

  /** The "Other" row is the text field: what is being typed shows here, with a caret, in place of a prompt below the card. */
  private customRow(
    entry: ElicitationEntry,
    options: readonly ElicitationOption[],
    focused: boolean,
    multi: boolean,
    accent: string,
  ): TextChunk[] {
    const question = currentQuestion(entry);
    const typed =
      question === null
        ? []
        : (entry.chosen[question.questionId] ?? []).filter(
            (label) => !options.some((option) => option.optionId === label),
          );
    const answered =
      question?.secret === true && typed.length > 0
        ? "••••••"
        : typed.join(", ");
    const lead = `${focused ? "❯" : " "} ${multi ? "    " : ""}✎  `;
    if (entry.draft !== "") {
      return [
        focused ? bold(fg(accent)(lead)) : fg(this.colors.dim)(lead),
        fg(this.colors.text)(entry.draft),
        focused ? fg(accent)("▏\n") : fg(this.colors.dim)("\n"),
      ];
    }
    if (answered !== "") {
      return [
        focused
          ? bold(fg(accent)(`${lead}${answered}▏\n`))
          : fg(this.colors.green)(`${lead}${answered}\n`),
      ];
    }
    return [
      focused
        ? [
            bold(fg(accent)(lead)),
            italic(fg(this.colors.dim)("Type your own answer…▏\n")),
          ]
        : [italic(fg(this.colors.dim)(`${lead}Other — type your own\n`))],
    ].flat();
  }

  private keyHints(entry: ElicitationEntry): TextChunk[] {
    const question = currentQuestion(entry);
    const options = pickerOptions(entry);
    const hints: string[] = [];
    if (options.length > 0) {
      hints.push(
        "↑↓",
        question?.multiSelect === true ? "space tick · enter confirm" : "enter",
        "1-9",
      );
    } else if (question?.allowCustom === true) {
      hints.push(
        question.secret
          ? "type a private answer (masked) · enter"
          : "type · enter",
      );
    }
    if (entry.questions.length > 1) hints.push("←→ questions");
    const reject = options.find((option) => option.kind === "reject");
    if (reject !== undefined) {
      hints.push(entry.reply === "option" ? "esc reject" : "esc interrupt");
    } else if (entry.reply !== "answers") {
      hints.push("esc interrupt");
    }
    if (hints.length === 0) return [];
    return [italic(fg(this.colors.dim)(hints.join(" · ")))];
  }

  /** The settled record: what was asked and what was answered, or that it was refused, on one grey line. */
  private settledSummary(entry: ElicitationEntry): TextChunk[] {
    const refused = entry.outcome === "deny" || entry.outcome === "cancelled";
    const chunks: TextChunk[] = [
      fg(refused ? this.colors.red : this.colors.gray)(refused ? "✗ " : "✓ "),
    ];
    const answers = entry.questions.flatMap((question) => {
      const shown = answerSummary(entry, question);
      if (shown === null) return [];
      const name =
        question.header ?? (entry.questions.length > 1 ? question.text : null);
      return [name === null ? shown : `${name}: ${shown}`];
    });
    if (entry.ask === "approval" || answers.length === 0) {
      chunks.push(fg(this.colors.gray)(entry.summary));
      if (answers.length > 0)
        chunks.push(fg(this.colors.dim)(` — ${answers.join(" · ")}`));
    } else {
      chunks.push(fg(this.colors.gray)(answers.join(" · ")));
    }
    return chunks;
  }

  private buildText(entry: TranscriptEntry): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      width: "100%",
      maxWidth: PROSE_WIDTH,
      height: "auto",
      marginTop: 1,
      wrapMode: "word",
      selectable: true,
    });
    text.content = this.textContent(entry);
    return text;
  }

  private textContent(entry: TranscriptEntry): StyledText {
    const chunks: TextChunk[] = [];
    switch (entry.kind) {
      case "diagnostic":
        if (entry.severity === "warning") {
          line(chunks, "⚠ Hive", this.colors.yellow, true);
          line(chunks, entry.message, this.colors.yellow);
        } else {
          line(chunks, "! Hive", this.colors.red, true);
          line(chunks, entry.message, this.colors.red);
        }
        break;
      case "compaction": {
        line(chunks, entry.command, this.colors.gray, true);
        switch (entry.status) {
          case "queued":
            line(chunks, "  ○ Compaction queued", this.colors.dim);
            break;
          case "starting":
            line(chunks, "  ✳ Starting compaction…", this.colors.blue);
            break;
          case "running":
            line(chunks, "  ✳ Compacting context…", this.colors.blue);
            break;
          case "ok": {
            const result =
              entry.completionEvidence === "provider"
                ? "Context compacted"
                : "Compaction command completed";
            const context =
              entry.contextBefore !== null &&
              entry.contextAfter !== null &&
              entry.contextBefore !== entry.contextAfter
                ? ` · ${Math.round(entry.contextBefore)}% → ${Math.round(entry.contextAfter)}%`
                : "";
            line(
              chunks,
              `  ✓ ${result} · ${compactElapsedLabel(entry.requestedAt, entry.completedAt)}${context}`,
              this.colors.green,
            );
            break;
          }
          case "error":
            line(
              chunks,
              `  ✕ Compaction failed${entry.detail === null ? "" : ` · ${entry.detail}`}`,
              this.colors.red,
            );
            break;
          case "unknown":
            line(
              chunks,
              `  ? Compaction outcome unknown${entry.detail === null ? "" : ` · ${entry.detail}`}`,
              this.colors.yellow,
            );
            break;
          case "cancelled":
            line(chunks, "  ■ Compaction cancelled", this.colors.yellow);
            break;
          case "unavailable":
            line(
              chunks,
              `  — Compaction unavailable${entry.detail === null ? "" : ` · ${entry.detail}`}`,
              this.colors.yellow,
            );
            break;
        }
        break;
      }
      default:
        line(chunks, "", this.colors.text);
        break;
    }
    return new StyledText(chunks);
  }
}
