import {
  MAIL_WAKE_MAX_ATTEMPTS,
  MAIL_WAKE_MAX_DISPATCHES,
} from "../../schemas/mail-wake";
import type { MailLane } from "../../schemas/mail";

/** A wake as the daemon announced it, before the scheduler has queued it. */
export interface AnnouncedWake {
  readonly wakeId: string;
  readonly lane: MailLane;
  readonly oldestItemId: string;
  readonly brokerSeq: number;
}

export interface WakeItem extends AnnouncedWake {
  readonly heldAcrossTurn: boolean;
}

export type ScheduledItem =
  | { readonly kind: "control-wake"; readonly wake: WakeItem }
  | { readonly kind: "work-wake"; readonly wake: WakeItem };

export interface SchedulerState {
  readonly controlWakes: readonly WakeItem[];
  /** Work wakes coalesce: many waiting items are still one thing to look at. */
  readonly workWake: WakeItem | null;
  readonly activeTurnId: string | null;
  readonly awaitingTurn: boolean;
  readonly lastBoundaryTurnId: string | null;
  /** What each wake has already cost, keyed by wake id. A wake is announced again while its item stays available, so the count is what stops the frontend asking the same agent to poll forever. The budget bounds repeats of one announcement, never the lane: mail published behind a stuck item is announced under that item's wake id too, and arrives with a higher sequence than the one the budget was spent on. */
  readonly wakeAttempts: ReadonlyMap<string, WakeSpend>;
}

interface WakeSpend {
  readonly attempts: number;
  readonly brokerSeq: number;
  readonly dispatches: number;
}

/** Folds an arriving announcement into the one already waiting under its id. The waiting entry is the one that survives, because it is the entry that has been sitting through turns and its held flag is the record of that. Held is therefore the OR of both and never just the survivor's: an announcement that arrives mid-turn has waited even if the entry it merges into had not, and dropping that would let the prompt name an item the turn may have settled. */
function merged(waiting: WakeItem, arriving: WakeItem): WakeItem {
  return {
    ...waiting,
    brokerSeq: isNewerPublish(arriving.brokerSeq, waiting.brokerSeq)
      ? arriving.brokerSeq
      : waiting.brokerSeq,
    heldAcrossTurn: waiting.heldAcrossTurn || arriving.heldAcrossTurn,
  };
}

export const EMPTY_SCHEDULER: SchedulerState = {
  controlWakes: [],
  workWake: null,
  activeTurnId: null,
  awaitingTurn: false,
  lastBoundaryTurnId: null,
  wakeAttempts: new Map(),
};

/** Whether the provider owns a turn right now. The one predicate for "this has to wait": `enqueueWake` marks a wake held by it and `nextItem` refuses by it, so the two cannot drift into disagreeing about what a hold is. */
function turnInFlight(state: SchedulerState): boolean {
  return state.activeTurnId !== null || state.awaitingTurn;
}

export function canSubmitUser(state: SchedulerState): boolean {
  return !turnInFlight(state);
}

/** Whether an announcement carries a publish past the one already granted for. The retry budget turns on this one comparison, so the sequence has to be in the domain the wire actually carries — a positive whole number the mailbox counts with — and not merely a number. Absent fails it, because a missing field compares as neither greater nor less and would read as "not older", disabling the cap. A huge float fails it too, and that one is worse: accepted once it becomes a ceiling no real sequence can pass, which silences the lane exactly as the original defect did. Input that cannot be trusted has to fail onto the cap rather than out of it, in both directions. */
function isNewerPublish(announced: number, granted: number): boolean {
  return (
    Number.isSafeInteger(announced) && announced >= 1 && announced > granted
  );
}

