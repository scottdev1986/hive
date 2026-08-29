import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import type {
  NormalizedProviderEvent,
  ProviderModel,
  ProviderSession,
  SubmissionReceipt,
  VendorCommand,
} from "../../adapters/providers/protocol/types";
import {
  composeQueenCompactReload,
  ensureQueenPin,
} from "../../daemon/queen-provider-service/queen-pin";
import type {
  FrontendWakeReport,
  MailReadyNotice,
} from "../../schemas/mail-wake";
import type {
  ObservabilityEvent,
  ObservabilitySeverity,
  ObservabilitySource,
} from "../../schemas/observability";
import {
  WakePayloadRequestSchema,
  WakePayloadSchema,
} from "../../schemas/wake-payload";
import { systemNowIso } from "../../shared/clock";
import { definedFields } from "../../shared/defined-fields";
import { errorMessage } from "../../shared/error-message";
import { reportProtocolSessionFacts } from "../../usage-service/protocol-facts-report";
import { decodeJson } from "../daemon-response";
import { PaneDaemonClient } from "./pane-daemon-client";
import { formatWakePrompt } from "./wake-prompt";
import type { OutboundJournal, OutboundRow } from "./outbound-journal";
import {
  bannerContent,
  COLORS,
  commandMenuContent,
  defaultComposerPlaceholder,
  footerHintsContent,
  footerStatusContent,
  foregroundIsActive,
  mentionMenuContent,
  modelLabel,
  modelPickerContent,
  modelPickerHeight,
  modePickerContent,
  modePickerHeight,
  type PaneIdentity,
  queueSummaryLine,
  SPINNER_FRAMES,
  vendorBrand,
  visibleCommandEntries,
} from "./presentation";
import { createSyntaxStyle, syntaxClient } from "./syntax";
import { TranscriptView } from "./transcript-view";
import {
  canSubmitUser,
  commitDispatch,
  EMPTY_SCHEDULER,
  enqueueWake,
  nextItem,
  onSubmissionAccepted,
  onTurnBoundary,
  onTurnStarted,
  pendingWakeCount,
  type ScheduledItem,
  type SchedulerState,
  type WakeItem,
} from "./turn-scheduler";
import {
  advanceCompaction,
  applyCommandCatalog,
  applyDiagnostic,
  applyMailNotice,
  applyMailPhase,
  applyProviderEvent,
  beginCompaction,
  bindCompactionInput,
  catalogCommand,
  chooseCustomAnswer,
  chooseOption,
  closeModelPicker,
  closeModePicker,
  commandMenuEntries,
  confirmQuestion,
  currentQuestion,
  customRowIndex,
  dismissCommandMenu,
  dismissMentionMenu,
  FileMentionIndex,
  focusCustomRow,
  initialView,
  type LocalCommandSupport,
  type MentionEntry,
  mentionMenuEntries,
  mentionQuery,
  moveCommandSelection,
  moveElicitationSelection,
  moveMentionSelection,
  moveModelSelection,
  moveModeSelection,
  moveQuestionFocus,
  onDraftChanged,
  openModelEffortPicker,
  openModelPicker,
  openModePicker,
  type PendingElicitation,
  pendingElicitation,
  type PendingStep,
  permissionReply,
  pickerOptions,
  presentHumanSubmission,
  returnToModelPicker,
  selectedMode,
  selectedModel,
  selectedModelEffort,
  setModelPickerApplying,
  setModePickerApplying,
  settleCompaction,
  settleHumanSubmission,
  toggleToolDetails,
  updateModelFilter,
  type ViewState,
} from "./view-state";
import { WakeReportQueue } from "./wake-report-queue";
import { listWorkspaceFiles } from "./workspace-files";
import type { JsonValue } from "../../shared/json";

export {
  agentHeaderText,
  defaultComposerPlaceholder,
  type PaneIdentity,
} from "./presentation";

export interface AgentUiConstructorOptions {
  readonly renderer: CliRenderer;
  readonly identity: PaneIdentity;
  readonly session: ProviderSession;
  readonly journal: OutboundJournal;
  readonly vendorSessionId: string;
  readonly daemonPort?: number;
  readonly paneClient?: Pick<PaneDaemonClient, "request">;
  readonly reportReceipt?: (receipt: SubmissionReceipt) => Promise<void>;
  readonly now?: () => string;
  readonly writeLocalClipboard?: (text: string) => boolean;
  readonly reportWake?: (report: FrontendWakeReport) => Promise<void>;
  readonly reportDiagnostic?: (report: UiDiagnosticReport) => void;
  readonly syntaxHighlighter?: NonNullable<ReturnType<typeof syntaxClient>>;
  /** Queen only. After a vendor compact, load the daemon-owned pin and live
   * board and submit them as an internal turn. Absent for workers. */
  readonly loadCompactReload?: () => Promise<string>;
}

export interface UiDiagnosticReport {
  readonly severity: ObservabilitySeverity;
  readonly source: ObservabilitySource;
  readonly operation: string;
  readonly reason: string;
}

/** Fail-soft wake prompt when daemon is unavailable or /wake-payload fails. Uses lane + backlogCount from the notice. No oldestItemId. No memory section. A wake points the agent to its mailbox; it never copies mail into a prompt. Naming the item id taught models to hive_mail_claim before hive_mail_poll, which the ledger refused as an unpresented body. */
export function wakePrompt(wake: WakeItem): string {
  const parts: string[] = [];
  parts.push(
    `Hive mail wake (${wake.lane} lane): you have unread mail.`,
    `${wake.lane === "control" ? "Control" : "Work"}: ${wake.backlogCount} available`,
    "",
    "Poll your mailbox with hive_mail_poll, claim at most one control item, and settle it before any other work. This is internal operations, not a user message. Do not call SendUserMessage or narrate the mailbox work; finish silently unless the mail itself requires a direct user decision.",
  );
  return parts.join("\n");
}

function exitsAgentUi(text: string): boolean {
  const command = text.trim().toLowerCase();
  return command === "/quit" || command === "/exit";
}

function platformClipboardWrite(text: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const child = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.write(text);
    child.stdin.end();
    return true;
  } catch {
    return false;
  }
}

const SPINNER_INTERVAL_MS = 120;
const CTRL_C_QUIT_WINDOW_MS = 2_000;

function isSubmitKey(key: KeyEvent): boolean {
  return (
    (key.name === "return" || key.name === "kpenter") &&
    !key.shift &&
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    key.super !== true
  );
}

interface FooterRefreshSnapshot {
  readonly runtime: ViewState["runtime"];
  readonly turn: ViewState["turn"];
  readonly foregroundOperation: ViewState["foregroundOperation"];
  readonly mail: ViewState["mail"];
  readonly attention: ViewState["attention"];
  readonly contextPercent: number | null;
  readonly liveModel: string | null;
  readonly liveEffort: string | null;
  readonly permissionMode: string | null;
  readonly spinnerFrame: number;
  readonly elapsedSeconds: number;
}

function sameFooterRefresh(
  left: FooterRefreshSnapshot | null,
  right: FooterRefreshSnapshot,
): boolean {
  return (
    left !== null &&
    left.runtime === right.runtime &&
    left.turn === right.turn &&
    left.foregroundOperation === right.foregroundOperation &&
    left.mail === right.mail &&
    left.attention === right.attention &&
    left.contextPercent === right.contextPercent &&
    left.liveModel === right.liveModel &&
    left.liveEffort === right.liveEffort &&
    left.permissionMode === right.permissionMode &&
    left.spinnerFrame === right.spinnerFrame &&
    left.elapsedSeconds === right.elapsedSeconds
  );
}

interface MenuRefreshSnapshot {
  readonly modelPicker: ViewState["modelPicker"];
  readonly modePicker: ViewState["modePicker"];
  readonly commands: ViewState["commands"];
  readonly commandSelection: number;
  readonly dismissedCommandQuery: string | null;
  readonly transcriptRevision: number;
  readonly mentionIndex: FileMentionIndex | null;
  readonly mentionSelection: number;
  readonly dismissedMentionQuery: string | null;
  readonly draft: string;
  readonly cursorOffset: number;
}

function sameMenuRefresh(
  left: MenuRefreshSnapshot | null,
  right: MenuRefreshSnapshot,
): boolean {
  return (
    left !== null &&
    left.modelPicker === right.modelPicker &&
    left.modePicker === right.modePicker &&
    left.commands === right.commands &&
    left.commandSelection === right.commandSelection &&
    left.dismissedCommandQuery === right.dismissedCommandQuery &&
    left.transcriptRevision === right.transcriptRevision &&
    left.mentionIndex === right.mentionIndex &&
    left.mentionSelection === right.mentionSelection &&
    left.dismissedMentionQuery === right.dismissedMentionQuery &&
    left.draft === right.draft &&
    left.cursorOffset === right.cursorOffset
  );
}

