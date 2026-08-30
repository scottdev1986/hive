import { bold, fg, StyledText, type TextChunk } from "@opentui/core";
import { displayToolName, TOOL_LABELS } from "./events-format";
import { formatContextPercent } from "../../usage-service/context-occupancy";
import { clipTerminalText } from "./terminal-clip";
import type {
  AttentionLevel,
  CommandMenuEntry,
  MentionEntry,
  ModelPickerState,
  ModePickerState,
  ViewState,
} from "./view-state";
import { filteredModels } from "./view-state";

export interface PaneIdentity {
  readonly agentName: string;
  readonly vendorName: string;
  readonly vendorId: string;
  readonly model: string;
  readonly effort?: string;
  readonly workspacePath?: string;
  readonly absences?: {
    readonly contextUsage?: { readonly reason: string };
  };
}

/** Foreground accents only. The pane paints no background of its own: it sits on the terminal's background like any native CLI, so the user's theme shows through. `headerAlt` is the one exception — a subtle fill for the focused option row, where a highlight is semantic rather than decorative. */
export const COLORS = {
  green: "#7ed385",
  yellow: "#e8c160",
  orange: "#e89654",
  blue: "#6ea8fe",
  purple: "#b294fa",
  red: "#eb6e6e",
  gray: "#8a919e",
  teal: "#6ecdc6",
  text: "#dee2ea",
  dim: "#7a818e",
  headerAlt: "#191d27",
  headerEdge: "#303746",
} as const;

const ATTENTION_COLOR = {
  none: COLORS.gray,
  info: COLORS.blue,
  approval: COLORS.orange,
  failure: COLORS.red,
} satisfies Record<AttentionLevel, string>;

const TURN_LABEL = {
  unknown: "—",
  idle: "Idle",
  queued: "Queued",
  submitting: "Sending",
  working: "Working",
  awaiting_approval: "Approval needed",
  awaiting_answer: "Answer needed",
  cancelling: "Stopping",
  done: "Done",
  failed: "Failed",
} satisfies Record<ViewState["turn"], string>;

function foregroundLabel(view: ViewState): string {
  switch (view.foregroundOperation?.status) {
    case "queued":
      return "Compaction queued";
    case "starting":
      return "Starting compaction";
    case "running":
      return "Compacting";
    case undefined:
      return TURN_LABEL[view.turn];
  }
}

const RUNTIME_LABEL = {
  starting: "connecting",
  connecting: "connecting",
  ready: "connected",
  degraded: "degraded",
  disconnected: "disconnected",
  exited: "exited",
} satisfies Record<ViewState["runtime"], string>;

const RUNTIME_COLOR = {
  starting: COLORS.blue,
  connecting: COLORS.blue,
  ready: COLORS.green,
  degraded: COLORS.yellow,
  disconnected: COLORS.red,
  exited: COLORS.red,
} satisfies Record<ViewState["runtime"], string>;

const MAIL_LABEL = {
  none: "—",
  waiting: "waiting",
  waking: "waking",
  retrying: "retrying",
} satisfies Record<ViewState["mail"], string>;

interface VendorBrand {
  readonly mark: string;
  readonly accent: string;
}

interface VendorBrandTable {
  readonly [vendorId: string]: VendorBrand | undefined;
}

const VENDOR_BRAND: VendorBrandTable = {
  claude: { mark: "✻", accent: "#d97757" },
  codex: { mark: "◎", accent: "#74aa9c" },
  grok: { mark: "𝕏", accent: "#f2f2f2" },
  kimi: { mark: "K", accent: "#1783ff" },
  opencode: { mark: "▣", accent: "#e8e2dc" },
};

const COMMAND_DESCRIPTION_GAP = "         ";
const COMMAND_MENU_ROWS = 8;
export const MODEL_PICKER_ROWS = 10;
const MODEL_PICKER_ITEMS = 4;
export const MODE_PICKER_ROWS = 8;

function contextLabel(view: ViewState, identity: PaneIdentity): string {
  if (view.contextPercent !== null) {
    return `context ${formatContextPercent(view.contextPercent)}`;
  }
  return identity.absences?.contextUsage?.reason ?? "context —";
}

export function vendorBrand(identity: PaneIdentity): VendorBrand {
  return VENDOR_BRAND[identity.vendorId] ?? { mark: "◆", accent: COLORS.teal };
}

export function modelLabel(
  view: ViewState,
  identity: PaneIdentity,
  separator = " · ",
): string {
  const model = view.liveModel ?? identity.model;
  const effort = view.liveEffort ?? identity.effort;
  return effort === undefined || effort === null
    ? model
    : `${model}${separator}${effort}`;
}

