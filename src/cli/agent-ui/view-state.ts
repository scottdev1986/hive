import type {
  ElicitationOption,
  ElicitationQuestion,
  NormalizedProviderEvent,
  ProviderModel,
  ToolFileChange,
  ToolKind,
  VendorCommand,
} from "../../adapters/providers/protocol/types";
import { statusProjectionForProviderEvent } from "../../daemon/status-service/status-service";
import { definedFields } from "../../shared/defined-fields";
import type { MailLane } from "../../schemas/mail";
import { clipTerminalText, type TerminalTextClip } from "./terminal-clip";
import { sameToolFileChanges } from "./unified-diff";

const COMMAND_COLUMN_CELLS = 24;
const THOUGHT_SUMMARY_CELLS = 92;
const TOOL_DETAIL_CELLS = 88;
const TOOL_RESULT_CELLS = 96;
const TOOL_OUTPUT_HEAD_LINES = 40;
const TOOL_OUTPUT_TAIL_LINES = 12;

interface ToolOutputPresentation {
  readonly head: string;
  readonly tail: string;
  readonly lastLine: TerminalTextClip;
  readonly nonEmptyLines: number;
}

interface ToolPresentation {
  readonly detail: TerminalTextClip | null;
  readonly output: ToolOutputPresentation | null;
}

interface ViewCommand extends VendorCommand {
  readonly menuColumn: string;
  readonly menuDescription: string | null;
}

export type RuntimePhase =
  "starting" | "connecting" | "ready" | "degraded" | "disconnected" | "exited";

export type TurnPhase =
  | "unknown"
  | "idle"
  | "queued"
  | "submitting"
  | "working"
  | "awaiting_approval"
  | "awaiting_answer"
  | "cancelling"
  | "done"
  | "failed";

export type MailPhase = "none" | "waiting" | "waking" | "retrying";

export type AttentionLevel = "none" | "info" | "approval" | "failure";

export type HumanDelivery =
  "queued" | "submitting" | "accepted" | "rejected" | "unknown";

type ActiveCompactionStatus = "queued" | "starting" | "running";
type SettledCompactionStatus =
  "ok" | "error" | "unknown" | "cancelled" | "unavailable";

interface CompactionBase {
  readonly kind: "compaction";
  readonly invocationId: string;
  readonly command: string;
  readonly requestedAt: string;
  readonly contextBefore: number | null;
  readonly clientInputId: string | null;
  readonly providerTurnId: string | null;
}

export interface ActiveCompaction extends CompactionBase {
  readonly status: ActiveCompactionStatus;
  readonly completedAt: null;
  readonly contextAfter: null;
  readonly completionEvidence: null;
  readonly detail: null;
}

export interface SettledCompaction extends CompactionBase {
  readonly status: SettledCompactionStatus;
  readonly completedAt: string;
  readonly contextAfter: number | null;
  readonly completionEvidence: "provider" | "command" | null;
  readonly detail: string | null;
}

export type CompactionEntry = ActiveCompaction | SettledCompaction;

export type TranscriptEntry =
  | {
      readonly kind: "user";
      readonly clientInputId: string;
      readonly text: string;
      readonly delivery: HumanDelivery;
    }
  | CompactionEntry
  | {
      readonly kind: "agent";
      readonly turnId: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "thought";
      readonly turnId: string;
      readonly text: string;
      readonly summary: TerminalTextClip;
      readonly startedAt: string;
      readonly completedAt: string | null;
    }
  | {
      readonly kind: "diagnostic";
      readonly message: string;
      readonly severity?: "warning" | "error";
    }
  | {
      readonly kind: "tool";
      readonly turnId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly detail: string | null;
      readonly status: "running" | "ok" | "error";
      readonly toolKind: ToolKind | null;
      readonly locations: readonly string[];
      readonly changes: readonly ToolFileChange[];
      readonly output: string | null;
      readonly presentation: ToolPresentation;
      readonly startedAt: string;
      readonly completedAt: string | null;
      /** The question card is the interactive presentation for question tools; their ordinary running row would repeat the same prompt and options. */
      readonly absorbedByElicitation?: true;
    }
  | {
      readonly kind: "diff";
      readonly turnId: string;
      readonly diff: string;
    }
  | {
      readonly kind: "plan";
      readonly turnId: string;
      readonly entries: readonly string[];
    }
  | {
      readonly kind: "mail";
      readonly lane: MailLane;
      readonly summary: string;
    }
  | {
      readonly kind: "elicitation";
      readonly turnId: string;
      readonly requestId: string;
      readonly ask: "approval" | "question";
      readonly summary: string;
      readonly settled: boolean;
      readonly detail: string | null;
      readonly options: readonly ElicitationOption[];
      readonly selection: number;
      readonly questions: readonly ElicitationQuestion[];
      readonly questionIndex: number;
      readonly chosen: Readonly<Record<string, readonly string[]>>;
    };