export class AgentUi {
  private view: ViewState = initialView();
  private scheduler: SchedulerState = EMPTY_SCHEDULER;
  private readonly frame: BoxRenderable;
  private readonly bannerText: TextRenderable;
  private readonly transcript: ScrollBoxRenderable;
  private readonly transcriptView: TranscriptView;
  private readonly queueStatus: TextRenderable;
  private readonly menuPanel: BoxRenderable;
  private readonly commands: TextRenderable;
  private readonly composer: BoxRenderable;
  private readonly textarea: TextareaRenderable;
  private readonly footerStatus: TextRenderable;
  private readonly footerHints: TextRenderable;
  private readonly draftHistory: string[] = [];
  private historyIndex: number | null = null;
  private lastDraft = "";
  private inputWork = Promise.resolve();
  private inputError: JsonValue = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerTick = 0;
  private turnStartedAt: string | null = null;
  private ctrlCArmedAtMs: number | null = null;
  private bannerModel: string | null = null;
  private footerRefresh: FooterRefreshSnapshot | null = null;
  private footerHintsArmed: boolean | null = null;
  private transcriptRevision = -1;
  private transcriptDetails = false;
  private queueWakeCount: number | null = null;
  private menuRefresh: MenuRefreshSnapshot | null = null;
  private mentionIndex: FileMentionIndex | null = null;
  private mentionFilesLoading = false;
  private readonly onKeyPress: (key: KeyEvent) => void;
  private readonly onPaste: (event: PasteEvent) => void;
  private composerPlaceholder: string | null = null;
  private composerBorder: string = COLORS.headerEdge;
  private parkedDraft: string | null = null;
  private secretQuestionKey: string | null = null;
  private secretAnswer: string[] = [];
  private secretCursor = 0;
  private readonly dispatchedWakes = new Map<
    string,
    Readonly<{
      wakeId: string;
      acceptedReport: Extract<
        FrontendWakeReport,
        { kind: "wake-request-accepted" }
      >;
      accepted: Promise<boolean>;
    }>
  >();
  /** Wake evidence waiting to be flushed in prerequisite order. A turn arrives on an event handler that cannot await, and a dropped turn-observed leaves a gap the chain never fills. Dispatching is the one place that must not run ahead of it, so `pump` drains this first and the next wake cannot be reported before the turn that closed the last one. */
  private readonly wakeReports = new WakeReportQueue();
  private pumpTail: Promise<void> = Promise.resolve();
  private backgroundPump: Promise<void> | null = null;
  private backgroundPumpRequested = false;
  private detached = false;
  private pendingInputs: OutboundRow[] = [];
  private pendingCompactReload = false;

  private readonly renderer: CliRenderer;
  private readonly identity: PaneIdentity;
  private readonly session: ProviderSession;
  private readonly journal: OutboundJournal;
  private readonly vendorSessionId: string;
  private readonly daemonPort: number | undefined;
  private readonly paneClient: Pick<PaneDaemonClient, "request"> | undefined;
  private readonly reportReceipt:
    ((receipt: SubmissionReceipt) => Promise<void>) | undefined;
  private readonly now: () => string;
  private readonly writeLocalClipboard: (text: string) => boolean;
  private readonly reportWake:
    ((report: FrontendWakeReport) => Promise<void>) | undefined;
  private readonly reportDiagnostic:
    ((report: UiDiagnosticReport) => void) | undefined;
  private readonly loadCompactReload: (() => Promise<string>) | undefined;