export function defaultComposerPlaceholder(identity: PaneIdentity): string {
  return `Ask ${identity.vendorName}…`;
}

export function agentHeaderText(
  view: ViewState,
  identity: PaneIdentity,
): string {
  const brand = vendorBrand(identity);
  return [
    `${brand.mark} ${identity.agentName} · ${modelLabel(view, identity)}`,
    `${foregroundLabel(view)} · ${RUNTIME_LABEL[view.runtime]} · ${contextLabel(view, identity)} · mail ${MAIL_LABEL[view.mail]}`,
  ].join("\n");
}

export const SPINNER_FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"] as const;
export const ACTIVE_TURNS: ReadonlySet<ViewState["turn"]> = new Set([
  "submitting",
  "working",
  "cancelling",
]);

export function foregroundIsActive(view: ViewState): boolean {
  return (
    view.foregroundOperation?.status === "starting" ||
    view.foregroundOperation?.status === "running" ||
    ACTIVE_TURNS.has(view.turn)
  );
}

export function bannerContent(
  view: ViewState,
  identity: PaneIdentity,
): StyledText {
  const brand = vendorBrand(identity);
  const chunks: TextChunk[] = [
    bold(fg(brand.accent)(`${brand.mark} `)),
    bold(fg(COLORS.text)(identity.vendorName)),
    fg(COLORS.headerEdge)(" · "),
    fg(COLORS.dim)(identity.agentName),
    fg(COLORS.headerEdge)(" · "),
    fg(COLORS.teal)(modelLabel(view, identity)),
  ];
  if (identity.workspacePath !== undefined) {
    chunks.push(fg(COLORS.dim)(`\n  ${identity.workspacePath}`));
  }
  return new StyledText(chunks);
}

export function footerStatusContent(
  view: ViewState,
  identity: PaneIdentity,
  spinnerTick: number,
  elapsedSeconds: number,
): StyledText {
  const brand = vendorBrand(identity);
  const label =
    view.turn === "unknown"
      ? view.runtime === "ready"
        ? "Ready"
        : RUNTIME_LABEL[view.runtime]
      : foregroundLabel(view);
  const turnLabel = foregroundIsActive(view)
    ? `${SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length] ?? "·"} ${label}… ${elapsedSeconds}s`
    : label;
  const chunks: TextChunk[] = [
    bold(fg(brand.accent)(`${brand.mark} `)),
    bold(fg(ATTENTION_COLOR[view.attention])(turnLabel)),
    fg(COLORS.headerEdge)(" · "),
    fg(COLORS.dim)(contextLabel(view, identity)),
  ];
  if (view.runtime !== "ready" && view.turn !== "unknown") {
    chunks.push(fg(COLORS.headerEdge)(" · "));
    chunks.push(fg(RUNTIME_COLOR[view.runtime])(RUNTIME_LABEL[view.runtime]));
  }
  if (view.mail !== "none") {
    chunks.push(fg(COLORS.headerEdge)(" · "));
    chunks.push(fg(COLORS.blue)(`mail ${MAIL_LABEL[view.mail]}`));
  }
  if (view.permissionMode !== null && view.permissionMode !== "default") {
    chunks.push(fg(COLORS.headerEdge)(" · "));
    chunks.push(fg(COLORS.yellow)(`mode ${view.permissionMode}`));
  }
  return new StyledText(chunks);
}

/** What the agent is doing right now, as one line that rewrites itself: the running tool or thought, or a mail wake being taken up. Empty when nothing is in flight, so an idle pane shows nothing rather than a stale step. The transcript no longer carries these, so this line is where a long tool call proves the agent is not stuck. */
export function liveLineContent(
  view: ViewState,
  spinnerTick: number,
  nowMs: number,
): StyledText | null {
  const spinner = SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length] ?? "·";
  const transcript = view.transcript;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry === undefined) continue;
    if (entry.kind === "user" || entry.kind === "elicitation") break;
    if (entry.kind === "tool" && entry.status === "running") {
      const label =
        entry.toolKind === null || entry.toolKind === "other"
          ? displayToolName(entry.toolName)
          : (TOOL_LABELS[entry.toolKind] ?? displayToolName(entry.toolName));
      const subject =
        entry.locations[0]?.split("/").filter(Boolean).slice(-3).join("/") ??
        entry.presentation.detail?.text ??
        null;
      return new StyledText([
        bold(fg(COLORS.teal)(`${spinner} `)),
        bold(fg(COLORS.text)(label)),
        fg(COLORS.blue)(subject === null ? "" : `  ${subject}`),
        fg(COLORS.dim)(`  · ${elapsedSince(entry.startedAt, nowMs)}`),
      ]);
    }
    if (entry.kind === "thought" && entry.completedAt === null) {
      return new StyledText([
        bold(fg(COLORS.teal)(`${spinner} `)),
        bold(fg(COLORS.text)("Thinking")),
        fg(COLORS.dim)(
          `${entry.summary.text === "" ? "" : `  ${entry.summary.text}`}  · ${elapsedSince(entry.startedAt, nowMs)}`,
        ),
      ]);
    }
    if (entry.kind === "tool" || entry.kind === "thought") break;
  }
  if (
    view.mail === "waiting" ||
    view.mail === "waking" ||
    view.mail === "retrying"
  ) {
    return new StyledText([
      bold(fg(COLORS.blue)("↳ ")),
      bold(fg(COLORS.text)("Mail")),
      fg(COLORS.dim)(`  · ${MAIL_LABEL[view.mail]}`),
    ]);
  }
  return null;
}