export class TranscriptBuffer extends Array<TranscriptEntry> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  private dirtyStart: number | null = null;
  private readonly userIndexes = new Map<string, number>();
  private readonly compactionIndexes = new Map<string, number>();
  private readonly toolIndexes = new Map<string, number>();
  private readonly planIndexes = new Map<string, number>();
  private readonly diffIndexes = new Map<string, number>();
  private readonly elicitationIndexes = new Map<string, number>();
  private readonly turnIndexes = new Map<string, number[]>();
  private readonly elicitationOrder: number[] = [];
  private pendingElicitationCount = 0;
  revision = 0;

  append(entry: TranscriptEntry): void {
    const index =
      entry.kind === "user" ? this.length : this.firstQueuedUserIndex();
    if (index === this.length) super.push(entry);
    else {
      this.shiftQueuedUserIndexes(index);
      super.splice(index, 0, entry);
    }
    this.indexEntry(entry, index);
    this.markChanged(index);
  }

  tailIndexBeforeQueuedUsers(): number {
    return this.firstQueuedUserIndex() - 1;
  }

  private firstQueuedUserIndex(): number {
    let index = this.length;
    while (index > 0) {
      const entry = this[index - 1];
      if (entry?.kind !== "user" || entry.delivery !== "queued") break;
      index -= 1;
    }
    return index;
  }

  private shiftQueuedUserIndexes(start: number): void {
    for (let index = start; index < this.length; index += 1) {
      const entry = this[index];
      if (entry?.kind === "user") {
        this.userIndexes.set(entry.clientInputId, index + 1);
      }
    }
  }

  private indexEntry(entry: TranscriptEntry, index: number): void {
    if (entry.kind === "user") {
      this.userIndexes.set(entry.clientInputId, index);
    } else if (entry.kind === "compaction") {
      this.compactionIndexes.set(entry.invocationId, index);
    } else if (entry.kind === "tool") {
      this.toolIndexes.set(entry.toolCallId, index);
    } else if (entry.kind === "plan") {
      this.planIndexes.set(entry.turnId, index);
    } else if (entry.kind === "diff") {
      this.diffIndexes.set(entry.turnId, index);
    } else if (entry.kind === "elicitation") {
      this.elicitationIndexes.set(entry.requestId, index);
      this.elicitationOrder.push(index);
      if (!entry.settled) this.pendingElicitationCount += 1;
    }
    if ("turnId" in entry) {
      const indexes = this.turnIndexes.get(entry.turnId);
      if (indexes === undefined) this.turnIndexes.set(entry.turnId, [index]);
      else indexes.push(index);
    }
  }

  replace(index: number, entry: TranscriptEntry): boolean {
    const current = this[index];
    if (current === undefined || current === entry) return false;
    if (
      current.kind === "elicitation" &&
      !current.settled &&
      entry.kind === "elicitation" &&
      entry.settled
    ) {
      this.pendingElicitationCount -= 1;
    }
    this[index] = entry;
    this.markChanged(index);
    return true;
  }

  indexOfHuman(clientInputId: string): number | undefined {
    return this.userIndexes.get(clientInputId);
  }

  indexOfCompaction(invocationId: string): number | undefined {
    return this.compactionIndexes.get(invocationId);
  }

  indexOfCompactionTurn(turnId: string): number | undefined {
    const index = this.findIndex(
      (entry) => entry.kind === "compaction" && entry.providerTurnId === turnId,
    );
    return index === -1 ? undefined : index;
  }

  indexOfTool(toolCallId: string): number | undefined {
    return this.toolIndexes.get(toolCallId);
  }

  indexOfPlan(turnId: string): number | undefined {
    return this.planIndexes.get(turnId);
  }

  indexOfDiff(turnId: string): number | undefined {
    return this.diffIndexes.get(turnId);
  }

  indexOfElicitation(requestId: string): number | undefined {
    return this.elicitationIndexes.get(requestId);
  }

  indexesForTurn(turnId: string): readonly number[] {
    return this.turnIndexes.get(turnId) ?? [];
  }

  pendingElicitation(): PendingElicitation | null {
    for (
      let offset = this.elicitationOrder.length - 1;
      offset >= 0;
      offset -= 1
    ) {
      // SAFETY: The surrounding code already established this contract.
      const entry = this[this.elicitationOrder[offset] as number];
      if (entry?.kind === "elicitation" && !entry.settled) return entry;
    }
    return null;
  }

  hasPendingElicitation(): boolean {
    return this.pendingElicitationCount > 0;
  }

  consumeChangedStart(): number | null {
    const start = this.dirtyStart;
    this.dirtyStart = null;
    return start;
  }

  private markChanged(index: number): void {
    this.dirtyStart =
      this.dirtyStart === null ? index : Math.min(this.dirtyStart, index);
    this.revision += 1;
  }
}

/** Provider and Hive state shown by the screen. The draft is owned by OpenTUI's textarea and is deliberately absent: provider and mail reducers cannot edit text a person is typing. */
export interface ViewState {
  readonly runtime: RuntimePhase;
  readonly turn: TurnPhase;
  readonly foregroundOperation: ActiveCompaction | null;
  readonly mail: MailPhase;
  readonly transcript: TranscriptBuffer;
  readonly contextPercent: number | null;
  readonly liveModel: string | null;
  readonly liveEffort: string | null;
  readonly permissionMode: string | null;
  readonly showToolDetails: boolean;
  readonly attention: AttentionLevel;
  readonly commands: readonly ViewCommand[];
  readonly commandSelection: number;
  readonly dismissedCommandQuery: string | null;
  readonly mentionSelection: number;
  readonly dismissedMentionQuery: string | null;
  readonly modelPicker: ModelPickerState | null;
  readonly modePicker: ModePickerState | null;
}

export interface ModelPickerState {
  readonly stage: "model" | "effort";
  readonly models: readonly ProviderModel[];
  readonly selection: number;
  readonly current: string | null;
  readonly currentEffort: string | null;
  readonly query: string;
  readonly effortModel: ProviderModel | null;
  readonly applying: boolean;
}

export interface ModePickerState {
  readonly modes: readonly string[];
  readonly selection: number;
  readonly current: string | null;
  readonly applying: boolean;
}

const AGENT_UI_COMMANDS = [
  { name: "quit", description: "Exit to the terminal" },
  { name: "exit", description: "Exit to the terminal (alias for /quit)" },
  {
    name: "mode",
    description: "Set how the agent asks for permission (e.g. /mode auto)",
    argumentHint: "default|acceptEdits|auto|dontAsk|plan",
  },
  {
    name: "model",
    description: "Pick the model this agent runs on",
    argumentHint: "[model]",
  },
] satisfies readonly VendorCommand[];

export interface LocalCommandSupport {
  readonly model: boolean;
  readonly mode: boolean;
}

const ALL_LOCAL_COMMANDS: LocalCommandSupport = { model: true, mode: true };

function supportedLocalCommands(
  support: LocalCommandSupport,
): readonly VendorCommand[] {
  return AGENT_UI_COMMANDS.filter((command) => {
    const name = commandName(command);
    if (name === "model") return support.model;
    if (name === "mode") return support.mode;
    return true;
  });
}

function presentCommand(command: VendorCommand): ViewCommand {
  const name = commandName(command);
  const hint = command.argumentHint;
  const label = clipTerminalText(
    `/${name}${hint === undefined ? "" : ` ${hint}`}`,
    { maxCells: COMMAND_COLUMN_CELLS, inline: true },
  );
  return {
    ...command,
    menuColumn: `${label.text}${" ".repeat(
      Math.max(0, COMMAND_COLUMN_CELLS - (label.cells ?? 0)),
    )}`,
    menuDescription:
      command.description === null
        ? null
        : clipTerminalText(command.description, { inline: true }).text,
  };
}

