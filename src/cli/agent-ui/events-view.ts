import {
  bold,
  type CliRenderer,
  fg,
  type ScrollBoxRenderable,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import type { TranscriptColors } from "./transcript-view";
import { unifiedDiffStats } from "./unified-diff";
import {
  clockLabel,
  compactElapsedLabel,
  displayToolName,
  TOOL_LABELS,
} from "./events-format";
import type { TranscriptEntry } from "./view-state";

/** One line of the events view. Rows are derived, never stored: the transcript buffer is the record and this is a reading of it. */
export interface EventRow {
  readonly kind: "header" | "event";
  readonly at: string;
  readonly mark: string;
  readonly tone: "ok" | "error" | "running" | "mail" | "status" | "dim";
  readonly label: string;
  readonly subject: string | null;
  readonly detail: string | null;
}

/** The newest rows the overlay draws; older ones are counted in a note. Chat paging is not reused here because the overlay is a lookup surface, not a place to read history end to end. */
const EVENT_WINDOW_ROWS = 400;

function toolSubject(entry: Extract<TranscriptEntry, { kind: "tool" }>) {
  const path = entry.locations[0] ?? entry.changes[0]?.path;
  if (path !== undefined) {
    const shown = path.split("/").filter(Boolean).slice(-3).join("/");
    const extra =
      new Set([...entry.locations, ...entry.changes.map((c) => c.path)]).size -
      1;
    return extra > 0 ? `${shown} +${extra}` : shown;
  }
  return entry.presentation.detail?.text ?? null;
}

function toolRow(entry: Extract<TranscriptEntry, { kind: "tool" }>): EventRow {
  const label =
    entry.toolKind === null || entry.toolKind === "other"
      ? displayToolName(entry.toolName)
      : (TOOL_LABELS[entry.toolKind] ?? displayToolName(entry.toolName));
  const parts: string[] = [];
  if (entry.changes.length > 0) {
    parts.push(
      `${entry.changes.length} file${entry.changes.length === 1 ? "" : "s"}`,
    );
  }
  if (entry.status === "running") parts.push("running");
  else if (entry.completedAt !== null) {
    parts.push(compactElapsedLabel(entry.startedAt, entry.completedAt));
  }
  if (entry.status === "error" && entry.presentation.output !== null) {
    parts.push(entry.presentation.output.lastLine.text);
  }
  return {
    kind: "event",
    at: entry.startedAt,
    mark: entry.status === "error" ? "✗" : entry.status === "ok" ? "✓" : "◌",
    tone:
      entry.status === "error"
        ? "error"
        : entry.status === "ok"
          ? "ok"
          : "running",
    label,
    subject: toolSubject(entry),
    detail: parts.length === 0 ? null : parts.join(" · "),
  };
}

function entryRow(entry: TranscriptEntry): EventRow | null {
  switch (entry.kind) {
    case "tool":
      return toolRow(entry);
    case "thought":
      return entry.completedAt === null
        ? {
            kind: "event",
            at: entry.startedAt,
            mark: "◌",
            tone: "running",
            label: "Thinking",
            subject: entry.summary.text === "" ? null : entry.summary.text,
            detail: "running",
          }
        : {
            kind: "event",
            at: entry.startedAt,
            mark: "✓",
            tone: "dim",
            label: "Thought",
            subject: entry.summary.text === "" ? null : entry.summary.text,
            detail: compactElapsedLabel(entry.startedAt, entry.completedAt),
          };
    case "mail":
      return {
        kind: "event",
        at: entry.at,
        mark: "↳",
        tone: "mail",
        label: "Mail ready",
        subject: entry.lane,
        detail: entry.summary,
      };
    case "message":
      return {
        kind: "event",
        at: entry.at,
        mark: entry.direction === "in" ? "↓" : "↑",
        tone: "mail",
        label: entry.direction === "in" ? "Mail in" : "Mail out",
        subject: entry.peer,
        detail: `${entry.lane}${entry.topic === null ? "" : ` · ${entry.topic}`} · shown in chat`,
      };
    case "plan":
      return {
        kind: "event",
        at: entry.at,
        mark: "◆",
        tone: "status",
        label: "Plan",
        subject: null,
        detail: `${entry.entries.length} step${entry.entries.length === 1 ? "" : "s"}`,
      };
    case "diff": {
      const stats = unifiedDiffStats(entry.diff);
      return {
        kind: "event",
        at: entry.at,
        mark: "◆",
        tone: "status",
        label: "Changes",
        subject: `${stats.files} file${stats.files === 1 ? "" : "s"}`,
        detail: `+${stats.added} −${stats.removed}`,
      };
    }
    case "compaction":
      return {
        kind: "event",
        at: entry.completedAt ?? entry.requestedAt,
        mark: "◆",
        tone: entry.status === "error" ? "error" : "status",
        label: "Compaction",
        subject: entry.status,
        detail: entry.detail,
      };
    case "elicitation":
      return {
        kind: "event",
        at: "",
        mark: "◆",
        tone: "status",
        label: entry.ask === "approval" ? "Approval" : "Question",
        subject: entry.summary,
        detail: entry.settled
          ? `${entry.outcome ?? "answered"} · shown in chat`
          : "waiting · shown in chat",
      };
    case "user":
    case "agent":
    case "diagnostic":
      return null;
  }
}

/** Every non-conversation entry as a row, grouped under a header per turn that says whether a person or a mail wake started it. */
export function eventRows(
  entries: readonly TranscriptEntry[],
  wakeTurnIds: ReadonlySet<string>,
): EventRow[] {
  const rows: EventRow[] = [];
  const turnNumbers = new Map<string, number>();
  let currentTurn: string | null = null;
  for (const entry of entries) {
    const row = entryRow(entry);
    if (row === null) continue;
    const turnId = "turnId" in entry ? entry.turnId : null;
    if (turnId !== null && turnId !== currentTurn) {
      currentTurn = turnId;
      let number = turnNumbers.get(turnId);
      if (number === undefined) {
        number = turnNumbers.size + 1;
        turnNumbers.set(turnId, number);
      }
      rows.push({
        kind: "header",
        at: row.at,
        mark: "",
        tone: wakeTurnIds.has(turnId) ? "mail" : "dim",
        label: `turn ${number} · ${wakeTurnIds.has(turnId) ? "wake" : "user"}`,
        subject: null,
        detail: null,
      });
    }
    rows.push(row);
  }
  return rows;
}

export class EventsView {
  private built: TextRenderable[] = [];
  private readonly title: TextRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly content: ScrollBoxRenderable,
    private readonly colors: TranscriptColors,
  ) {
    this.title = new TextRenderable(renderer, {
      id: "agent-ui-events-title",
      width: "100%",
      height: 1,
      truncate: true,
    });
    this.content.add(this.title);
  }

  update(
    entries: readonly TranscriptEntry[],
    wakeTurnIds: ReadonlySet<string>,
  ): void {
    const rows = eventRows(entries, wakeTurnIds);
    const shown = rows.slice(-EVENT_WINDOW_ROWS);
    const hidden = rows.length - shown.length;
    this.title.content = new StyledText([
      bold(fg(this.colors.text)("EVENTS")),
      fg(this.colors.dim)(
        ` · ${rows.length} row${rows.length === 1 ? "" : "s"}${hidden > 0 ? ` · ${hidden} earlier not shown` : ""} · ctrl+o or esc to close`,
      ),
    ]);
    for (const old of this.built) {
      this.content.remove(old);
      old.destroyRecursively();
    }
    this.built = shown.map((row) => {
      const text = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        truncate: true,
        selectable: true,
      });
      text.content = this.rowContent(row);
      this.content.add(text);
      return text;
    });
  }

  private tone(tone: EventRow["tone"]): string {
    switch (tone) {
      case "ok":
        return this.colors.green;
      case "error":
        return this.colors.red;
      case "running":
        return this.colors.teal;
      case "mail":
        return this.colors.blue;
      case "status":
        return this.colors.purple;
      case "dim":
        return this.colors.dim;
    }
  }

  private rowContent(row: EventRow): StyledText {
    if (row.kind === "header") {
      return new StyledText([
        fg(this.tone(row.tone))(`── ${row.label}`),
        fg(this.colors.dim)(row.at === "" ? "" : ` · ${clockLabel(row.at)}`),
      ]);
    }
    const chunks: TextChunk[] = [
      fg(this.colors.dim)(row.at === "" ? "        " : clockLabel(row.at)),
      bold(fg(this.tone(row.tone))(`  ${row.mark} `)),
      bold(fg(this.colors.text)(row.label)),
    ];
    if (row.subject !== null)
      chunks.push(fg(this.colors.blue)(`  ${row.subject}`));
    if (row.detail !== null)
      chunks.push(fg(this.colors.dim)(`  · ${row.detail}`));
    return new StyledText(chunks);
  }
}
