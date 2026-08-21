import { isAbsolute, relative } from "node:path";
import {
  BoxRenderable,
  bg,
  bold,
  type CliRenderer,
  CodeRenderable,
  DiffRenderable,
  detectLinks,
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
import {
  filetypeFor,
  ToolDiffProjectionCache,
  unifiedDiffStats,
} from "./unified-diff";
import {
  currentQuestion,
  pickerOptions,
  type TranscriptEntry,
} from "./view-state";

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

/** Edit diffs show inline without ctrl+o — seeing the change is the point of watching an agent work — but a huge edit is clipped to this many rows so it cannot swallow the pane. Clipping is by layout height, never by cutting diff text: a truncated hunk whose header disagrees with its body renders as a parse error instead of a diff. */
const COMPACT_DIFF_ROWS = 16;
const PROSE_WIDTH = 104;
const TOOL_WIDTH = 116;
const RENDER_WINDOW_ENTRIES = 256;
const RENDER_WINDOW_OVERFLOW = 64;

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

const TOOL_LABELS: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
  other: "Tool",
};

function displayToolName(name: string): string {
  const leaf = name.split("__").at(-1) ?? name;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (words === "") return "Tool";
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

function elapsedLabel(startedAt: string, completedAt: string): string {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "Worked";
  if (elapsed < 60_000) return `Worked for ${Math.round(elapsed / 1_000)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.round((elapsed % 60_000) / 1_000);
  return `Worked for ${minutes}m${seconds === 0 ? "" : ` ${seconds}s`}`;
}

function compactElapsedLabel(startedAt: string, completedAt: string): string {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "<1s";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.round((elapsed % 60_000) / 1_000);
  return `${minutes}m${seconds === 0 ? "" : ` ${seconds}s`}`;
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
  private readonly toolDiffs: ToolDiffProjectionCache;
  private showDetails = false;
  private entries: readonly TranscriptEntry[] = [];
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
    private readonly onToggleDetails: () => void,
    leading?: Renderable,
  ) {
    this.toolDiffs = new ToolDiffProjectionCache((toolCallId) => {
      this.repaintToolDiff(toolCallId);
    });
    if (leading !== undefined) this.content.add(leading);
    this.leadingCount = leading === undefined ? 0 : 1;
  }

  dispose(): void {
    this.toolDiffs.clear();
  }

  private readonly toggleOnClick = (event: { preventDefault(): void }) => {
    const selected = this.renderer.getSelection()?.getSelectedText() ?? "";
    if (selected !== "") return;
    event.preventDefault();
    this.onToggleDetails();
  };

  update(
    entries: readonly TranscriptEntry[],
    showDetails: boolean,
    changedStart = 0,
  ): void {
    const detailsChanged = this.showDetails !== showDetails;
    this.entries = entries;
    this.showDetails = showDetails;
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
    const first = detailsChanged
      ? 0
      : Math.max(
          0,
          Math.min(changedStart - this.windowStart, this.built.length),
        );
    const count = this.windowEnd - this.windowStart;
    for (let index = first; index < count; index += 1) {
      const entry = entries[this.windowStart + index];
      if (entry === undefined) continue;
      const existing = this.built[index];
      const detailSensitive =
        entry.kind === "thought" ||
        entry.kind === "tool" ||
        entry.kind === "diff";
      if (
        existing !== undefined &&
        existing.entry === entry &&
        !(detailsChanged && detailSensitive)
      ) {
        continue;
      }
      if (existing !== undefined && detailsChanged && detailSensitive) {
        this.replace(index, entry, existing.renderable);
        continue;
      }
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

  private repaintToolDiff(toolCallId: string): void {
    const index = this.built.findIndex(
      ({ entry }) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    const built = this.built[index];
    if (built === undefined) return;
    this.replace(index, built.entry, built.renderable);
    this.renderer.requestRender();
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
    if (entry.kind === "thought") return this.buildThought(entry);
    if (entry.kind === "diff") return this.buildTurnDiff(entry);
    if (entry.kind === "tool") {
      if (entry.absorbedByElicitation === true) {
        return new BoxRenderable(this.renderer, {
          width: 0,
          height: 0,
          visible: false,
        });
      }
      return this.buildTool(entry);
    }
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
      entry.kind === "diff" &&
      this.showDetails &&
      renderable instanceof DiffRenderable
    ) {
      renderable.diff = entry.diff;
      return;
    }
    if (
      entry.kind === "user" ||
      entry.kind === "thought" ||
      entry.kind === "tool" ||
      entry.kind === "diff" ||
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

  private buildDiff(
    diff: string,
    path: string | undefined,
    maxHeight?: number,
  ): DiffRenderable {
    const filetype = path === undefined ? undefined : filetypeFor(path);
    return new DiffRenderable(this.renderer, {
      width: "100%",
      maxWidth: TOOL_WIDTH,
      height: "auto",
      ...definedFields({ maxHeight }),
      marginLeft: 2,
      diff,
      view: "unified",
      syntaxStyle: this.syntaxStyle,
      addedSignColor: this.colors.green,
      removedSignColor: this.colors.red,
      lineNumberFg: this.colors.dim,
      ...definedFields({
        filetype,
        treeSitterClient: this.treeSitter ?? undefined,
      }),
    });
  }

  private buildClipNote(): TextRenderable {
    return new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      marginLeft: 2,
      content: "… diff clipped · ctrl+o for all of it",
      fg: this.colors.dim,
      truncate: true,
    });
  }

  private buildTurnDiff(
    entry: Extract<TranscriptEntry, { kind: "diff" }>,
  ): Renderable {
    if (this.showDetails) return this.buildDiff(entry.diff, undefined);
    const stats = unifiedDiffStats(entry.diff);
    const files = `${stats.files} file${stats.files === 1 ? "" : "s"}`;
    const box = new BoxRenderable(this.renderer, {
      width: "100%",
      maxWidth: TOOL_WIDTH,
      height: "auto",
      flexDirection: "column",
      marginLeft: 3,
      onMouseUp: this.toggleOnClick,
    });
    box.add(
      new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        content: `✓ Changes · ${files} · +${stats.added} −${stats.removed}`,
        fg: this.colors.dim,
        truncate: true,
      }),
    );
    box.add(this.buildDiff(entry.diff, undefined, COMPACT_DIFF_ROWS));
    if (entry.diff.split("\n").length > COMPACT_DIFF_ROWS) {
      box.add(this.buildClipNote());
    }
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

  private buildThought(
    entry: Extract<TranscriptEntry, { kind: "thought" }>,
  ): Renderable {
    const chunks: TextChunk[] = [];
    if (entry.completedAt === null) {
      const summary = entry.summary.text;
      chunks.push(fg(this.colors.teal)("◌ Thinking"));
      if (summary !== "") chunks.push(fg(this.colors.dim)(` · ${summary}`));
    } else {
      chunks.push(
        fg(this.colors.dim)(
          `✓ ${elapsedLabel(entry.startedAt, entry.completedAt)}`,
        ),
      );
      if (this.showDetails) {
        chunks.push(fg(this.colors.dim)(`\n${entry.text}`));
      }
    }
    const thought = new TextRenderable(this.renderer, {
      id: `agent-ui-thought-${entry.turnId}`,
      width: "100%",
      maxWidth: PROSE_WIDTH - 3,
      height: "auto",
      marginLeft: 3,
      marginTop: 1,
      wrapMode: "word",
      selectable: this.showDetails,
      onMouseUp: this.toggleOnClick,
    });
    thought.content = new StyledText(chunks);
    return thought;
  }

  private displayPath(path: string): string {
    if (!isAbsolute(path)) return path;
    const workspace = this.identity.workspacePath;
    if (workspace !== undefined) {
      const fromWorkspace = relative(workspace, path);
      if (fromWorkspace !== "" && !fromWorkspace.startsWith("..")) {
        return fromWorkspace;
      }
    }
    const normalized = path.replaceAll("\\", "/");
    for (const marker of [
      "/src/",
      "/test/",
      "/docs/",
      "/planning/",
      "/workspace/",
      "/native/",
    ]) {
      const index = normalized.lastIndexOf(marker);
      if (index !== -1) return normalized.slice(index + 1);
    }
    return normalized.split("/").filter(Boolean).slice(-3).join("/");
  }

  private toolSubject(
    entry: Extract<TranscriptEntry, { kind: "tool" }>,
  ): string | null {
    const paths = [
      ...entry.locations,
      ...entry.changes.map((change) => change.path),
    ];
    const first = paths[0];
    if (first !== undefined) {
      const extra = new Set(paths).size - 1;
      return `${this.displayPath(first)}${extra > 0 ? ` +${extra}` : ""}`;
    }
    return entry.presentation.detail?.text ?? null;
  }

  private compactToolResult(
    entry: Extract<TranscriptEntry, { kind: "tool" }>,
  ): string | null {
    const output = entry.presentation.output;
    if (output === null || output.nonEmptyLines === 0) return null;
    if (entry.toolKind === "read") {
      return `${output.nonEmptyLines} line${output.nonEmptyLines === 1 ? "" : "s"} read`;
    }
    if (entry.toolKind === "search") {
      return `${output.nonEmptyLines} result line${output.nonEmptyLines === 1 ? "" : "s"}`;
    }
    if (entry.toolKind === "edit" || entry.changes.length > 0) return null;
    return output.nonEmptyLines <= 8 && !output.lastLine.cellClipped
      ? output.lastLine.text
      : `${output.nonEmptyLines} lines of output`;
  }

  private buildTool(
    entry: Extract<TranscriptEntry, { kind: "tool" }>,
  ): Renderable {
    const diffState = this.toolDiffs.project(entry.toolCallId, entry.changes);
    const box = new BoxRenderable(this.renderer, {
      id: `agent-ui-tool-${entry.toolCallId}`,
      width: "100%",
      maxWidth: TOOL_WIDTH,
      height: "auto",
      flexDirection: "column",
      marginLeft: 3,
      onMouseUp: this.toggleOnClick,
    });
    const color =
      entry.status === "error"
        ? this.colors.red
        : entry.status === "ok"
          ? this.colors.green
          : this.colors.teal;
    const chunks: TextChunk[] = [];
    const mark =
      entry.status === "error" ? "✗" : entry.status === "ok" ? "✓" : "◌";
    const semanticLabel =
      entry.toolKind === null || entry.toolKind === "other"
        ? displayToolName(entry.toolName)
        : (TOOL_LABELS[entry.toolKind] ?? displayToolName(entry.toolName));
    const subject = this.toolSubject(entry);
    const repeatsLabel =
      subject?.toLowerCase().startsWith(`${semanticLabel.toLowerCase()} `) ===
      true;
    const label =
      (entry.toolKind === null || entry.toolKind === "other") && repeatsLabel
        ? (subject ?? semanticLabel)
        : semanticLabel;
    const displaySubject =
      label === subject
        ? null
        : repeatsLabel
          ? (subject?.slice(semanticLabel.length).trimStart() ?? null)
          : subject;
    chunks.push(bold(fg(color)(`${mark} `)));
    chunks.push(bold(fg(this.colors.text)(label)));
    if (displaySubject !== null) {
      chunks.push(fg(this.colors.blue)(`  ${displaySubject}`));
    }
    if (entry.changes.length > 0) {
      if (diffState.status === "ready") {
        const stats = diffState.projection.stats;
        chunks.push(
          fg(this.colors.dim)(`  · +${stats.added} −${stats.removed}`),
        );
      } else {
        chunks.push(
          fg(this.colors.dim)(
            diffState.status === "pending"
              ? "  · preparing diff"
              : "  · diff unavailable",
          ),
        );
      }
    }
    if (entry.status === "running") {
      chunks.push(fg(this.colors.dim)("  · running"));
    } else if (entry.completedAt !== null) {
      chunks.push(
        fg(this.colors.dim)(
          `  · ${compactElapsedLabel(entry.startedAt, entry.completedAt)}`,
        ),
      );
    }
    const compactResult = this.compactToolResult(entry);
    if (!this.showDetails && compactResult !== null) {
      chunks.push(fg(this.colors.dim)(`\n  ⎿ ${compactResult}`));
    }
    const header = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
      selectable: true,
    });
    header.content = new StyledText(chunks);
    box.add(header);
    if (this.showDetails) {
      if (entry.detail !== null && entry.detail !== subject) {
        const detail = new TextRenderable(this.renderer, {
          width: "100%",
          height: "auto",
          marginLeft: 2,
          content: entry.detail,
          fg: this.colors.dim,
          wrapMode: "word",
        });
        box.add(detail);
      }
      for (const change of diffState.status === "ready"
        ? diffState.projection.changes
        : []) {
        box.add(this.buildDiff(change.diff, change.path));
      }
      if (entry.presentation.output !== null) {
        box.add(
          this.buildCode(entry.presentation.output.head, entry.locations[0]),
        );
      }
    } else {
      // The edit itself shows without a toggle: watching the code change is what watching an agent work means. Only the raw payloads wait.
      for (const change of diffState.status === "ready"
        ? diffState.projection.changes
        : []) {
        box.add(this.buildDiff(change.diff, change.path, COMPACT_DIFF_ROWS));
        if (change.rows > COMPACT_DIFF_ROWS) {
          box.add(this.buildClipNote());
        }
      }
      if (entry.status === "error" && entry.presentation.output !== null) {
        box.add(
          this.buildCode(entry.presentation.output.tail, entry.locations[0]),
        );
      }
    }
    return box;
  }

  /** Tool output, highlighted as the file it came from when the call named one. The reducer has already capped long output so drawing a whole file cannot push the reply that explains it off the screen. */
  private buildCode(content: string, path: string | undefined): CodeRenderable {
    const filetype = path === undefined ? undefined : filetypeFor(path);
    return new CodeRenderable(this.renderer, {
      width: "100%",
      maxWidth: TOOL_WIDTH - 2,
      height: "auto",
      marginLeft: 2,
      content,
      syntaxStyle: this.syntaxStyle,
      onChunks: detectLinks,
      ...definedFields({
        filetype,
        treeSitterClient: this.treeSitter ?? undefined,
      }),
    });
  }

  /** An elicitation card: a titled, bordered block that reads as one thing needing an answer rather than as more transcript. A pending ask is the only thing on screen the person must act on, so it is the only thing given a full border and an accent colour. Once settled it drops to a quiet grey rule — still readable as a record of what was asked and answered, but no longer competing with whatever is live. */
  private buildElicitation(
    entry: Extract<TranscriptEntry, { kind: "elicitation" }>,
  ): Renderable {
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
    box.add(this.buildElicitationBody(entry, accent));
    if (!entry.settled) {
      const options = pickerOptions(entry);
      if (options.length > 0) {
        box.add(this.buildOptions(entry, options));
      } else if (currentQuestion(entry)?.allowCustom === true) {
        box.add(
          this.buildCustomAnswerHint(currentQuestion(entry)?.secret === true),
        );
      }
    }
    return box;
  }

  private buildCustomAnswerHint(secret: boolean): TextRenderable {
    const hint = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
    });
    hint.content = new StyledText([
      italic(
        fg(this.colors.dim)(
          secret
            ? "  type a private answer (input masked) · enter submit\n"
            : "  type an answer · enter submit\n",
        ),
      ),
    ]);
    return hint;
  }

  private cardTitle(
    entry: Extract<TranscriptEntry, { kind: "elicitation" }>,
  ): string {
    if (entry.ask === "approval") return " APPROVAL ";
    const question = currentQuestion(entry);
    if (question === null || entry.questions.length <= 1) return " QUESTION ";
    return ` QUESTION ${entry.questionIndex + 1}/${entry.questions.length} `;
  }

  private buildElicitationBody(
    entry: Extract<TranscriptEntry, { kind: "elicitation" }>,
    accent: string,
  ): TextRenderable {
    const chunks: TextChunk[] = [];
    const question = currentQuestion(entry);
    if (entry.settled) {
      chunks.push(fg(this.colors.gray)("✓ "));
      chunks.push(fg(this.colors.gray)(`${entry.summary}\n`));
    } else {
      for (const answered of entry.questions.slice(0, entry.questionIndex)) {
        const chosen = entry.chosen[answered.questionId] ?? [];
        chunks.push(fg(this.colors.green)("  ✓ "));
        chunks.push(
          fg(this.colors.dim)(`${answered.header ?? answered.text}: `),
        );
        chunks.push(
          fg(this.colors.text)(
            `${answered.secret ? "••••••" : chosen.join(", ")}\n`,
          ),
        );
      }
      if (entry.ask === "approval") {
        chunks.push(fg(this.colors.dim)(`${entry.summary}\n`));
        if (entry.detail !== null) {
          chunks.push(bold(fg(this.colors.text)(`${entry.detail}\n`)));
        }
      } else {
        const heading = question?.header ?? null;
        if (heading !== null) {
          chunks.push(bold(fg(accent)(`${heading.toUpperCase()}\n`)));
        }
        chunks.push(
          bold(
            fg(this.colors.text)(
              `${question?.text ?? entry.detail ?? entry.summary}\n\n`,
            ),
          ),
        );
      }
    }
    const text = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
      selectable: true,
    });
    text.content = new StyledText(chunks);
    return text;
  }

  /** The option rows, drawn as text rather than a focusable Select. The composer keeps focus the whole time a question is up, so a person can still type instead of choosing, and OpenTUI delivers arrow keys to the focused renderable. Owning the highlight here keeps one component reading the keyboard rather than two negotiating over it. */
  private buildOptions(
    entry: Extract<TranscriptEntry, { kind: "elicitation" }>,
    options: readonly ElicitationOption[],
  ): Renderable {
    const question = currentQuestion(entry);
    const multi = question?.multiSelect === true;
    const picked = new Set(
      question === null ? [] : (entry.chosen[question.questionId] ?? []),
    );
    const chunks: TextChunk[] = [];
    const escapeAction = options.some((option) => option.kind === "reject")
      ? "esc reject"
      : "esc interrupt";
    for (const [index, option] of options.entries()) {
      const focused = index === entry.selection;
      const on = picked.has(option.optionId);
      const marker = multi ? (on ? "▣" : "☐") : on ? "◉" : "○";
      const row = `${focused ? "❯" : " "} ${marker} ${index + 1}. ${option.name}`;
      chunks.push(
        focused
          ? bold(bg(this.colors.headerAlt)(fg(this.colors.green)(`${row}\n`)))
          : fg(on ? this.colors.green : this.colors.text)(`${row}\n`),
      );
      const description = option.description ?? null;
      if (description !== null && description !== "") {
        chunks.push(fg(this.colors.dim)(`      ${description}\n`));
      }
    }
    chunks.push(fg(this.colors.dim)("\n"));
    chunks.push(
      italic(
        fg(this.colors.dim)(
          multi
            ? `${question?.allowCustom === true ? "  type a custom answer · " : "  "}space toggle · enter confirm · 1-9 pick · ↑↓ move · ${escapeAction}\n`
            : `${question?.allowCustom === true ? "  type a custom answer · " : "  "}↑↓ move · enter choose · 1-9 pick · ${escapeAction}\n`,
        ),
      ),
    );
    const list = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      wrapMode: "word",
    });
    list.content = new StyledText(chunks);
    return list;
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
      case "plan":
        line(chunks, "Plan", this.colors.teal, true);
        for (const step of entry.entries) {
          line(chunks, `  ○ ${step}`, this.colors.text);
        }
        break;
      case "mail":
        line(
          chunks,
          `↳ Mail · ${entry.lane} · ${entry.summary}`,
          this.colors.dim,
        );
        break;
      default:
        line(chunks, "", this.colors.text);
        break;
    }
    return new StyledText(chunks);
  }
}