function presentCommands(commands: readonly VendorCommand[]): ViewCommand[] {
  return commands.map(presentCommand);
}

export function initialView(): ViewState {
  return {
    runtime: "starting",
    turn: "unknown",
    foregroundOperation: null,
    mail: "none",
    transcript: new TranscriptBuffer(),
    contextPercent: null,
    liveModel: null,
    liveEffort: null,
    permissionMode: null,
    showToolDetails: false,
    attention: "none",
    commands: presentCommands(AGENT_UI_COMMANDS),
    commandSelection: 0,
    dismissedCommandQuery: null,
    mentionSelection: 0,
    dismissedMentionQuery: null,
    modelPicker: null,
    modePicker: null,
  };
}

export function openModePicker(
  view: ViewState,
  modes: readonly string[],
  current: string | null,
): ViewState {
  const at = current === null ? -1 : modes.indexOf(current);
  return {
    ...view,
    modelPicker: null,
    modePicker: {
      modes,
      selection: Math.max(0, at),
      current,
      applying: false,
    },
  };
}

export function selectedMode(picker: ModePickerState): string | null {
  return picker.modes[picker.selection] ?? null;
}

export function moveModeSelection(view: ViewState, lines: number): ViewState {
  const picker = view.modePicker;
  if (picker === null || picker.applying || picker.modes.length === 0) {
    return view;
  }
  const selection = Math.max(
    0,
    Math.min(picker.modes.length - 1, picker.selection + lines),
  );
  return selection === picker.selection
    ? view
    : { ...view, modePicker: { ...picker, selection } };
}

export function setModePickerApplying(
  view: ViewState,
  applying: boolean,
): ViewState {
  const picker = view.modePicker;
  return picker === null
    ? view
    : { ...view, modePicker: { ...picker, applying } };
}

export function closeModePicker(view: ViewState): ViewState {
  return view.modePicker === null ? view : { ...view, modePicker: null };
}

export function openModelPicker(
  view: ViewState,
  models: readonly ProviderModel[],
  current: string | null,
  currentEffort: string | null,
): ViewState {
  const at =
    current === null ? -1 : models.findIndex((model) => model.id === current);
  return {
    ...view,
    modePicker: null,
    modelPicker: {
      stage: "model",
      models,
      selection: Math.max(0, at),
      current,
      currentEffort,
      query: "",
      effortModel: null,
      applying: false,
    },
  };
}