function elapsedSince(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "running";
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The footer's right half keeps the three discoverability affordances that are useful on every turn. The armed Ctrl+C warning temporarily replaces them because it is state feedback, not signage. */
export function footerHintsContent(ctrlCArmed: boolean): StyledText {
  if (ctrlCArmed) {
    return new StyledText([bold(fg(COLORS.orange)("ctrl+c again to exit"))]);
  }
  return new StyledText([
    fg(COLORS.dim)("/ commands · @ files · ctrl+o events"),
  ]);
}

function line(
  chunks: TextChunk[],
  text: string,
  color: string = COLORS.text,
  emphasis = false,
): void {
  const colored = fg(color)(`${text}\n`);
  chunks.push(emphasis ? bold(colored) : colored);
}

export function queueSummaryLine(pendingWake: number): string {
  return pendingWake > 0
    ? `mail ready: ${pendingWake} wake${pendingWake === 1 ? "" : "s"} waiting for the turn to end`
    : "";
}

export function visibleCommandEntries(
  entries: readonly CommandMenuEntry[],
): readonly CommandMenuEntry[] {
  if (entries.length <= COMMAND_MENU_ROWS) return entries;
  const selected = Math.max(
    0,
    entries.findIndex((entry) => entry.selected),
  );
  const start = Math.max(
    0,
    Math.min(
      selected - Math.floor(COMMAND_MENU_ROWS / 2),
      entries.length - COMMAND_MENU_ROWS,
    ),
  );
  return entries.slice(start, start + COMMAND_MENU_ROWS);
}

export function modelPickerContent(picker: ModelPickerState): StyledText {
  const chunks: TextChunk[] = [];
  if (picker.stage === "effort" && picker.effortModel !== null) {
    const efforts = picker.effortModel.supportedReasoningEfforts;
    line(
      chunks,
      `Select reasoning effort · ${picker.effortModel.displayName} · ${picker.selection + 1}/${efforts.length}`,
      COLORS.text,
      true,
    );
    line(
      chunks,
      picker.applying ? "Switching model…" : "Enter apply · ↑↓ move · Esc back",
      picker.applying ? COLORS.green : COLORS.dim,
    );
    const start = pickerWindowStart(
      picker.selection,
      efforts.length,
      MODEL_PICKER_ITEMS,
    );
    for (const [offset, effort] of efforts
      .slice(start, start + MODEL_PICKER_ITEMS)
      .entries()) {
      const index = start + offset;
      const selected = index === picker.selection;
      const tags = [
        effort.id === picker.currentEffort &&
        picker.effortModel.id === picker.current
          ? "current"
          : null,
        effort.id === picker.effortModel.defaultReasoningEffort
          ? "default"
          : null,
      ].filter(Boolean);
      line(
        chunks,
        `${selected ? "›" : " "} ${effort.id}${tags.length === 0 ? "" : `  ${tags.join(" · ")}`}`,
        selected ? COLORS.green : COLORS.text,
        selected,
      );
      line(
        chunks,
        `    ${pickerDetail(effort.description ?? "Provider reasoning level")}`,
        COLORS.dim,
      );
    }
    return new StyledText(chunks);
  }

  const models = filteredModels(picker);
  const position = models.length === 0 ? 0 : picker.selection + 1;
  line(
    chunks,
    `Select model · ${position}/${models.length}`,
    COLORS.text,
    true,
  );
  line(
    chunks,
    picker.applying
      ? "Switching model…"
      : picker.query === ""
        ? "Type to filter · ↑↓ move · Enter select · Esc close"
        : `Search: ${picker.query} · Enter select · Esc clear`,
    picker.applying ? COLORS.green : COLORS.dim,
  );
  if (models.length === 0) {
    line(chunks, "  No models match that search", COLORS.yellow);
    return new StyledText(chunks);
  }
  const start = Math.max(
    0,
    Math.min(
      picker.selection - Math.floor(MODEL_PICKER_ITEMS / 2),
      models.length - MODEL_PICKER_ITEMS,
    ),
  );
  for (const [offset, model] of models
    .slice(start, start + MODEL_PICKER_ITEMS)
    .entries()) {
    const selected = start + offset === picker.selection;
    const tags = [
      model.id === picker.current ? "current" : null,
      model.isDefault ? "default" : null,
    ].filter(Boolean);
    line(
      chunks,
      `${selected ? "›" : " "} ${model.displayName}${tags.length === 0 ? "" : `  ${tags.join(" · ")}`}`,
      selected ? COLORS.green : COLORS.text,
      selected,
    );
    const identity = model.displayName === model.id ? "" : `${model.id} · `;
    const effort =
      model.supportedReasoningEfforts.length === 0
        ? ""
        : ` · ${model.supportedReasoningEfforts.length} effort levels`;
    line(
      chunks,
      `    ${pickerDetail(`${identity}${model.description ?? "Provider model"}${effort}`)}`,
      COLORS.dim,
    );
  }
  return new StyledText(chunks);
}

export function modelPickerHeight(picker: ModelPickerState): number {
  const count =
    picker.stage === "effort"
      ? (picker.effortModel?.supportedReasoningEfforts.length ?? 0)
      : filteredModels(picker).length;
  return Math.min(MODEL_PICKER_ROWS, 2 + Math.max(1, Math.min(count, 4)) * 2);
}

interface ModeDescriptionTable {
  readonly [mode: string]: string | undefined;
}

const MODE_DESCRIPTION: ModeDescriptionTable = {
  default: "Ask before protected actions",
  acceptEdits: "Approve file edits automatically",
  auto: "Let the agent decide without asking",
  dontAsk: "Do not prompt; refuse actions that need approval",
  plan: "Plan and inspect without making changes",
  bypassPermissions: "Bypass permission checks when launch policy allows",
  yolo: "Approve tool actions; questions can still be asked",
};

export function modePickerContent(picker: ModePickerState): StyledText {
  const chunks: TextChunk[] = [];
  line(chunks, "Select mode", COLORS.text, true);
  line(
    chunks,
    picker.applying ? "Switching mode…" : "Enter apply · ↑↓ move · Esc close",
    picker.applying ? COLORS.green : COLORS.dim,
  );
  const start = pickerWindowStart(picker.selection, picker.modes.length, 6);
  for (const [offset, mode] of picker.modes.slice(start, start + 6).entries()) {
    const selected = start + offset === picker.selection;
    const current = mode === picker.current ? "  current" : "";
    const description = MODE_DESCRIPTION[mode];
    line(
      chunks,
      `${selected ? "›" : " "} ${mode}${current}${description === undefined ? "" : ` · ${description}`}`,
      selected ? COLORS.green : COLORS.text,
      selected,
    );
  }
  return new StyledText(chunks);
}

export function modePickerHeight(picker: ModePickerState): number {
  return Math.min(MODE_PICKER_ROWS, 2 + Math.max(1, picker.modes.length));
}

function pickerWindowStart(
  selection: number,
  count: number,
  visible: number,
): number {
  return Math.max(
    0,
    Math.min(selection - Math.floor(visible / 2), count - visible),
  );
}

function pickerDetail(value: string): string {
  return clipTerminalText(value, { maxCells: 88, inline: true }).text;
}

export function mentionMenuContent(
  entries: readonly MentionEntry[],
): StyledText {
  const chunks: TextChunk[] = [];
  for (const entry of entries) {
    line(
      chunks,
      `${entry.selected ? "›" : " "} @${entry.path}`,
      entry.selected ? COLORS.green : COLORS.dim,
      entry.selected,
    );
  }
  return new StyledText(chunks);
}

export function commandMenuContent(
  entries: readonly CommandMenuEntry[],
): StyledText {
  const chunks: TextChunk[] = [];
  for (const entry of visibleCommandEntries(entries)) {
    const description = entry.menuDescription;
    const text =
      description === null
        ? entry.menuColumn
        : `${entry.menuColumn}${COMMAND_DESCRIPTION_GAP}${description}`;
    line(
      chunks,
      `${entry.selected ? "›" : " "} ${text}`,
      entry.selected ? COLORS.green : COLORS.dim,
      entry.selected,
    );
  }
  return new StyledText(chunks);
}