  constructor(options: AgentUiConstructorOptions) {
    this.renderer = options.renderer;
    this.identity = options.identity;
    this.session = options.session;
    this.journal = options.journal;
    this.vendorSessionId = options.vendorSessionId;
    this.daemonPort = options.daemonPort;
    this.paneClient =
      options.paneClient ??
      (options.daemonPort === undefined
        ? undefined
        : new PaneDaemonClient({
            port: options.daemonPort,
            subject: options.identity.agentName,
          }));
    this.reportReceipt = options.reportReceipt;
    this.now = options.now ?? systemNowIso;
    this.writeLocalClipboard =
      options.writeLocalClipboard ?? platformClipboardWrite;
    this.reportWake = options.reportWake;
    this.reportDiagnostic = options.reportDiagnostic;
    this.loadCompactReload = options.loadCompactReload;
    this.view = applyCommandCatalog(this.view, [], this.localCommandSupport());
    const { renderer, identity } = options;
    this.restoreJournalRows();
    this.frame = new BoxRenderable(renderer, {
      id: "agent-ui",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });
    const brand = vendorBrand(identity);
    this.transcript = new ScrollBoxRenderable(renderer, {
      id: "agent-ui-transcript",
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      contentOptions: {
        flexDirection: "column",
        paddingX: 2,
        paddingTop: 1,
        paddingBottom: 1,
      },
    });
    // The pane scrolls like a terminal, not a web page: wheel and paging keys work, but no scrollbar column sits over the text. Only the property setter latches manual visibility — passed as a constructor option it is erased by a field initializer, and the bar re-shows itself on overflow.
    this.transcript.verticalScrollBar.visible = false;
    for (const surface of [this.transcript.content, this.transcript.viewport]) {
      surface.selectable = true;
      surface.shouldStartSelection = () => true;
    }
    const banner = new BoxRenderable(renderer, {
      id: "agent-ui-banner",
      width: "100%",
      height: "auto",
      flexDirection: "column",
    });
    this.bannerText = new TextRenderable(renderer, {
      id: "agent-ui-banner-text",
      height: "auto",
      wrapMode: "none",
    });
    banner.add(this.bannerText);
    this.transcriptView = new TranscriptView(
      renderer,
      this.transcript,
      COLORS,
      createSyntaxStyle(),
      options.syntaxHighlighter === undefined
        ? syntaxClient()
        : options.syntaxHighlighter,
      {
        mark: brand.mark,
        accent: brand.accent,
        ...definedFields({ workspacePath: identity.workspacePath }),
      },
      () => {
        this.view = toggleToolDetails(this.view);
        this.refresh();
      },
      banner,
    );
    this.queueStatus = new TextRenderable(renderer, {
      id: "agent-ui-queue",
      width: "100%",
      height: 1,
      paddingX: 1,
      fg: COLORS.orange,
      truncate: true,
      visible: false,
    });
    this.menuPanel = new BoxRenderable(renderer, {
      id: "agent-ui-menu",
      width: "100%",
      height: 3,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.headerEdge,
      title: " COMMANDS ",
      titleColor: COLORS.dim,
      paddingLeft: 1,
      paddingRight: 1,
      visible: false,
    });
    this.commands = new TextRenderable(renderer, {
      id: "agent-ui-commands",
      width: "100%",
      height: 1,
      wrapMode: "none",
      truncate: true,
      visible: false,
    });
    this.menuPanel.add(this.commands);
    this.composer = new BoxRenderable(renderer, {
      id: "agent-ui-composer",
      width: "100%",
      height: 4,
      flexDirection: "row",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.headerEdge,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const prompt = new TextRenderable(renderer, {
      width: 2,
      height: 2,
      content: "❯\n ",
      fg: COLORS.green,
    });
    this.textarea = new TextareaRenderable(renderer, {
      id: "agent-ui-input",
      height: 2,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "word",
      placeholder: defaultComposerPlaceholder(identity),
      placeholderColor: COLORS.dim,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      selectionBg: COLORS.blue,
      cursorColor: COLORS.green,
      cursorStyle: { style: "line", blinking: true },
      showCursor: true,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "newline" },
        { name: "return", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
      ],
    });
    const footer = new BoxRenderable(renderer, {
      id: "agent-ui-footer",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.footerStatus = new TextRenderable(renderer, {
      id: "agent-ui-footer-status",
      height: 1,
      flexShrink: 1,
      minWidth: 8,
      wrapMode: "none",
      truncate: true,
    });
    this.footerHints = new TextRenderable(renderer, {
      id: "agent-ui-footer-hints",
      height: 1,
      flexShrink: 0,
      marginLeft: 2,
      wrapMode: "none",
    });
    footer.add(this.footerStatus);
    footer.add(this.footerHints);

    this.composer.add(prompt);
    this.composer.add(this.textarea);
    this.frame.add(this.transcript);
    this.frame.add(this.queueStatus);
    this.frame.add(this.menuPanel);
    this.frame.add(this.composer);
    this.frame.add(footer);
    renderer.root.add(this.frame);

    this.textarea.onContentChange = () => {
      const draft = this.textarea.plainText;
      if (
        this.historyIndex !== null &&
        draft !== this.draftHistory[this.historyIndex]
      ) {
        this.historyIndex = null;
      }
      this.view = onDraftChanged(this.view, this.lastDraft, draft);
      if (this.lastDraft === "" && draft !== "") {
        this.view = focusCustomRow(this.view);
      }
      this.lastDraft = draft;
      this.refresh();
    };
    this.textarea.onSubmit = () => {
      this.enqueueInput(() => this.submitDraft(this.now()));
    };
    this.onKeyPress = (key) => this.routeKey(key);
    this.onPaste = (event) => this.routePaste(event);
    renderer.keyInput.on("keypress", this.onKeyPress);
    renderer.keyInput.on("paste", this.onPaste);
    this.textarea.focus();
    this.refresh();
  }

  private restoreJournalRows(): void {
    for (const row of this.journal.all()) {
      if (row.purpose === "compaction") {
        this.view = beginCompaction(this.view, {
          invocationId: row.clientInputId,
          command: row.text,
          requestedAt: row.createdAt,
          clientInputId: row.clientInputId,
          status: "starting",
        });
        this.view = settleCompaction(this.view, {
          status: row.state === "rejected" ? "error" : "unknown",
          completedAt: row.createdAt,
          detail:
            row.state === "rejected"
              ? "provider rejected the compaction command"
              : "completion was not recorded before Hive restarted",
        });
        continue;
      }
      this.view = presentHumanSubmission(
        this.view,
        row.clientInputId,
        row.text,
      );
      this.view = settleHumanSubmission(
        this.view,
        row.clientInputId,
        row.state === "rejected"
          ? "rejected"
          : row.state === "delivery_unknown" || row.state === "pending"
            ? "unknown"
            : "accepted",
      );
    }
  }

  private localCommandSupport(): LocalCommandSupport {
    return {
      model:
        this.session.setModel !== undefined &&
        (this.session.listModelCatalog !== undefined ||
          this.session.listModelIds !== undefined),
      mode: this.session.setPermissionMode !== undefined,
    };
  }

  /** Seed the catalog before the provider's first update event arrives. */
  replaceCommandCatalog(commands: readonly VendorCommand[]): void {
    this.view = applyCommandCatalog(
      this.view,
      commands,
      this.localCommandSupport(),
    );
    this.refresh();
  }

  private parkDraftForElicitation(): void {
    if (this.parkedDraft !== null || this.textarea.plainText === "") return;
    this.parkedDraft = this.textarea.plainText;
    this.textarea.clear();
  }

  private restoreParkedDraft(): void {
    const parked = this.parkedDraft;
    if (parked === null) return;
    this.parkedDraft = null;
    const current = this.textarea.plainText;
    const restored = current === "" ? parked : `${parked}\n${current}`;
    this.textarea.setText(restored);
    this.textarea.cursorOffset = restored.length;
  }

  private activeSecretQuestion(): {
    readonly key: string;
    readonly allowCustom: boolean;
  } | null {
    const pending = pendingElicitation(this.view);
    const question = pending === null ? null : currentQuestion(pending);
    return pending === null || question?.secret !== true
      ? null
      : {
          key: `${pending.requestId}:${question.questionId}`,
          allowCustom: question.allowCustom,
        };
  }

  private syncSecretQuestion(): void {
    const active = this.activeSecretQuestion();
    const key = active?.key ?? null;
    if (key === this.secretQuestionKey) return;
    this.secretQuestionKey = key;
    this.secretAnswer = [];
    this.secretCursor = 0;
    if (key !== null && this.textarea.plainText !== "") {
      this.textarea.clear();
    }
  }

  private updateSecretComposer(): void {
    const masked = "•".repeat(this.secretAnswer.length);
    this.textarea.setText(masked);
    this.textarea.cursorOffset = this.secretCursor;
  }

  private insertSecretText(text: string): void {
    const inserted = Array.from(text);
    this.secretAnswer.splice(this.secretCursor, 0, ...inserted);
    this.secretCursor += inserted.length;
    this.updateSecretComposer();
  }

  private routePaste(event: PasteEvent): void {
    const active = this.activeSecretQuestion();
    if (active === null || !active.allowCustom) return;
    event.preventDefault();
    this.insertSecretText(new TextDecoder().decode(event.bytes));
  }

  /** Secret answers never become terminal glyphs. The composer contains one bullet per code point while the provider's actual value stays in a short-lived buffer that is cleared as soon as the question advances. */
  private routeSecretKey(key: KeyEvent): boolean {
    const active = this.activeSecretQuestion();
    if (active === null || !active.allowCustom) return false;
    if (isSubmitKey(key)) return false;

    if (
      key.name === "linefeed" ||
      ((key.name === "return" || key.name === "kpenter") && key.shift)
    ) {
      key.preventDefault();
      this.insertSecretText("\n");
      return true;
    }

    if (key.ctrl && key.name === "a") {
      key.preventDefault();
      this.secretCursor = 0;
      this.updateSecretComposer();
      return true;
    }
    if (key.ctrl && key.name === "e") {
      key.preventDefault();
      this.secretCursor = this.secretAnswer.length;
      this.updateSecretComposer();
      return true;
    }
    if (key.ctrl && key.name === "u") {
      key.preventDefault();
      this.secretAnswer.splice(0, this.secretCursor);
      this.secretCursor = 0;
      this.updateSecretComposer();
      return true;
    }
    if (key.ctrl && key.name === "k") {
      key.preventDefault();
      this.secretAnswer.splice(this.secretCursor);
      this.updateSecretComposer();
      return true;
    }
    if (key.ctrl && key.name === "w") {
      key.preventDefault();
      let start = this.secretCursor;
      while (start > 0 && /\s/.test(this.secretAnswer[start - 1] ?? "")) {
        start -= 1;
      }
      while (start > 0 && !/\s/.test(this.secretAnswer[start - 1] ?? "")) {
        start -= 1;
      }
      this.secretAnswer.splice(start, this.secretCursor - start);
      this.secretCursor = start;
      this.updateSecretComposer();
      return true;
    }
    if (key.name === "left" || key.name === "right") {
      key.preventDefault();
      this.secretCursor = Math.max(
        0,
        Math.min(
          this.secretAnswer.length,
          this.secretCursor + (key.name === "left" ? -1 : 1),
        ),
      );
      this.updateSecretComposer();
      return true;
    }
    if (key.name === "home" || key.name === "end") {
      key.preventDefault();
      this.secretCursor = key.name === "home" ? 0 : this.secretAnswer.length;
      this.updateSecretComposer();
      return true;
    }
    if (key.name === "backspace") {
      key.preventDefault();
      if (this.secretCursor > 0) {
        this.secretAnswer.splice(this.secretCursor - 1, 1);
        this.secretCursor -= 1;
        this.updateSecretComposer();
      }
      return true;
    }
    if (key.name === "delete") {
      key.preventDefault();
      if (this.secretCursor < this.secretAnswer.length) {
        this.secretAnswer.splice(this.secretCursor, 1);
        this.updateSecretComposer();
      }
      return true;
    }
    if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      key.super !== true &&
      Array.from(key.sequence).length === 1 &&
      key.sequence >= " "
    ) {
      key.preventDefault();
      this.insertSecretText(key.sequence);
      return true;
    }

    // History, tab focus, and editor shortcuts cannot edit a masked buffer
    // safely. Global interrupt/copy/detail shortcuts run before this guard.
    key.preventDefault();
    return true;
  }

  replaceMentionFiles(files: readonly string[]): void {
    this.mentionIndex = new FileMentionIndex(files);
    this.refresh();
  }

  private textBeforeCursor(): string {
    return this.textarea.plainText.slice(0, this.textarea.cursorOffset);
  }

  private mentionEntries(): readonly MentionEntry[] {
    return this.mentionEntriesAt(
      this.textarea.plainText,
      this.textarea.cursorOffset,
    );
  }

  private mentionEntriesAt(
    draft: string,
    cursorOffset: number,
  ): readonly MentionEntry[] {
    const before = draft.slice(0, cursorOffset);
    if (this.mentionIndex === null) {
      if (mentionQuery(before) !== null) this.loadMentionFiles();
      return [];
    }
    return mentionMenuEntries(this.view, before, this.mentionIndex);
  }

  private loadMentionFiles(): void {
    if (this.mentionFilesLoading) return;
    this.mentionFilesLoading = true;
    void listWorkspaceFiles(this.identity.workspacePath ?? process.cwd()).then(
      (files) => {
        this.mentionFilesLoading = false;
        this.mentionIndex ??= new FileMentionIndex(files);
        this.refresh();
      },
    );
  }

  private completeMention(path: string): void {
    const text = this.textarea.plainText;
    const cursor = this.textarea.cursorOffset;
    const before = text.slice(0, cursor);
    const match = /(?:^|\s)@[^\s@]*$/.exec(before);
    if (match === null) return;
    const start = match.index + (match[0].startsWith("@") ? 0 : 1);
    const mention = `@${path} `;
    this.textarea.setText(
      `${text.slice(0, start)}${mention}${text.slice(cursor)}`,
    );
    this.textarea.cursorOffset = start + mention.length;
    this.refresh();
  }

  presentPrompt(clientInputId: string, text: string): void {
    this.view = presentHumanSubmission(this.view, clientInputId, text);
    this.refresh();
  }

  settlePrompt(receipt: SubmissionReceipt): void {
    this.view = settleHumanSubmission(
      this.view,
      receipt.clientInputId,
      receipt.outcome === "accepted"
        ? "accepted"
        : receipt.outcome === "rejected"
          ? "rejected"
          : "unknown",
    );
    this.refresh();
  }

  private routeKey(key: KeyEvent): void {
    // Any key that is not Ctrl+C stands down the armed quit, so an old press cannot pair with one minutes later.
    if (!(key.ctrl && key.name === "c") && this.ctrlCArmedAtMs !== null) {
      this.ctrlCArmedAtMs = null;
      this.refresh();
    }
    const modePicker = this.view.modePicker;
    if (modePicker !== null) {
      key.preventDefault();
      if (modePicker.applying) return;
      if (key.name === "up" || key.name === "down") {
        this.view = moveModeSelection(this.view, key.name === "up" ? -1 : 1);
        this.refresh();
        return;
      }
      if (key.name === "escape") {
        this.view = closeModePicker(this.view);
        this.refresh();
        return;
      }
      if (isSubmitKey(key)) {
        const mode = selectedMode(modePicker);
        if (mode !== null) {
          this.enqueueInput(() => this.applyPermissionMode(mode));
        }
      }
      return;
    }
    const modelPicker = this.view.modelPicker;
    if (modelPicker !== null) {
      if (modelPicker.applying) {
        key.preventDefault();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        this.view = moveModelSelection(this.view, key.name === "up" ? -1 : 1);
        this.refresh();
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        this.view =
          modelPicker.stage === "effort"
            ? returnToModelPicker(this.view)
            : modelPicker.query === ""
              ? closeModelPicker(this.view)
              : updateModelFilter(this.view, "");
        this.refresh();
        return;
      }
      if (isSubmitKey(key)) {
        key.preventDefault();
        const model = selectedModel(modelPicker);
        if (model !== null) {
          if (
            modelPicker.stage === "model" &&
            model.supportedReasoningEfforts.length > 0
          ) {
            this.view = openModelEffortPicker(this.view, model);
            this.refresh();
          } else {
            const effort = selectedModelEffort(modelPicker);
            this.enqueueInput(() =>
              this.applyModel(model.id, effort ?? undefined),
            );
          }
        }
        return;
      }
      if (key.name === "backspace" && modelPicker.stage === "model") {
        key.preventDefault();
        this.view = updateModelFilter(
          this.view,
          modelPicker.query.slice(0, -1),
        );
        this.refresh();
        return;
      }
      if (
        modelPicker.stage === "model" &&
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        !key.super &&
        Array.from(key.sequence).length === 1 &&
        key.sequence >= " "
      ) {
        key.preventDefault();
        this.view = updateModelFilter(
          this.view,
          `${modelPicker.query}${key.sequence}`,
        );
        this.refresh();
        return;
      }
      key.preventDefault();
      return;
    }
    const pendingBeforeShortcut = pendingElicitation(this.view);
    if (
      pendingBeforeShortcut === null &&
      (key.meta || key.option) &&
      key.name.toLowerCase() === "p" &&
      this.localCommandSupport().model
    ) {
      key.preventDefault();
      this.enqueueInput(() => this.applyOrPickModel(""));
      return;
    }
    if (
      pendingBeforeShortcut === null &&
      key.shift &&
      key.name === "tab" &&
      this.localCommandSupport().mode &&
      (this.session.permissionModes?.length ?? 0) > 0
    ) {
      key.preventDefault();
      this.enqueueInput(() => this.cyclePermissionMode());
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.enqueueInput(() => this.dismissOrInterrupt());
      return;
    }
    // Copying takes priority over interrupting only while text is actually selected, so Ctrl+C keeps meaning "stop" the rest of the time. Cmd+C counts too when the terminal forwards it (kitty keyboard protocol). A refused clipboard is reported rather than falling through: a person holding a selection meant "copy", never "interrupt the agent".
    if ((key.ctrl || key.super === true) && key.name === "c") {
      const selected = this.renderer.getSelection()?.getSelectedText() ?? "";
      if (selected !== "") {
        key.preventDefault();
        if (!this.copyToClipboard(selected)) {
          this.reportError(
            "copy failed — the terminal refused OSC 52 clipboard access",
          );
        }
        return;
      }
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      const pressedAt = Date.parse(this.now());
      if (
        this.ctrlCArmedAtMs !== null &&
        pressedAt - this.ctrlCArmedAtMs <= CTRL_C_QUIT_WINDOW_MS
      ) {
        this.enqueueInput(() => this.session.close());
        return;
      }
      this.ctrlCArmedAtMs = pressedAt;
      this.enqueueInput(() => this.cancelActiveTurn());
      this.refresh();
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      this.view = toggleToolDetails(this.view);
      this.refresh();
      return;
    }
    if (key.ctrl && key.name === "d" && this.textarea.plainText === "") {
      key.preventDefault();
      this.enqueueInput(() =>
        pendingBeforeShortcut === null
          ? this.session.close()
          : this.dismissOrInterrupt(),
      );
      return;
    }
    if (this.routeSecretKey(key)) return;
    const menu = commandMenuEntries(this.view, this.textarea.plainText);
    if (menu.length > 0 && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      this.view = moveCommandSelection(
        this.view,
        this.textarea.plainText,
        key.name === "up" ? -1 : 1,
      );
      this.refresh();
      return;
    }
    const mention = menu.length > 0 ? [] : this.mentionEntries();
    if (mention.length > 0 && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      this.view = moveMentionSelection(
        this.view,
        this.textBeforeCursor(),
        this.mentionIndex,
        key.name === "up" ? -1 : 1,
      );
      this.refresh();
      return;
    }
    const pending = pendingElicitation(this.view);
    if (
      pending !== null &&
      menu.length === 0 &&
      mention.length === 0 &&
      this.routeElicitationKey(key, pending)
    ) {
      return;
    }
    if (
      (key.name === "up" || key.name === "down") &&
      this.navigateHistory(key.name)
    ) {
      key.preventDefault();
      return;
    }
    if (isSubmitKey(key)) {
      // A mention completes into the draft; it never submits it.
      if (mention.length > 0) {
        key.preventDefault();
        const chosen = mention.find((entry) => entry.selected);
        if (chosen !== undefined) this.completeMention(chosen.path);
        return;
      }
      if (menu.length > 0) {
        key.preventDefault();
        this.enqueueInput(() => this.submitDraft(this.now()));
      }
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      this.scrollBy(
        key.name === "pageup"
          ? -this.transcript.height
          : this.transcript.height,
      );
    }
  }

  /** Keys that act on the pending ask. Returns false for a key the composer keeps — text being typed, or Enter on a draft the question cannot take as an answer. Choosing from the list needs an empty draft, so typing a sentence is never mistaken for choosing; ←→ likewise switch questions only while there is no draft for them to move a cursor through, while Tab switches regardless. */
  private routeElicitationKey(
    key: KeyEvent,
    pending: PendingElicitation,
  ): boolean {
    const question = currentQuestion(pending);
    const options = pickerOptions(pending);
    const rows = options.length + (customRowIndex(pending) === null ? 0 : 1);
    const draft = this.textarea.plainText;
    const empty = draft === "";
    if (rows > 0 && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      this.view = moveElicitationSelection(
        this.view,
        key.name === "up" ? -1 : 1,
      );
      this.refresh();
      return true;
    }
    if (
      pending.questions.length > 1 &&
      (key.name === "tab" ||
        (empty && (key.name === "left" || key.name === "right")))
    ) {
      key.preventDefault();
      const backward = key.name === "left" || (key.name === "tab" && key.shift);
      this.view = moveQuestionFocus(this.view, backward ? -1 : 1);
      this.refresh();
      return true;
    }
    if (empty && key.name === "space" && question?.multiSelect === true) {
      key.preventDefault();
      const option = options[pending.selection];
      if (option !== undefined) {
        this.enqueueInput(() => this.answerPending(option.optionId));
      }
      return true;
    }
    if (empty && /^[1-9]$/.test(key.name)) {
      const option = options[Number(key.name) - 1];
      if (option === undefined) return false;
      key.preventDefault();
      this.enqueueInput(() => this.answerPending(option.optionId));
      return true;
    }
    if (!isSubmitKey(key)) return false;
    if (draft.trim() !== "") {
      if (question?.allowCustom !== true) return false;
      key.preventDefault();
      const answer =
        this.secretQuestionKey === null ? draft : this.secretAnswer.join("");
      this.textarea.clear();
      this.secretAnswer = [];
      this.secretCursor = 0;
      this.enqueueInput(() => this.answerPendingText(answer));
      return true;
    }
    if (rows === 0) return false;
    key.preventDefault();
    if (question?.multiSelect === true) {
      this.enqueueInput(() => this.confirmPendingQuestion());
      return true;
    }
    // Enter on the "Other" row with nothing typed has nothing to send; the placeholder already says to type.
    const option = options[pending.selection];
    if (option !== undefined) {
      this.enqueueInput(() => this.answerPending(option.optionId));
    }
    return true;
  }

  private navigateHistory(direction: "up" | "down"): boolean {
    if (direction === "up") {
      if (this.draftHistory.length === 0) return false;
      if (this.historyIndex === null) {
        if (this.textarea.plainText !== "") return false;
        this.historyIndex = this.draftHistory.length - 1;
      } else {
        this.historyIndex = Math.max(0, this.historyIndex - 1);
      }
      this.showHistoryDraft(this.draftHistory[this.historyIndex] ?? "");
      return true;
    }

    if (this.historyIndex === null) return false;
    if (this.historyIndex < this.draftHistory.length - 1) {
      this.historyIndex += 1;
      this.showHistoryDraft(this.draftHistory[this.historyIndex] ?? "");
    } else {
      this.historyIndex = null;
      this.showHistoryDraft("");
    }
    return true;
  }

  private showHistoryDraft(draft: string): void {
    this.textarea.setText(draft);
    this.textarea.cursorOffset = draft.length;
  }

  private enqueueInput(action: () => Promise<void>): void {
    this.inputWork = this.inputWork.then(action).catch((error) => {
      this.inputError ??= error;
    });
  }

  async settleInput(): Promise<void> {
    await this.inputWork;
    if (this.inputError !== null) throw this.inputError;
  }

  async submitDraft(now: string): Promise<void> {
    const draft = this.textarea.plainText;
    if (draft.trim() === "") return;
    const selected = commandMenuEntries(this.view, draft).find(
      (entry) => entry.selected,
    );
    if (selected !== undefined) {
      const query = draft.slice(1).toLowerCase();
      const exact = query === selected.name.toLowerCase();
      if (!exact) {
        const text = `/${selected.name}${selected.command.argumentHint === undefined ? "" : " "}`;
        this.textarea.setText(text);
        this.textarea.cursorOffset = text.length;
        this.view = dismissCommandMenu(this.view, text);
        this.refresh();
        return;
      }
      this.view = dismissCommandMenu(this.view, draft);
    }
    if (exitsAgentUi(draft)) {
      await this.session.close();
      return;
    }
    // /mode is Hive's, not the vendor's: it is a control call rather than a prompt, so it must not reach the journal or be sent as a turn. The boundary matters: without it "/model" reads as "/mode" plus "l".
    const mode = /^\/mode(?:\s+(.*))?$/.exec(draft.trim());
    if (mode !== null) {
      this.textarea.clear();
      await this.applyOrPickPermissionMode(mode[1]?.trim() ?? "");
      return;
    }
    const model = /^\/model(?:\s+(.*))?$/.exec(draft.trim());
    if (
      model !== null &&
      (this.session.listModelCatalog !== undefined ||
        this.session.listModelIds !== undefined)
    ) {
      this.textarea.clear();
      await this.applyOrPickModel(model[1]?.trim() ?? "");
      return;
    }
    const compact = /^\/compact(?:\s+(.*))?$/i.exec(draft.trim());
    if (compact !== null) {
      const command = draft.trim();
      this.draftHistory.push(command);
      this.historyIndex = null;
      this.textarea.clear();
      await this.submitCompaction(command, compact[1]?.trim() ?? "", now);
      return;
    }
    // A command some vendors back with a protocol call rather than prompt parsing runs through that call, including its argument text. Anything the adapter declines stays a prompt, which is the correct invocation for vendors that parse slash commands themselves.
    const vendorCommand = /^\/([^\s/]+)(?:\s+(.*))?$/.exec(draft.trim());
    if (vendorCommand !== null && this.session.runCommand !== undefined) {
      const name = vendorCommand[1] ?? "";
      const argumentsText = vendorCommand[2]?.trim();
      try {
        if (
          await this.session.runCommand({
            vendorSessionId: this.vendorSessionId,
            name,
            ...definedFields({
              arguments:
                argumentsText === undefined || argumentsText === ""
                  ? undefined
                  : argumentsText,
            }),
          })
        ) {
          this.textarea.clear();
          this.refresh();
          return;
        }
      } catch (error) {
        this.textarea.clear();
        this.reportError(`/${name} failed — ${errorMessage(error)}`);
        return;
      }
    }
    const row = await this.journal.append(
      randomUUID(),
      { text: draft, attachments: [] },
      now,
    );
    this.draftHistory.push(draft);
    this.historyIndex = null;
    this.textarea.clear();
    // Insert the prompt immediately; the open turn keeps rendering before it.
    this.view = presentHumanSubmission(
      this.view,
      row.clientInputId,
      row.text,
      "queued",
    );
    this.pendingInputs.push(row);
    this.refresh();
    await this.pump();
  }

  private async submitCompaction(
    command: string,
    argumentsText: string,
    now: string,
  ): Promise<void> {
    if (this.view.foregroundOperation !== null) {
      this.reportError("compaction is already in progress");
      return;
    }
    const invocationId = randomUUID();
    this.view = beginCompaction(this.view, {
      invocationId,
      command,
      requestedAt: now,
      clientInputId: null,
      status: "starting",
    });
    this.refresh();
    this.syncSpinner();

    const advertised = catalogCommand(this.view, "compact") !== null;
    const measured = this.session.capabilities.measured.compact === "supported";
    if (!advertised && !measured) {
      this.view = settleCompaction(this.view, {
        status: "unavailable",
        completedAt: this.now(),
        detail:
          this.session.capabilities.absences?.compact?.reason ??
          `${this.identity.vendorName} does not advertise a compact command`,
      });
      this.refresh();
      this.syncSpinner();
      return;
    }

    if (this.session.runCommand !== undefined) {
      try {
        if (
          await this.session.runCommand({
            vendorSessionId: this.vendorSessionId,
            name: "compact",
            arguments: argumentsText,
          })
        ) {
          this.view = advanceCompaction(this.view, "running");
          this.refresh();
          this.syncSpinner();
          return;
        }
      } catch (error) {
        this.view = settleCompaction(this.view, {
          status: "error",
          completedAt: this.now(),
          detail: errorMessage(error),
        });
        this.refresh();
        this.syncSpinner();
        return;
      }
    }

    const row = await this.journal.append(
      invocationId,
      { text: command, attachments: [], purpose: "compaction" },
      now,
    );
    this.view = bindCompactionInput(
      this.view,
      row.clientInputId,
      canSubmitUser(this.scheduler) ? "starting" : "queued",
    );
    this.pendingInputs.push(row);
    this.refresh();
    this.syncSpinner();
    await this.pump();
  }

  onProviderEvent(event: NormalizedProviderEvent): void {
    const opensElicitation =
      event.kind === "approval-waiting" || event.kind === "question-waiting";
    if (opensElicitation && pendingElicitation(this.view) === null) {
      this.parkDraftForElicitation();
    }
    const base = opensElicitation
      ? closeModePicker(closeModelPicker(this.view))
      : this.view;
    this.view = applyProviderEvent(base, event);
    if (event.kind === "commands-updated") {
      this.view = applyCommandCatalog(
        this.view,
        event.commands,
        this.localCommandSupport(),
      );
    }
    if (
      event.kind === "elicitation-settled" &&
      pendingElicitation(this.view) === null
    ) {
      this.restoreParkedDraft();
    }
    if (
      event.kind === "turn-idle" &&
      this.session.capabilities.measured.compact === "supported" &&
      this.view.foregroundOperation?.providerTurnId === event.turnId
    ) {
      this.view = settleCompaction(this.view, {
        status: "unknown",
        completedAt: event.occurredAt,
        detail: "turn ended without compaction confirmation",
        providerTurnId: event.turnId,
      });
    }
    reportProtocolSessionFacts(this.identity.agentName, event, this.daemonPort);
    if (event.kind === "turn-started") {
      this.turnStartedAt = event.occurredAt;
      this.scheduler = onTurnStarted(this.scheduler, event.turnId);
      this.reportTurnObserved(
        event.clientInputId,
        event.turnId,
        event.sequence,
      );
      this.recordHumanTurnObserved(event.clientInputId, event.turnId);
    }
    if (event.kind === "compacted" && this.loadCompactReload !== undefined) {
      this.pendingCompactReload = true;
      this.requestPump();
    }
    if (
      event.kind === "turn-idle" ||
      event.kind === "turn-failed" ||
      event.kind === "interrupted"
    ) {
      this.scheduler = onTurnBoundary(this.scheduler, event.turnId);
      if (this.pendingCompactReload) this.requestPump();
    }
    this.scheduleRefresh();
    this.syncSpinner();
  }

  private syncSpinner(): void {
    const active = foregroundIsActive(this.view);
    if (active && this.spinnerTimer === null) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerTick += 1;
        this.refresh();
      }, SPINNER_INTERVAL_MS);
    } else if (!active && this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private elapsedActivitySeconds(): number {
    const startedAt =
      this.view.foregroundOperation?.requestedAt ?? this.turnStartedAt;
    if (startedAt === null) return 0;
    const elapsed = (Date.parse(this.now()) - Date.parse(startedAt)) / 1_000;
    return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0;
  }

  /** Answer the pending ask with one of the options it lists. The id is echoed back as sent; nothing here derives one. A vendor that asks several questions at once is answered once, at the end: the choice is recorded and the card moves on until every question has one, because the tool call cannot be settled a question at a time. */
  async answerPending(optionId: string): Promise<void> {
    await this.stepPending(chooseOption(this.view, optionId));
  }

  async confirmPendingQuestion(): Promise<void> {
    await this.stepPending(confirmQuestion(this.view));
  }

  async answerPendingText(answer: string): Promise<void> {
    await this.stepPending(chooseCustomAnswer(this.view, answer));
  }

  private async stepPending(step: PendingStep): Promise<void> {
    if (step.view === this.view) return;
    this.view = step.view;
    this.refresh();
    const pending = pendingElicitation(this.view);
    if (!step.complete || pending === null) return;
    await this.session.respondToPermission(permissionReply(pending));
  }

  async dismissOrInterrupt(): Promise<void> {
    const dismissed = dismissCommandMenu(this.view, this.textarea.plainText);
    if (dismissed !== this.view) {
      this.view = dismissed;
      this.refresh();
      return;
    }
    const mentionDismissed = dismissMentionMenu(
      this.view,
      this.textBeforeCursor(),
      this.mentionIndex,
    );
    if (mentionDismissed !== this.view) {
      this.view = mentionDismissed;
      this.refresh();
      return;
    }
    const pending = pendingElicitation(this.view);
    if (pending !== null) {
      // The vendor's own reject option is what Escape means when one is offered. A question with none is never a reason to interrupt the turn: the agent is waiting for an answer, and abandoning the turn to escape a question is the one thing nobody pressing Escape wants.
      const reject = pickerOptions(pending).find(
        (option) => option.kind === "reject",
      );
      if (reject !== undefined && pending.reply === "option") {
        await this.answerPending(reject.optionId);
        return;
      }
      if (pending.reply === "answers") {
        if (this.textarea.plainText !== "") this.textarea.clear();
        return;
      }
    }
    await this.cancelActiveTurn();
  }

  async respondToPermission(
    requestId: string,
    outcome: "allow" | "deny",
  ): Promise<void> {
    const pending = this.view.transcript.some(
      (entry) =>
        entry.kind === "elicitation" &&
        entry.ask === "approval" &&
        entry.requestId === requestId &&
        !entry.settled,
    );
    if (!pending) return;
    await this.session.respondToPermission({ requestId, outcome });
  }

  private copyToClipboard(selected: string): boolean {
    const escaped = this.renderer.copyToClipboardOSC52(selected);
    const local = this.writeLocalClipboard(selected);
    return escaped || local;
  }

  /** Switch the vendor's permission mode, reporting what it actually applied. A vendor with no such control says so rather than leaving a person to conclude from an unchanged header that the mode did not take. */
  async applyPermissionMode(mode: string): Promise<void> {
    const setMode = this.session.setPermissionMode?.bind(this.session);
    if (setMode === undefined) {
      this.reportError(
        `${this.identity.vendorName} does not support switching permission mode from Hive`,
      );
      return;
    }
    const offered = this.session.permissionModes ?? [];
    if (mode === "" || !offered.includes(mode)) {
      this.reportError(
        `/mode needs one of: ${offered.join(", ") || "a mode this vendor accepts"}`,
      );
      return;
    }
    this.view = setModePickerApplying(this.view, true);
    this.refresh();
    try {
      const applied = await setMode(mode);
      this.view = {
        ...closeModePicker(this.view),
        permissionMode: applied,
      };
      this.refresh();
    } catch (error) {
      this.view = setModePickerApplying(this.view, false);
      this.reportError(
        `permission mode ${mode} was refused — ${errorMessage(error)}`,
      );
    }
  }

  private async cyclePermissionMode(): Promise<void> {
    const modes = this.session.permissionModes ?? [];
    if (modes.length === 0) return;
    const current = this.view.permissionMode;
    const currentIndex = current === null ? -1 : modes.indexOf(current);
    const next = modes[(currentIndex + 1 + modes.length) % modes.length];
    if (next !== undefined) await this.applyPermissionMode(next);
  }

  private async applyOrPickPermissionMode(requested: string): Promise<void> {
    if (requested !== "") {
      await this.applyPermissionMode(requested);
      return;
    }
    if (this.session.setPermissionMode === undefined) {
      this.reportError(
        `${this.identity.vendorName} does not support switching permission mode from Hive`,
      );
      return;
    }
    const modes = this.session.permissionModes ?? [];
    if (modes.length === 0) {
      this.reportError(
        `${this.identity.vendorName} does not advertise any switchable modes`,
      );
      return;
    }
    this.view = openModePicker(this.view, modes, this.view.permissionMode);
    this.refresh();
  }

  private async applyOrPickModel(requested: string): Promise<void> {
    if (requested !== "") {
      const [model, effort] = requested.split(/\s+/);
      if (model !== undefined) await this.applyModel(model, effort);
      return;
    }
    const listModels = this.session.listModelCatalog?.bind(this.session);
    const listIds = this.session.listModelIds?.bind(this.session);
    if (listModels === undefined && listIds === undefined) return;
    let models: readonly ProviderModel[];
    try {
      models =
        listModels !== undefined
          ? await listModels()
          : ((await listIds?.()) ?? []).map((id) => ({
              id,
              displayName: id,
              description: null,
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
            }));
    } catch (error) {
      this.reportError(`model list failed — ${errorMessage(error)}`);
      return;
    }
    if (models.length === 0) {
      this.reportError(
        `${this.identity.vendorName} reports no model catalog to choose from`,
      );
      return;
    }
    const current = this.view.liveModel ?? this.identity.model;
    this.view = openModelPicker(
      this.view,
      models,
      models.some((model) => model.id === current) ? current : null,
      this.view.liveEffort ?? this.identity.effort ?? null,
    );
    this.refresh();
  }

  private async applyModel(model: string, effort?: string): Promise<void> {
    const setModel = this.session.setModel?.bind(this.session);
    if (setModel === undefined) {
      this.reportError(
        `${this.identity.vendorName} does not support switching model from Hive`,
      );
      return;
    }
    this.view = setModelPickerApplying(this.view, true);
    this.refresh();
    try {
      await setModel({
        vendorSessionId: this.vendorSessionId,
        model,
        ...definedFields({ effort }),
      });
      this.view = closeModelPicker({
        ...this.view,
        liveModel: model,
        ...definedFields({ liveEffort: effort }),
      });
      this.refresh();
    } catch (error) {
      this.view = setModelPickerApplying(this.view, false);
      this.reportError(`model ${model} was refused — ${errorMessage(error)}`);
    }
  }

  reportError(message: string): void {
    this.submitDiagnostic("error", message);
  }

  reportWarning(message: string): void {
    this.submitDiagnostic("warning", message);
  }

  /** Render the daemon's canonical event. The pane does not classify, redact,
   * deduplicate, or persist it. */
  renderDiagnostic(
    event: Pick<ObservabilityEvent, "severity" | "reason">,
  ): void {
    this.view = applyDiagnostic(this.view, event.reason, event.severity);
    this.refresh();
  }

  private submitDiagnostic(
    severity: ObservabilitySeverity,
    reason: string,
  ): void {
    if (this.reportDiagnostic === undefined) {
      // Embedded UI tests and the intentionally daemonless fake driver still
      // need a visible diagnostic; production panes always install the daemon
      // reporter and render only its canonical response.
      this.renderDiagnostic({ severity, reason });
      return;
    }
    this.reportDiagnostic({
      severity,
      source: "session",
      operation: "agent-ui",
      reason,
    });
  }

  quotaModel(): string | null {
    const model = this.view.liveModel ?? this.identity.model;
    return model === "—" || model === "default" ? null : model;
  }

  async cancelActiveTurn(): Promise<void> {
    if (this.scheduler.activeTurnId !== null) {
      await this.session.cancel(this.scheduler.activeTurnId);
    }
  }

  async onMailReady(notice: MailReadyNotice): Promise<void> {
    await this.onMailReadyBatch([notice]);
  }

  async onMailReadyBatch(notices: readonly MailReadyNotice[]): Promise<void> {
    const queued: MailReadyNotice[] = [];
    for (const notice of notices) {
      this.scheduler = enqueueWake(this.scheduler, {
        wakeId: notice.wakeId,
        lane: notice.lane,
        oldestItemId: notice.oldestItemId,
        brokerSeq: notice.brokerSeq,
        backlogCount: notice.backlogCount,
      });
      if (this.queuedWake(notice.wakeId)) queued.push(notice);
      this.view = applyMailPhase(
        applyMailNotice(
          this.view,
          notice.lane,
          `${notice.backlogCount} waiting on the ${notice.lane} lane`,
        ),
        "waiting",
      );
    }
    this.scheduleRefresh();
    for (const notice of queued) {
      await this.wakeReports.enqueue(() =>
        this.sendWakeReport({
          kind: "wake-queued",
          schemaVersion: 1,
          wakeId: notice.wakeId,
          recipient: notice.recipient,
          lane: notice.lane,
          oldestItemId: notice.oldestItemId,
          at: this.now(),
        }),
      );
    }
    await this.pump();
  }

  /** Coalesce provider-driven pumps without holding up provider event intake. */
  requestPump(): void {
    if (this.detached) return;
    this.backgroundPumpRequested = true;
    if (this.backgroundPump !== null) return;
    this.backgroundPump = (async () => {
      while (this.backgroundPumpRequested) {
        this.backgroundPumpRequested = false;
        await this.pump();
      }
    })()
      .catch((error) => {
        if (this.detached) return;
        this.reportError(`provider pump failed — ${errorMessage(error)}`);
      })
      .finally(() => {
        this.backgroundPump = null;
        if (!this.detached && this.backgroundPumpRequested) this.requestPump();
      });
  }

  pump(): Promise<void> {
    const pumping = this.pumpTail.then(() => this.pumpOnce());
    this.pumpTail = pumping.catch(() => undefined);
    return pumping;
  }

  private async pumpOnce(): Promise<void> {
    if (this.detached) return;
    await this.wakeReports.drained();
    if (this.detached) return;
    if (canSubmitUser(this.scheduler) && this.pendingInputs.length > 0) {
      const row = this.pendingInputs.shift();
      if (row !== undefined) {
        await this.dispatchInput(row);
        return;
      }
    }
    if (this.textarea.plainText.trim() !== "") return;
    if (canSubmitUser(this.scheduler) && this.pendingCompactReload) {
      this.pendingCompactReload = false;
      await this.dispatchCompactReload();
      return;
    }
    const item = nextItem(this.scheduler);
    if (item === null) return;
    await this.dispatchWake(item);
  }

  private async dispatchInput(row: OutboundRow): Promise<void> {
    if (row.purpose === "user") {
      this.view = presentHumanSubmission(
        this.view,
        row.clientInputId,
        row.text,
      );
    } else {
      this.view = advanceCompaction(this.view, "starting");
    }
    this.refresh();
    let receipt: SubmissionReceipt;
    try {
      receipt = await this.session.submit({
        session: {
          vendorSessionId: this.vendorSessionId,
          replayedHistory: false,
        },
        clientInputId: row.clientInputId,
        text: row.text,
        attachments: row.attachments.map((path) => ({
          path,
          mimeType: null,
        })),
      });
    } catch (error) {
      this.view =
        row.purpose === "user"
          ? settleHumanSubmission(this.view, row.clientInputId, "unknown")
          : settleCompaction(this.view, {
              status: "unknown",
              completedAt: this.now(),
              detail: errorMessage(error),
            });
      this.refresh();
      this.syncSpinner();
      throw error;
    }
    if (row.purpose === "user") {
      this.view = settleHumanSubmission(
        this.view,
        row.clientInputId,
        receipt.outcome === "accepted"
          ? "accepted"
          : receipt.outcome === "rejected"
            ? "rejected"
            : "unknown",
      );
    } else if (receipt.outcome === "accepted") {
      this.view =
        this.session.capabilities.measured.compact === "supported"
          ? advanceCompaction(this.view, "running", receipt.turnId)
          : settleCompaction(this.view, {
              status: "ok",
              completedAt: this.now(),
              completionEvidence: "command",
              providerTurnId: receipt.turnId,
            });
    } else {
      this.view = settleCompaction(this.view, {
        status: receipt.outcome === "rejected" ? "error" : "unknown",
        completedAt: this.now(),
        detail:
          receipt.detail ??
          (receipt.outcome === "rejected"
            ? "provider rejected the compaction command"
            : "delivery could not be confirmed"),
        providerTurnId: receipt.turnId,
      });
    }
    if (receipt.outcome === "accepted") {
      this.scheduler = onSubmissionAccepted(this.scheduler, receipt.turnId);
    }
    await this.journal.setState(
      row.clientInputId,
      receipt.outcome === "accepted"
        ? "submitted"
        : receipt.outcome === "rejected"
          ? "rejected"
          : "delivery_unknown",
    );
    await this.reportReceipt?.(receipt);
    this.refresh();
    this.syncSpinner();
  }

  private async dispatchCompactReload(): Promise<void> {
    const loader = this.loadCompactReload;
    let text: string;
    try {
      text =
        loader === undefined
          ? composeQueenCompactReload({
              boardText: null,
              unavailable: "no compact-reload loader is configured",
            }).text
          : await loader();
    } catch (error) {
      text = composeQueenCompactReload({
        boardText: null,
        unavailable: errorMessage(error),
      }).text;
    }
    text = ensureQueenPin(text);
    const clientInputId = randomUUID();
    const receipt = await this.session.submit({
      session: {
        vendorSessionId: this.vendorSessionId,
        replayedHistory: false,
      },
      clientInputId,
      text,
    });
    if (receipt.outcome === "accepted") {
      this.scheduler = onSubmissionAccepted(this.scheduler, receipt.turnId);
    } else {
      this.reportError(
        `compact reload was not accepted — ${receipt.detail ?? receipt.outcome}`,
      );
    }
    this.refresh();
    this.syncSpinner();
  }

  private async dispatchWake(
    item: Extract<ScheduledItem, { kind: "control-wake" | "work-wake" }>,
  ): Promise<void> {
    this.scheduler = commitDispatch(this.scheduler, item);
    const clientInputId = randomUUID();

    // Fetch wake payload (mail counts + memory delta) from daemon
    const wakeText = await this.buildWakePrompt(item.wake);

    const receipt = await this.session.submit({
      session: {
        vendorSessionId: this.vendorSessionId,
        replayedHistory: false,
      },
      clientInputId,
      text: wakeText,
    });
    if (receipt.outcome === "accepted") {
      this.scheduler = onSubmissionAccepted(this.scheduler, receipt.turnId);
      this.view = applyMailPhase(this.view, "waking");
      // Held until a turn event names this submission. The acknowledgement is the vendor agreeing to run something; only the turn proves it did.
      const acceptedReport = {
        kind: "wake-request-accepted",
        schemaVersion: 1,
        wakeId: item.wake.wakeId,
        clientInputId,
        at: this.now(),
      } as const;
      const accepted = this.wakeReports.enqueue(() =>
        this.sendWakeReport(acceptedReport),
      );
      this.dispatchedWakes.set(clientInputId, {
        wakeId: item.wake.wakeId,
        acceptedReport,
        accepted,
      });
      await accepted;
    } else {
      this.scheduler = enqueueWake(this.scheduler, item.wake);
      this.view = applyMailPhase(this.view, "retrying");
      await this.wakeReports.enqueue(() =>
        this.sendWakeReport(
          receipt.outcome === "rejected"
            ? {
                kind: "wake-failed",
                schemaVersion: 1,
                wakeId: item.wake.wakeId,
                reason: "provider rejected the submission",
                at: this.now(),
              }
            : {
                kind: "wake-delivery-unknown",
                schemaVersion: 1,
                wakeId: item.wake.wakeId,
                clientInputId,
                at: this.now(),
              },
        ),
      );
    }
    this.refresh();
  }

  /** Build wake prompt with mail counts and memory delta from daemon. Falls back to fail-soft prompt (lane + backlogCount, no memory) if daemon is unavailable or fetch fails. */
  private async buildWakePrompt(wake: WakeItem): Promise<string> {
    // If no pane client, use fail-soft prompt (still has lane + backlogCount)
    if (this.paneClient === undefined) {
      return wakePrompt(wake);
    }

    try {
      const request = WakePayloadRequestSchema.parse({
        recipient: this.identity.agentName,
        wakeId: wake.wakeId,
        oldestItemId: wake.oldestItemId,
        lane: wake.lane,
      });

      const response = await this.paneClient.request("/wake-payload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        console.error(
          `wake-payload fetch failed: ${response.status} — using fail-soft prompt`,
        );
        return wakePrompt(wake);
      }

      const payload = WakePayloadSchema.parse(await decodeJson(response));
      return formatWakePrompt(payload);
    } catch (error) {
      console.error(
        `wake-payload build failed: ${errorMessage(error)} — using fail-soft prompt`,
      );
      return wakePrompt(wake);
    }
  }