export function filteredModels(
  picker: ModelPickerState,
): readonly ProviderModel[] {
  const terms = picker.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return picker.models;
  return picker.models.filter((model) => {
    const haystack =
      `${model.displayName} ${model.id} ${model.description ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function selectedModel(picker: ModelPickerState): ProviderModel | null {
  if (picker.stage === "effort") return picker.effortModel;
  return filteredModels(picker)[picker.selection] ?? null;
}

export function selectedModelEffort(picker: ModelPickerState): string | null {
  if (picker.stage !== "effort" || picker.effortModel === null) return null;
  return (
    picker.effortModel.supportedReasoningEfforts[picker.selection]?.id ?? null
  );
}

export function openModelEffortPicker(
  view: ViewState,
  model: ProviderModel,
): ViewState {
  const picker = view.modelPicker;
  if (picker === null || model.supportedReasoningEfforts.length === 0) {
    return view;
  }
  const preferred =
    model.id === picker.current
      ? picker.currentEffort
      : model.defaultReasoningEffort;
  const at = model.supportedReasoningEfforts.findIndex(
    (effort) => effort.id === preferred,
  );
  return {
    ...view,
    modelPicker: {
      ...picker,
      stage: "effort",
      selection: Math.max(0, at),
      query: "",
      effortModel: model,
    },
  };
}

export function returnToModelPicker(view: ViewState): ViewState {
  const picker = view.modelPicker;
  if (picker === null || picker.stage === "model") return view;
  const at =
    picker.effortModel === null
      ? 0
      : picker.models.findIndex((model) => model.id === picker.effortModel?.id);
  return {
    ...view,
    modelPicker: {
      ...picker,
      stage: "model",
      selection: Math.max(0, at),
      effortModel: null,
    },
  };
}

export function updateModelFilter(view: ViewState, query: string): ViewState {
  const picker = view.modelPicker;
  if (picker === null || picker.stage !== "model" || picker.applying) {
    return view;
  }
  return {
    ...view,
    modelPicker: { ...picker, query, selection: 0 },
  };
}

export function setModelPickerApplying(
  view: ViewState,
  applying: boolean,
): ViewState {
  const picker = view.modelPicker;
  return picker === null
    ? view
    : { ...view, modelPicker: { ...picker, applying } };
}

export function moveModelSelection(view: ViewState, lines: number): ViewState {
  const picker = view.modelPicker;
  if (picker === null || picker.applying) return view;
  const count =
    picker.stage === "model"
      ? filteredModels(picker).length
      : (picker.effortModel?.supportedReasoningEfforts.length ?? 0);
  if (count === 0) return view;
  const selection = Math.max(0, Math.min(count - 1, picker.selection + lines));
  if (selection === picker.selection) return view;
  return { ...view, modelPicker: { ...picker, selection } };
}

export function closeModelPicker(view: ViewState): ViewState {
  return view.modelPicker === null ? view : { ...view, modelPicker: null };
}

function commandName(command: VendorCommand): string {
  return command.name.replace(/^\/+/, "");
}

export function commandQuery(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft);
  return match?.[1]?.toLowerCase() ?? null;
}

function hasPendingElicitation(view: ViewState): boolean {
  return pendingElicitation(view) !== null;
}

export type PendingElicitation = Extract<
  TranscriptEntry,
  { kind: "elicitation" }
>;

export function pendingElicitation(view: ViewState): PendingElicitation | null {
  return view.transcript.pendingElicitation();
}

export function moveElicitationSelection(
  view: ViewState,
  lines: number,
): ViewState {
  const pending = pendingElicitation(view);
  if (pending === null) return view;
  const options = pickerOptions(pending);
  if (options.length === 0) return view;
  const selection = Math.max(
    0,
    Math.min(options.length - 1, pending.selection + lines),
  );
  if (selection === pending.selection) return view;
  return updatePending(view, pending.requestId, (entry) => ({
    ...entry,
    selection,
  }));
}

export function currentQuestion(
  pending: PendingElicitation,
): ElicitationQuestion | null {
  return pending.questions[pending.questionIndex] ?? null;
}

/** Verdicts for an approval the vendor offered no options for. Claude Code sends a tool approval as a bare allow-or-deny with no option list, so there is nothing to quote — but allow, allow-for-the-session, and deny are the decisions its protocol actually defines, and a person staring at "run this command?" with nothing to press has been given a question and no answer. These ids are Hive's own and never reach a vendor: `answerPending` turns them back into an outcome and a scope. */
export const VERDICT_ALLOW_ONCE = "hive:allow-once";
export const VERDICT_ALLOW_SESSION = "hive:allow-session";
export const VERDICT_DENY = "hive:deny";

const APPROVAL_VERDICTS: readonly ElicitationOption[] = [
  {
    optionId: VERDICT_ALLOW_ONCE,
    name: "Yes, once",
    kind: "allow",
    description: "Run it this time and ask again next time.",
  },
  {
    optionId: VERDICT_ALLOW_SESSION,
    name: "Yes, and stop asking",
    kind: "allow",
    description: "Allow this for the rest of the session.",
  },
  {
    optionId: VERDICT_DENY,
    name: "No",
    kind: "reject",
    description: "Refuse and tell the agent why it did not run.",
  },
];

export function pickerOptions(
  pending: PendingElicitation,
): readonly ElicitationOption[] {
  const question = currentQuestion(pending);
  if (question !== null) return question.options;
  if (pending.options.length > 0) return pending.options;
  return pending.ask === "approval" ? APPROVAL_VERDICTS : [];
}

function updatePending(
  view: ViewState,
  requestId: string,
  change: (entry: PendingElicitation) => PendingElicitation,
): ViewState {
  const index = view.transcript.indexOfElicitation(requestId);
  const current = index === undefined ? undefined : view.transcript[index];
  if (index === undefined || current?.kind !== "elicitation") return view;
  return view.transcript.replace(index, change(current)) ? { ...view } : view;
}

export function chooseOption(view: ViewState, label: string) {
  const pending = pendingElicitation(view);
  if (pending === null) return { view, complete: false };
  const question = currentQuestion(pending);
  if (question === null) return { view, complete: true };
  const existing = pending.chosen[question.questionId] ?? [];
  const labels = question.multiSelect
    ? existing.includes(label)
      ? existing.filter((entry) => entry !== label)
      : [...existing, label]
    : [label];
  const chosen = { ...pending.chosen, [question.questionId]: labels };
  const advance = question.multiSelect
    ? pending.questionIndex
    : pending.questionIndex + 1;
  return {
    view: updatePending(view, pending.requestId, (entry) => ({
      ...entry,
      chosen,
      questionIndex: advance,
      selection: 0,
    })),
    complete: advance >= pending.questions.length,
  };
}

export function chooseCustomAnswer(view: ViewState, answer: string) {
  const pending = pendingElicitation(view);
  if (pending === null) return { view, complete: false };
  const question = currentQuestion(pending);
  if (question === null || !question.allowCustom || answer.trim() === "") {
    return { view, complete: false };
  }
  const existing = pending.chosen[question.questionId] ?? [];
  const chosen = {
    ...pending.chosen,
    [question.questionId]: question.multiSelect
      ? [...existing, answer]
      : [answer],
  };
  const next = pending.questionIndex + 1;
  return {
    view: updatePending(view, pending.requestId, (entry) => ({
      ...entry,
      chosen,
      questionIndex: next,
      selection: 0,
    })),
    complete: next >= pending.questions.length,
  };
}

export function confirmQuestion(view: ViewState) {
  const pending = pendingElicitation(view);
  if (pending === null) return { view, complete: false };
  const next = pending.questionIndex + 1;
  return {
    view: updatePending(view, pending.requestId, (entry) => ({
      ...entry,
      questionIndex: next,
      selection: 0,
    })),
    complete: next >= pending.questions.length,
  };
}

export function collectedAnswers(pending: PendingElicitation) {
  const answers: Record<string, string | readonly string[]> = {};
  for (const question of pending.questions) {
    const labels = pending.chosen[question.questionId];
    if (labels === undefined || labels.length === 0) continue;
    answers[question.questionId] = question.multiSelect
      ? labels
      : (labels[0] ?? "");
  }
  return answers;
}

export interface CommandMenuEntry {
  readonly command: ViewCommand;
  readonly name: string;
  readonly menuColumn: string;
  readonly menuDescription: string | null;
  readonly selected: boolean;
}

export function commandMenuEntries(
  view: ViewState,
  draft: string,
): readonly CommandMenuEntry[] {
  const query = commandQuery(draft);
  if (
    query === null ||
    query === view.dismissedCommandQuery ||
    hasPendingElicitation(view)
  ) {
    return [];
  }
  const commands = view.commands.filter((command) =>
    commandName(command).toLowerCase().includes(query),
  );
  const selected = Math.min(
    Math.max(0, view.commandSelection),
    Math.max(0, commands.length - 1),
  );
  return commands.map((command, index) => ({
    command,
    name: commandName(command),
    menuColumn: command.menuColumn,
    menuDescription: command.menuDescription,
    selected: index === selected,
  }));
}

export function onDraftChanged(
  view: ViewState,
  previousDraft: string,
  draft: string,
): ViewState {
  if (previousDraft === draft) return view;
  const next = {
    ...view,
    mentionSelection: 0,
  };
  return commandQuery(previousDraft) === commandQuery(draft)
    ? next
    : { ...next, commandSelection: 0, dismissedCommandQuery: null };
}

export function moveCommandSelection(
  view: ViewState,
  draft: string,
  lines: number,
): ViewState {
  const entries = commandMenuEntries(view, draft);
  if (entries.length === 0) return view;
  const commandSelection = Math.max(
    0,
    Math.min(entries.length - 1, view.commandSelection + lines),
  );
  return commandSelection === view.commandSelection
    ? view
    : { ...view, commandSelection };
}

export function dismissCommandMenu(view: ViewState, draft: string): ViewState {
  if (commandMenuEntries(view, draft).length === 0) return view;
  return {
    ...view,
    dismissedCommandQuery: commandQuery(draft),
  };
}

const MENTION_MENU_ROWS = 8;

/** The file query under the cursor: the trailing `@token`, if the character before the `@` is nothing or whitespace. `null` means no picker — an email address or a code snippet mid-word is not a mention. */
export function mentionQuery(textBeforeCursor: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCursor);
  return match?.[1] ?? null;
}

export interface MentionEntry {
  readonly path: string;
  readonly selected: boolean;
}

interface IndexedMentionFile {
  readonly path: string;
  readonly loweredPath: string;
  readonly loweredBase: string;
}

interface RankedMentionFile {
  readonly path: string;
  readonly rank: number;
}

function compareMentionFiles(
  left: RankedMentionFile,
  right: RankedMentionFile,
): number {
  return (
    left.rank - right.rank ||
    left.path.length - right.path.length ||
    left.path.localeCompare(right.path)
  );
}

export class FileMentionIndex {
  private readonly files: readonly IndexedMentionFile[];
  private priorQuery: string | null = null;
  private priorCandidates: readonly IndexedMentionFile[] = [];
  private priorMatches: readonly string[] = [];

  constructor(files: readonly string[]) {
    this.files = files.map((path) => ({
      path,
      loweredPath: path.toLowerCase(),
      loweredBase: (path.split("/").at(-1) ?? path).toLowerCase(),
    }));
  }

  matches(query: string): readonly string[] {
    const lowered = query.toLowerCase();
    if (lowered === this.priorQuery) return this.priorMatches;
    const source =
      this.priorQuery !== null && lowered.startsWith(this.priorQuery)
        ? this.priorCandidates
        : this.files;
    const candidates = source.filter((file) =>
      file.loweredPath.includes(lowered),
    );
    const best: RankedMentionFile[] = [];
    for (const file of candidates) {
      const match = {
        path: file.path,
        rank: file.loweredBase.startsWith(lowered)
          ? 0
          : file.loweredBase.includes(lowered)
            ? 1
            : 2,
      };
      let index = 0;
      while (index < best.length) {
        const current = best[index];
        if (current === undefined || compareMentionFiles(current, match) > 0) {
          break;
        }
        index += 1;
      }
      if (index < MENTION_MENU_ROWS) {
        best.splice(index, 0, match);
        if (best.length > MENTION_MENU_ROWS) best.pop();
      }
    }
    this.priorQuery = lowered;
    this.priorCandidates = candidates;
    this.priorMatches = best.map((match) => match.path);
    return this.priorMatches;
  }
}

export function mentionMenuEntries(
  view: ViewState,
  textBeforeCursor: string,
  index: FileMentionIndex | null,
): readonly MentionEntry[] {
  const query = mentionQuery(textBeforeCursor);
  if (
    query === null ||
    query === view.dismissedMentionQuery ||
    hasPendingElicitation(view) ||
    index === null
  ) {
    return [];
  }
  const paths = index.matches(query);
  const selected = Math.min(
    Math.max(0, view.mentionSelection),
    Math.max(0, paths.length - 1),
  );
  return paths.map((path, position) => ({
    path,
    selected: position === selected,
  }));
}

export function moveMentionSelection(
  view: ViewState,
  textBeforeCursor: string,
  index: FileMentionIndex | null,
  lines: number,
): ViewState {
  const entries = mentionMenuEntries(view, textBeforeCursor, index);
  if (entries.length === 0) return view;
  const mentionSelection = Math.max(
    0,
    Math.min(entries.length - 1, view.mentionSelection + lines),
  );
  return mentionSelection === view.mentionSelection
    ? view
    : { ...view, mentionSelection };
}

export function dismissMentionMenu(
  view: ViewState,
  textBeforeCursor: string,
  index: FileMentionIndex | null,
): ViewState {
  if (mentionMenuEntries(view, textBeforeCursor, index).length === 0) {
    return view;
  }
  return {
    ...view,
    dismissedMentionQuery: mentionQuery(textBeforeCursor),
  };
}

function replaceCommandCatalog(
  view: ViewState,
  commands: readonly VendorCommand[],
  support: LocalCommandSupport = ALL_LOCAL_COMMANDS,
): ViewState {
  const names = new Set(
    commands.map((command) => commandName(command).toLowerCase()),
  );
  const localCommands = supportedLocalCommands(support).filter(
    (command) => !names.has(commandName(command).toLowerCase()),
  );
  const catalog = [...commands, ...localCommands];
  if (
    catalog.length === view.commands.length &&
    catalog.every((command, index) => {
      const current = view.commands[index];
      return (
        current !== undefined &&
        current.name === command.name &&
        current.description === command.description &&
        current.argumentHint === command.argumentHint
      );
    })
  ) {
    return view;
  }
  return {
    ...view,
    commands: presentCommands(catalog),
    commandSelection: 0,
  };
}

export function applyCommandCatalog(
  view: ViewState,
  commands: readonly VendorCommand[],
  support: LocalCommandSupport = ALL_LOCAL_COMMANDS,
): ViewState {
  return replaceCommandCatalog(view, commands, support);
}

export function catalogCommand(
  view: ViewState,
  name: string,
): VendorCommand | null {
  const normalized = name.replace(/^\/+/, "").toLowerCase();
  return (
    view.commands.find(
      (command) => commandName(command).toLowerCase() === normalized,
    ) ?? null
  );
}

export function applyDiagnostic(
  view: ViewState,
  message: string,
  severity: "warning" | "error" = "error",
): ViewState {
  view.transcript.append({
    kind: "diagnostic",
    message,
    ...definedFields({
      severity: severity === "error" ? undefined : severity,
    }),
  });
  return { ...view };
}

export function beginCompaction(
  view: ViewState,
  input: Readonly<{
    invocationId: string;
    command: string;
    requestedAt: string;
    clientInputId: string | null;
    status: "queued" | "starting";
  }>,
): ViewState {
  const entry: ActiveCompaction = {
    kind: "compaction",
    invocationId: input.invocationId,
    command: input.command,
    requestedAt: input.requestedAt,
    contextBefore: view.contextPercent,
    clientInputId: input.clientInputId,
    providerTurnId: null,
    status: input.status,
    completedAt: null,
    contextAfter: null,
    completionEvidence: null,
    detail: null,
  };
  view.transcript.append(entry);
  return { ...view, foregroundOperation: entry, attention: "info" };
}

export function advanceCompaction(
  view: ViewState,
  status: "starting" | "running",
  providerTurnId: string | null = null,
): ViewState {
  const current = view.foregroundOperation;
  if (current === null) return view;
  const next: ActiveCompaction = {
    ...current,
    status,
    providerTurnId: providerTurnId ?? current.providerTurnId,
  };
  const index = view.transcript.indexOfCompaction(current.invocationId);
  if (index !== undefined) view.transcript.replace(index, next);
  return { ...view, foregroundOperation: next, attention: "info" };
}

export function bindCompactionInput(
  view: ViewState,
  clientInputId: string,
  status: "queued" | "starting",
): ViewState {
  const current = view.foregroundOperation;
  if (current === null) return view;
  const next: ActiveCompaction = { ...current, clientInputId, status };
  const index = view.transcript.indexOfCompaction(current.invocationId);
  if (index !== undefined) view.transcript.replace(index, next);
  return { ...view, foregroundOperation: next, attention: "info" };
}

export function settleCompaction(
  view: ViewState,
  input: Readonly<{
    status: SettledCompactionStatus;
    completedAt: string;
    detail?: string | null;
    completionEvidence?: "provider" | "command" | null;
    providerTurnId?: string | null;
  }>,
): ViewState {
  const providerTurnId = input.providerTurnId ?? null;
  if (providerTurnId !== null) {
    const existingIndex = view.transcript.indexOfCompactionTurn(providerTurnId);
    const existing =
      existingIndex === undefined ? undefined : view.transcript[existingIndex];
    if (existing?.kind === "compaction" && existing.completedAt !== null) {
      return view;
    }
  }
  const current = view.foregroundOperation;
  if (current === null) {
    if (input.status !== "ok" || input.completionEvidence !== "provider") {
      return view;
    }
    const completed: SettledCompaction = {
      kind: "compaction",
      invocationId: `provider:${providerTurnId ?? input.completedAt}`,
      command: "/compact",
      requestedAt: input.completedAt,
      contextBefore: null,
      clientInputId: null,
      providerTurnId,
      status: "ok",
      completedAt: input.completedAt,
      contextAfter: view.contextPercent,
      completionEvidence: "provider",
      detail: input.detail ?? null,
    };
    view.transcript.append(completed);
    return { ...view };
  }
  const completed: SettledCompaction = {
    ...current,
    status: input.status,
    completedAt: input.completedAt,
    contextAfter: view.contextPercent,
    completionEvidence: input.completionEvidence ?? null,
    detail: input.detail ?? null,
    providerTurnId: providerTurnId ?? current.providerTurnId,
  };
  const index = view.transcript.indexOfCompaction(current.invocationId);
  if (index !== undefined) view.transcript.replace(index, completed);
  return {
    ...view,
    foregroundOperation: null,
    attention:
      input.status === "error" || input.status === "unknown"
        ? "failure"
        : view.attention,
  };
}

/** Put a submitted user prompt into the conversation exactly once. */
export function presentHumanSubmission(
  view: ViewState,
  clientInputId: string,
  text: string,
  delivery: Extract<HumanDelivery, "queued" | "submitting"> = "submitting",
): ViewState {
  const index = view.transcript.indexOfHuman(clientInputId);
  const current = index === undefined ? undefined : view.transcript[index];
  if (index !== undefined) {
    if (
      current?.kind !== "user" ||
      current.delivery !== "queued" ||
      delivery !== "submitting"
    ) {
      return view;
    }
    return view.transcript.replace(index, { ...current, delivery })
      ? { ...view }
      : view;
  }
  view.transcript.append({
    kind: "user",
    clientInputId,
    text,
    delivery,
  });
  return { ...view };
}

export function settleHumanSubmission(
  view: ViewState,
  clientInputId: string,
  delivery: Exclude<HumanDelivery, "queued" | "submitting">,
): ViewState {
  const index = view.transcript.indexOfHuman(clientInputId);
  const current = index === undefined ? undefined : view.transcript[index];
  if (index === undefined || current?.kind !== "user") return view;
  return view.transcript.replace(index, { ...current, delivery })
    ? { ...view }
    : view;
}

export function toggleToolDetails(view: ViewState): ViewState {
  return { ...view, showToolDetails: !view.showToolDetails };
}

function presentToolDetail(detail: string | null): TerminalTextClip | null {
  return detail === null
    ? null
    : clipTerminalText(detail, {
        maxCells: TOOL_DETAIL_CELLS,
        inline: true,
      });
}

function lineLimitedOutput(
  clip: TerminalTextClip,
  edge: "head" | "tail",
): string {
  if (clip.omittedLines === 0) return clip.text;
  const note = `… ${clip.omittedLines} ${
    edge === "head" ? "more" : "earlier"
  } lines`;
  return edge === "head" ? `${clip.text}\n${note}` : `${note}\n${clip.text}`;
}

function presentToolOutput(
  output: string | null,
): ToolOutputPresentation | null {
  if (output === null) return null;
  const head = clipTerminalText(output, {
    maxLines: TOOL_OUTPUT_HEAD_LINES,
    edge: "head",
  });
  const tail = clipTerminalText(output, {
    maxLines: TOOL_OUTPUT_TAIL_LINES,
    edge: "tail",
  });
  const lastLine = clipTerminalText(output, {
    maxCells: TOOL_RESULT_CELLS,
    maxLines: 1,
    edge: "tail",
    inline: true,
    omitEmptyLines: true,
  });
  return {
    head: lineLimitedOutput(head, "head"),
    tail: lineLimitedOutput(tail, "tail"),
    lastLine,
    nonEmptyLines: lastLine.lineCount,
  };
}

function presentTool(
  detail: string | null,
  output: string | null,
): ToolPresentation {
  return {
    detail: presentToolDetail(detail),
    output: presentToolOutput(output),
  };
}

function appendAgentText(
  transcript: TranscriptBuffer,
  turnId: string,
  text: string,
): TranscriptBuffer {
  const lastIndex = transcript.tailIndexBeforeQueuedUsers();
  const last = transcript[lastIndex];
  if (last !== undefined && last.kind === "agent" && last.turnId === turnId) {
    transcript.replace(lastIndex, {
      ...last,
      text: last.text + text,
    });
    return transcript;
  }
  transcript.append({ kind: "agent", turnId, text, streaming: true });
  return transcript;
}

function appendThoughtText(
  transcript: TranscriptBuffer,
  turnId: string,
  text: string,
  occurredAt: string,
): TranscriptBuffer {
  const lastIndex = transcript.tailIndexBeforeQueuedUsers();
  const last = transcript[lastIndex];
  if (last !== undefined && last.kind === "thought" && last.turnId === turnId) {
    const combined = last.text + text;
    transcript.replace(lastIndex, {
      ...last,
      text: combined,
      summary: last.summary.cellClipped
        ? last.summary
        : clipTerminalText(combined, {
            maxCells: THOUGHT_SUMMARY_CELLS,
            inline: true,
          }),
    });
    return transcript;
  }
  transcript.append({
    kind: "thought",
    turnId,
    text,
    summary: clipTerminalText(text, {
      maxCells: THOUGHT_SUMMARY_CELLS,
      inline: true,
    }),
    startedAt: occurredAt,
    completedAt: null,
  });
  return transcript;
}

function finalizeThoughts(
  transcript: TranscriptBuffer,
  turnId: string,
  occurredAt: string,
): TranscriptBuffer {
  for (const index of transcript.indexesForTurn(turnId)) {
    const entry = transcript[index];
    if (
      entry?.kind === "thought" &&
      entry.turnId === turnId &&
      entry.completedAt === null
    ) {
      transcript.replace(index, { ...entry, completedAt: occurredAt });
    }
  }
  return transcript;
}

function finalizeTurn(
  transcript: TranscriptBuffer,
  turnId: string,
  occurredAt: string,
): TranscriptBuffer {
  for (const index of transcript.indexesForTurn(turnId)) {
    const entry = transcript[index];
    if (entry?.kind === "agent" && entry.turnId === turnId) {
      transcript.replace(index, { ...entry, streaming: false });
    } else if (entry?.kind === "thought" && entry.turnId === turnId) {
      transcript.replace(index, { ...entry, completedAt: occurredAt });
    }
  }
  return transcript;
}

function replaceTurnPlan(
  transcript: TranscriptBuffer,
  turnId: string,
  entries: readonly string[],
): TranscriptBuffer {
  const index = transcript.indexOfPlan(turnId);
  if (index === undefined) {
    transcript.append({ kind: "plan", turnId, entries });
  } else {
    transcript.replace(index, { kind: "plan", turnId, entries });
  }
  return transcript;
}

function updateTool(
  transcript: TranscriptBuffer,
  toolCallId: string,
  change: (
    entry: Extract<TranscriptEntry, { kind: "tool" }>,
  ) => TranscriptEntry,
): TranscriptBuffer {
  const index = transcript.indexOfTool(toolCallId);
  if (index === undefined) return transcript;
  const current = transcript[index];
  if (current?.kind !== "tool") return transcript;
  const next = change(current);
  if (next === current) return transcript;
  transcript.replace(index, next);
  return transcript;
}

function absorbQuestionTool(
  transcript: TranscriptBuffer,
  turnId: string,
): TranscriptBuffer {
  const indexes = transcript.indexesForTurn(turnId);
  for (let offset = indexes.length - 1; offset >= 0; offset -= 1) {
    const index = indexes[offset];
    if (index === undefined) continue;
    const entry = transcript[index];
    if (entry?.kind !== "tool") continue;
    const name = entry.toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (name !== "askuserquestion" && name !== "requestuserinput") continue;
    transcript.replace(index, { ...entry, absorbedByElicitation: true });
    break;
  }
  return transcript;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

/** A turn's diff supersedes the one before it rather than stacking: the provider resends the whole turn's aggregate every time a file in it changes, so appending would draw the same edit once per keystroke of the agent's work. */
function replaceTurnDiff(
  transcript: TranscriptBuffer,
  turnId: string,
  diff: string,
): TranscriptBuffer {
  const existing = transcript.indexOfDiff(turnId);
  if (existing === undefined) {
    transcript.append({ kind: "diff", turnId, diff });
    return transcript;
  }
  const current = transcript[existing];
  if (current?.kind === "diff" && current.diff === diff) return transcript;
  transcript.replace(existing, { kind: "diff", turnId, diff });
  return transcript;
}

function settleElicitation(
  transcript: TranscriptBuffer,
  requestId: string,
): TranscriptBuffer {
  const index = transcript.indexOfElicitation(requestId);
  const entry = index === undefined ? undefined : transcript[index];
  if (index !== undefined && entry?.kind === "elicitation") {
    const chosen = { ...entry.chosen };
    for (const question of entry.questions) {
      if (question.secret) delete chosen[question.questionId];
    }
    transcript.replace(index, { ...entry, chosen, settled: true });
  }
  return transcript;
}

function attentionFor(
  transcript: TranscriptBuffer,
  turn: TurnPhase,
  runtime: RuntimePhase,
  foregroundOperation: ActiveCompaction | null,
): AttentionLevel {
  if (transcript.hasPendingElicitation()) return "approval";
  if (turn === "failed" || runtime === "disconnected") return "failure";
  if (foregroundOperation !== null) return "info";
  if (turn === "working" || turn === "submitting") return "info";
  return "none";
}

export function applyProviderEvent(
  view: ViewState,
  event: NormalizedProviderEvent,
): ViewState {
  const reduced = reduceProviderEvent(view, event);
  const status = statusProjectionForProviderEvent(event);
  const next = {
    ...reduced,
    ...definedFields({
      runtime: status?.runtime,
      turn: status?.turn,
    }),
  };
  return {
    ...next,
    attention: attentionFor(
      next.transcript,
      next.turn,
      next.runtime,
      next.foregroundOperation,
    ),
  };
}

function reduceProviderEvent(
  view: ViewState,
  event: NormalizedProviderEvent,
): ViewState {
  switch (event.kind) {
    case "runtime-connecting":
      return view;
    case "runtime-ready":
      return view;
    case "runtime-disconnected":
      return settleCompaction(view, {
        status: "unknown",
        completedAt: event.occurredAt,
        detail: event.reason,
      });
    case "run-ended":
      return settleCompaction(view, {
        status: "unknown",
        completedAt: event.occurredAt,
        detail: "provider exited before compaction was confirmed",
      });
    case "turn-queued":
      return view;
    case "turn-started":
      return view.foregroundOperation?.clientInputId !== undefined &&
        view.foregroundOperation?.clientInputId !== null &&
        view.foregroundOperation.clientInputId === event.clientInputId
        ? advanceCompaction(view, "running", event.turnId)
        : view;
    case "turn-idle":
      return {
        ...view,
        transcript: finalizeTurn(
          view.transcript,
          event.turnId,
          event.occurredAt,
        ),
      };
    case "turn-failed":
    case "interrupted": {
      const finalized = {
        ...view,
        transcript: finalizeTurn(
          view.transcript,
          event.turnId,
          event.occurredAt,
        ),
      };
      const settled =
        view.foregroundOperation?.providerTurnId === event.turnId
          ? settleCompaction(finalized, {
              status: event.kind === "turn-failed" ? "error" : "cancelled",
              completedAt: event.occurredAt,
              detail:
                event.kind === "turn-failed" ? event.reason : "interrupted",
              providerTurnId: event.turnId,
            })
          : finalized;
      return settled;
    }
    case "message-delta":
      return {
        ...view,
        transcript: appendAgentText(
          finalizeThoughts(view.transcript, event.turnId, event.occurredAt),
          event.turnId,
          event.text,
        ),
      };
    case "thought-delta":
      return {
        ...view,
        transcript: appendThoughtText(
          view.transcript,
          event.turnId,
          event.text,
          event.occurredAt,
        ),
      };
    case "tool-started": {
      finalizeThoughts(view.transcript, event.turnId, event.occurredAt);
      view.transcript.append({
        kind: "tool",
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        detail: event.detail,
        status: "running",
        toolKind: event.toolKind ?? null,
        locations: event.locations ?? [],
        changes: event.changes ?? [],
        output: event.output ?? null,
        presentation: presentTool(event.detail, event.output ?? null),
        startedAt: event.occurredAt,
        completedAt: null,
      });
      return { ...view };
    }
    case "tool-updated":
      return {
        ...view,
        transcript: updateTool(view.transcript, event.toolCallId, (entry) => {
          // A field the update did not mention keeps the value already reported. Only the vendor sending an empty collection clears one.
          const toolKind =
            event.toolKind === undefined ? entry.toolKind : event.toolKind;
          const locations =
            event.locations === undefined ||
            sameStrings(entry.locations, event.locations)
              ? entry.locations
              : event.locations;
          const changes =
            event.changes === undefined ||
            sameToolFileChanges(entry.changes, event.changes)
              ? entry.changes
              : event.changes;
          const output =
            event.output === undefined ? entry.output : event.output;
          if (
            event.detail === entry.detail &&
            toolKind === entry.toolKind &&
            locations === entry.locations &&
            changes === entry.changes &&
            output === entry.output
          ) {
            return entry;
          }
          return {
            ...entry,
            detail: event.detail,
            toolKind,
            locations,
            changes,
            output,
            presentation:
              event.detail === entry.detail && output === entry.output
                ? entry.presentation
                : {
                    detail:
                      event.detail === entry.detail
                        ? entry.presentation.detail
                        : presentToolDetail(event.detail),
                    output:
                      output === entry.output
                        ? entry.presentation.output
                        : presentToolOutput(output),
                  },
          };
        }),
      };
    case "turn-diff-updated":
      return {
        ...view,
        transcript: replaceTurnDiff(view.transcript, event.turnId, event.diff),
      };
    case "tool-finished":
      return {
        ...view,
        transcript: updateTool(view.transcript, event.toolCallId, (entry) =>
          entry.status === event.status &&
          entry.completedAt === event.occurredAt
            ? entry
            : {
                ...entry,
                status: event.status,
                completedAt: event.occurredAt,
              },
        ),
      };
    case "plan-updated":
      return {
        ...view,
        transcript: replaceTurnPlan(
          finalizeThoughts(view.transcript, event.turnId, event.occurredAt),
          event.turnId,
          event.entries,
        ),
      };
    case "config-updated":
      // Most vendors state the model on a frame that says nothing about effort, so a config event carries one field and nulls the other. Null is "this event did not mention it", and writing it over the reading already taken — or over the launch configuration the pane fell back to — would blank a setting that never changed.
      return {
        ...view,
        ...definedFields({
          liveModel: event.model ?? undefined,
          liveEffort: event.effort ?? undefined,
          permissionMode: event.mode ?? undefined,
        }),
      };
    case "usage-updated":
      if (event.contextPercent === null) return view;
      {
        const compactionIndex = view.transcript.indexOfCompactionTurn(
          event.turnId,
        );
        const compaction =
          compactionIndex === undefined
            ? undefined
            : view.transcript[compactionIndex];
        if (
          compactionIndex !== undefined &&
          compaction?.kind === "compaction" &&
          compaction.completedAt !== null
        ) {
          view.transcript.replace(compactionIndex, {
            ...compaction,
            contextAfter: event.contextPercent,
          });
        }
        return { ...view, contextPercent: event.contextPercent };
      }
    case "compacted":
      return settleCompaction(view, {
        status: "ok",
        completedAt: event.occurredAt,
        completionEvidence: "provider",
        providerTurnId: event.turnId,
      });
    case "approval-waiting":
    case "question-waiting": {
      finalizeThoughts(view.transcript, event.turnId, event.occurredAt);
      if (event.kind === "question-waiting") {
        absorbQuestionTool(view.transcript, event.turnId);
      }
      view.transcript.append({
        kind: "elicitation",
        turnId: event.turnId,
        requestId: event.requestId,
        ask: event.kind === "approval-waiting" ? "approval" : "question",
        summary: event.summary,
        settled: false,
        detail: event.detail ?? null,
        options: event.options ?? [],
        selection: 0,
        questions:
          event.kind === "question-waiting" ? (event.questions ?? []) : [],
        questionIndex: 0,
        chosen: {},
      });
      return { ...view };
    }
    case "elicitation-settled":
      return {
        ...view,
        transcript: settleElicitation(view.transcript, event.requestId),
      };
    case "commands-updated":
      return replaceCommandCatalog(view, event.commands);
    case "unrecognized":
      return view;
  }
}

export function applyMailPhase(view: ViewState, mail: MailPhase): ViewState {
  return { ...view, mail };
}

export function applyMailNotice(
  view: ViewState,
  lane: MailLane,
  summary: string,
): ViewState {
  view.transcript.append({ kind: "mail", lane, summary });
  return { ...view };
}