/** Idempotent on wakeId, so a repeated mail-ready costs nothing, and refused once the wake has had its attempts: an item nobody claims after that is the mailbox's problem to escalate, not something to keep interrupting a turn for. Giving up on an announcement is not giving up on the lane. A later publish carries a sequence past the one the budget was granted for, and renews that budget even though the unclaimed item still supplies the id — otherwise one item nobody settles silences every message queued behind it. Renewing rather than granting one dispatch is what keeps a refusal honest: the attempts that follow are retries of THIS announcement, so a submission the provider rejects still leaves the lane owed the wake it never delivered. */
export function enqueueWake(
  state: SchedulerState,
  wake: AnnouncedWake | WakeItem,
): SchedulerState {
  const spent = state.wakeAttempts.get(wake.wakeId);
  // The circuit, which a publish cannot reset. Renewal deliberately forgives attempts, so on its own it would let mail arriving behind a stuck item buy an unbounded number of wakes about that item — every one of them saying the same thing to a recipient that has already ignored it.
  if (spent !== undefined && spent.dispatches >= MAIL_WAKE_MAX_DISPATCHES) {
    return state;
  }
  const renewed = isNewerPublish(
    wake.brokerSeq,
    spent?.brokerSeq ?? Number.NEGATIVE_INFINITY,
  );
  if (
    !renewed &&
    spent !== undefined &&
    spent.attempts >= MAIL_WAKE_MAX_ATTEMPTS
  ) {
    return state;
  }
  const renewedState: SchedulerState = renewed
    ? {
        ...state,
        wakeAttempts: new Map(state.wakeAttempts).set(wake.wakeId, {
          attempts: 0,
          brokerSeq: wake.brokerSeq,
          dispatches: spent?.dispatches ?? 0,
        }),
      }
    : state;
  const queued: WakeItem = {
    wakeId: wake.wakeId,
    lane: wake.lane,
    oldestItemId: wake.oldestItemId,
    brokerSeq: wake.brokerSeq,
    // Sticky: a wake requeued after a refusal has already waited out its turn, and re-reading an idle scheduler here would hand its stale id back.
    heldAcrossTurn:
      ("heldAcrossTurn" in wake && wake.heldAcrossTurn) || turnInFlight(state),
  };
  if (queued.lane === "control") {
    // Already waiting under this id. Take the newer sequence onto the entry that is queued rather than the entry that just arrived: the waiting one carries whether it has been held, and dropping the sequence here would spend a publish the agent was never offered.
    if (state.controlWakes.some((each) => each.wakeId === queued.wakeId)) {
      return {
        ...renewedState,
        controlWakes: renewedState.controlWakes.map((each) =>
          each.wakeId === queued.wakeId ? merged(each, queued) : each,
        ),
      };
    }
    // Held wakes name no item, so they are one lane-level signal rather than a queue; left to accumulate they drain one per turn boundary and spend a turn apiece saying the same thing. Keep the newest and drop the older: an announcement names the lane's oldest available item, so a newer one naming a different item proves the older is no longer available. Newest also means the survivor brings its own retry budget — collapsing into a wake that then exhausted its attempts would strand the rest with it.
    if (queued.heldAcrossTurn) {
      return {
        ...renewedState,
        controlWakes: [
          ...renewedState.controlWakes.filter((each) => !each.heldAcrossTurn),
          queued,
        ],
      };
    }
    return {
      ...renewedState,
      controlWakes: [...renewedState.controlWakes, queued],
    };
  }
  const waiting = renewedState.workWake;
  if (waiting?.wakeId === queued.wakeId) {
    return { ...renewedState, workWake: merged(waiting, queued) };
  }
  return { ...renewedState, workWake: queued };
}

/** Hold new input until the accepted turn appears on the event stream. ACP providers such as Kimi return their receipt after the whole turn. If its boundary already arrived, re-arming the hold would strand every follow-up. */
export function onSubmissionAccepted(
  state: SchedulerState,
  turnId: string | null,
): SchedulerState {
  if (
    turnId !== null &&
    (state.activeTurnId === turnId || state.lastBoundaryTurnId === turnId)
  ) {
    return state;
  }
  return { ...state, awaitingTurn: true };
}

export function onTurnStarted(
  state: SchedulerState,
  turnId: string,
): SchedulerState {
  return { ...state, activeTurnId: turnId, awaitingTurn: false };
}

export function onTurnBoundary(
  state: SchedulerState,
  turnId: string,
): SchedulerState {
  return {
    ...state,
    activeTurnId: null,
    awaitingTurn: false,
    lastBoundaryTurnId: turnId,
  };
}

export function nextItem(state: SchedulerState): ScheduledItem | null {
  if (turnInFlight(state)) return null;

  const control = state.controlWakes[0];
  if (control !== undefined) return { kind: "control-wake", wake: control };

  if (state.workWake !== null) {
    return { kind: "work-wake", wake: state.workWake };
  }
  return null;
}

function countAttempt(
  attempts: ReadonlyMap<string, WakeSpend>,
  wake: WakeItem,
): ReadonlyMap<string, WakeSpend> {
  const spent = attempts.get(wake.wakeId);
  return new Map(attempts).set(wake.wakeId, {
    attempts: (spent?.attempts ?? 0) + 1,
    // The grant is set when a newer publish renews the budget, never here: a dispatch spends an attempt against the announcement it was granted for.
    brokerSeq: spent?.brokerSeq ?? Number.NEGATIVE_INFINITY,
    dispatches: (spent?.dispatches ?? 0) + 1,
  });
}

export function commitDispatch(
  state: SchedulerState,
  item: ScheduledItem,
): SchedulerState {
  switch (item.kind) {
    case "control-wake":
      return {
        ...state,
        controlWakes: state.controlWakes.filter(
          (each) => each.wakeId !== item.wake.wakeId,
        ),
        wakeAttempts: countAttempt(state.wakeAttempts, item.wake),
      };
    case "work-wake":
      return {
        ...state,
        workWake:
          state.workWake?.wakeId === item.wake.wakeId ? null : state.workWake,
        wakeAttempts: countAttempt(state.wakeAttempts, item.wake),
      };
  }
}

export function pendingWakeCount(state: SchedulerState): number {
  return state.controlWakes.length + (state.workWake === null ? 0 : 1);
}