  private reportTurnObserved(
    clientInputId: string | undefined,
    turnId: string,
    sequence: number,
  ): void {
    if (clientInputId === undefined) return;
    const dispatched = this.dispatchedWakes.get(clientInputId);
    if (dispatched === undefined) return;
    this.dispatchedWakes.delete(clientInputId);
    this.view = applyMailPhase(this.view, "none");
    void this.wakeReports.enqueue(async () => {
      // Replaying the same receipt is not inferring acceptance from the turn. It repairs a predecessor whose response was lost before the lifecycle event is allowed to depend on it.
      const accepted =
        (await dispatched.accepted) ||
        (await this.sendWakeReport(dispatched.acceptedReport));
      if (!accepted) return;
      await this.sendWakeReport({
        kind: "wake-turn-observed",
        schemaVersion: 1,
        wakeId: dispatched.wakeId,
        clientInputId,
        vendorSessionId: this.vendorSessionId,
        eventSequence: sequence,
        turnId,
        turnClientInputId: clientInputId,
        at: this.now(),
      });
      return true;
    });
  }

  private recordHumanTurnObserved(
    clientInputId: string | undefined,
    turnId: string,
  ): void {
    if (clientInputId === undefined) return;
    this.enqueueInput(async () => {
      const row = this.journal
        .all()
        .find((candidate) => candidate.clientInputId === clientInputId);
      if (row?.state === "submitted") {
        await this.journal.setState(clientInputId, "observed", turnId);
      }
    });
  }

  /** Whether the scheduler took this wake rather than refusing it. */
  private queuedWake(wakeId: string): boolean {
    return (
      this.scheduler.controlWakes.some((each) => each.wakeId === wakeId) ||
      this.scheduler.workWake?.wakeId === wakeId
    );
  }

  /** A lost report leaves a gap in the ledger; a thrown one would lose the wake. The submission has already happened by the time anything is reported, so failing the dispatch to preserve its record would trade the thing itself for the note about it. */
  private async sendWakeReport(report: FrontendWakeReport): Promise<boolean> {
    if (this.reportWake === undefined) return false;
    try {
      await this.reportWake(report);
      return true;
    } catch (error) {
      this.reportError(`mail-wake report failed — ${errorMessage(error)}`);
      return false;
    }
  }

  draw(): void {
    this.refresh();
  }

  private syncComposerPresentation(): void {
    this.syncSecretQuestion();
    const pending = pendingElicitation(this.view);
    const question = pending === null ? null : currentQuestion(pending);
    const options = pending === null ? [] : pickerOptions(pending);
    const placeholder =
      pending === null
        ? defaultComposerPlaceholder(this.identity)
        : pending.ask === "approval"
          ? "Choose an approval above…"
          : question?.secret === true
            ? "Private answer (input masked)…"
            : question?.allowCustom === true
              ? options.length > 0
                ? "Type an answer or choose above…"
                : "Type your answer…"
              : "Choose an answer above…";
    if (placeholder !== this.composerPlaceholder) {
      this.composerPlaceholder = placeholder;
      this.textarea.placeholder = placeholder;
    }
    const border =
      pending === null
        ? COLORS.headerEdge
        : pending.ask === "approval"
          ? COLORS.orange
          : COLORS.blue;
    if (border !== this.composerBorder) {
      this.composerBorder = border;
      this.composer.borderColor = border;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 0);
  }

  private refresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.syncComposerPresentation();
    const bannerModel = modelLabel(this.view, this.identity);
    if (this.bannerModel !== bannerModel) {
      this.bannerModel = bannerModel;
      this.bannerText.content = bannerContent(this.view, this.identity);
    }

    const active = foregroundIsActive(this.view);
    const footerRefresh: FooterRefreshSnapshot = {
      runtime: this.view.runtime,
      turn: this.view.turn,
      foregroundOperation: this.view.foregroundOperation,
      mail: this.view.mail,
      attention: this.view.attention,
      contextPercent: this.view.contextPercent,
      liveModel: this.view.liveModel,
      liveEffort: this.view.liveEffort,
      permissionMode: this.view.permissionMode,
      spinnerFrame: active ? this.spinnerTick % SPINNER_FRAMES.length : -1,
      elapsedSeconds: active ? this.elapsedActivitySeconds() : 0,
    };
    if (!sameFooterRefresh(this.footerRefresh, footerRefresh)) {
      this.footerRefresh = footerRefresh;
      this.footerStatus.content = footerStatusContent(
        this.view,
        this.identity,
        footerRefresh.spinnerFrame,
        footerRefresh.elapsedSeconds,
      );
    }

    const footerHintsArmed = this.ctrlCArmedAtMs !== null;
    if (this.footerHintsArmed !== footerHintsArmed) {
      this.footerHintsArmed = footerHintsArmed;
      this.footerHints.content = footerHintsContent(footerHintsArmed);
    }

    if (
      this.transcriptRevision !== this.view.transcript.revision ||
      this.transcriptDetails !== this.view.showToolDetails
    ) {
      const changedStart = this.view.transcript.consumeChangedStart();
      const detailsChanged =
        this.transcriptDetails !== this.view.showToolDetails;
      this.transcriptRevision = this.view.transcript.revision;
      this.transcriptDetails = this.view.showToolDetails;
      this.transcriptView.update(
        this.view.transcript,
        this.view.showToolDetails,
        detailsChanged ? 0 : (changedStart ?? 0),
      );
    }

    const queueWakeCount = pendingWakeCount(this.scheduler);
    if (this.queueWakeCount !== queueWakeCount) {
      this.queueWakeCount = queueWakeCount;
      const queue = queueSummaryLine(queueWakeCount);
      const queueVisible = queue !== "";
      if (this.queueStatus.visible !== queueVisible) {
        this.queueStatus.visible = queueVisible;
      }
      if (this.queueStatus.plainText !== queue) {
        this.queueStatus.content = queue;
      }
    }

    const menuRefresh: MenuRefreshSnapshot = {
      modelPicker: this.view.modelPicker,
      modePicker: this.view.modePicker,
      commands: this.view.commands,
      commandSelection: this.view.commandSelection,
      dismissedCommandQuery: this.view.dismissedCommandQuery,
      transcriptRevision: this.view.transcript.revision,
      mentionIndex: this.mentionIndex,
      mentionSelection: this.view.mentionSelection,
      dismissedMentionQuery: this.view.dismissedMentionQuery,
      draft: this.lastDraft,
      cursorOffset: this.textarea.cursorOffset,
    };
    if (!sameMenuRefresh(this.menuRefresh, menuRefresh)) {
      this.menuRefresh = menuRefresh;
      // One popup panel serves every menu. Modal settings win; then slash commands, which cannot coexist with an @token in the draft.
      const modelPicker = this.view.modelPicker;
      const modePicker = this.view.modePicker;
      const entries =
        modelPicker !== null || modePicker !== null
          ? []
          : commandMenuEntries(this.view, this.lastDraft);
      const visible = visibleCommandEntries(entries);
      const mention =
        modelPicker !== null || modePicker !== null || visible.length > 0
          ? []
          : this.mentionEntriesAt(this.lastDraft, this.textarea.cursorOffset);
      const pickerRows =
        modePicker !== null
          ? modePickerHeight(modePicker)
          : modelPicker === null
            ? 0
            : modelPickerHeight(modelPicker);
      const menuVisible =
        pickerRows > 0 || visible.length > 0 || mention.length > 0;
      const menuHeight = Math.max(
        1,
        Math.max(pickerRows, visible.length, mention.length),
      );
      const menuContent =
        modePicker !== null
          ? modePickerContent(modePicker)
          : modelPicker !== null
            ? modelPickerContent(modelPicker)
            : visible.length > 0
              ? commandMenuContent(entries)
              : mentionMenuContent(mention);
      const menuTitle =
        modePicker !== null
          ? " MODE "
          : modelPicker !== null
            ? modelPicker.stage === "effort"
              ? " REASONING "
              : " MODEL "
            : visible.length > 0
              ? " COMMANDS "
              : " FILES ";
      if (this.menuPanel.visible !== menuVisible) {
        this.menuPanel.visible = menuVisible;
      }
      if (this.menuPanel.height !== menuHeight + 2) {
        this.menuPanel.height = menuHeight + 2;
      }
      if (this.menuPanel.title !== menuTitle) {
        this.menuPanel.title = menuTitle;
      }
      if (this.commands.visible !== menuVisible) {
        this.commands.visible = menuVisible;
      }
      if (this.commands.height !== menuHeight) {
        this.commands.height = menuHeight;
      }
      if (this.commands.content !== menuContent) {
        this.commands.content = menuContent;
      }
    }
  }

  scrollBy(lines: number): void {
    if (
      lines < 0 &&
      this.transcript.scrollTop <= 0 &&
      this.transcriptView.pageEarlier()
    ) {
      this.transcript.scrollTo(this.transcript.scrollHeight);
      return;
    }
    const bottom = Math.max(
      0,
      this.transcript.scrollHeight - this.transcript.height,
    );
    if (
      lines > 0 &&
      this.transcript.scrollTop >= bottom &&
      this.transcriptView.pageLater()
    ) {
      this.transcript.scrollTo(0);
      return;
    }
    this.transcript.scrollBy(lines);
  }

  snapshot() {
    return { draft: this.textarea.plainText, view: this.view };
  }

  detach(): void {
    this.detached = true;
    this.backgroundPumpRequested = false;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.transcriptView.dispose();
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.keyInput.off("paste", this.onPaste);
  }
}
