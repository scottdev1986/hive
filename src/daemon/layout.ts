import {
  computeLayout,
  type Frame,
  type LayoutOptions,
} from "../adapters/layout";
import { readScreenFrame, type ScreenFrameReader } from "../adapters/screen";
import {
  setTerminalBounds,
  type TerminalBoundsSetter,
} from "../adapters/terminal";
import type { AgentRecord, TerminalHandle } from "../schemas";
import type { HiveDatabase } from "./db";

export interface LayoutCoordinator {
  requestLayout(): void;
}

const LIVE_STATUSES: ReadonlySet<AgentRecord["status"]> = new Set([
  "spawning",
  "working",
  "idle",
  "awaiting-approval",
  "stuck",
]);

export interface TerminalLayoutManagerOptions {
  db: Pick<HiveDatabase, "listAgents" | "getOrchestratorTerminal">;
  enabled: boolean;
  setBounds?: TerminalBoundsSetter;
  readScreen?: ScreenFrameReader;
  layoutOptions?: Partial<LayoutOptions>;
  logError?: (message: string) => void;
}

/**
 * Re-tiles the hive window wall whenever the set of tracked viewers changes.
 *
 * Triggers are fire-and-forget and coalesce: a request that arrives while a
 * pass is running schedules exactly one follow-up pass over the then-current
 * state, so bursts of spawns or kills settle into a single final layout.
 * Every window move is best-effort — a vanished window (or a user who closed
 * a viewer by hand) never blocks the rest of the wall.
 */
export class TerminalLayoutManager implements LayoutCoordinator {
  private readonly db: TerminalLayoutManagerOptions["db"];
  private readonly enabled: boolean;
  private readonly setBounds: TerminalBoundsSetter;
  private readonly readScreen: ScreenFrameReader;
  private readonly layoutOptions: Partial<LayoutOptions>;
  private readonly logError: (message: string) => void;
  private inFlight: Promise<void> | null = null;
  private pending = false;

  constructor(options: TerminalLayoutManagerOptions) {
    this.db = options.db;
    this.enabled = options.enabled;
    this.setBounds = options.setBounds ?? setTerminalBounds;
    this.readScreen = options.readScreen ?? readScreenFrame;
    this.layoutOptions = options.layoutOptions ?? {};
    this.logError = options.logError ??
      ((message) => console.error(message));
  }

  requestLayout(): void {
    if (!this.enabled) {
      return;
    }
    this.pending = true;
    if (this.inFlight === null) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
  }

  /** Await the completion of every pass requested so far. */
  async settled(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      this.pending = false;
      try {
        await this.applyOnce();
      } catch (error) {
        this.logError(
          `hive layout failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
  }

  private async applyOnce(): Promise<void> {
    const orchestratorHandle = this.db.getOrchestratorTerminal();
    const workerHandles = this.db.listAgents()
      .filter((agent) =>
        LIVE_STATUSES.has(agent.status) && agent.terminalHandle !== undefined
      )
      .map((agent) => agent.terminalHandle as TerminalHandle);
    if (orchestratorHandle === null && workerHandles.length === 0) {
      return;
    }

    const screen = await this.readScreen();
    const layout = computeLayout(
      screen,
      workerHandles.length,
      orchestratorHandle !== null,
      this.layoutOptions,
    );

    if (orchestratorHandle !== null && layout.orchestrator !== null) {
      await this.applyBounds(orchestratorHandle, layout.orchestrator);
    }
    for (const [index, handle] of workerHandles.entries()) {
      const frame = layout.workers[index];
      if (frame !== undefined) {
        await this.applyBounds(handle, frame);
      }
    }
  }

  private async applyBounds(
    handle: TerminalHandle,
    frame: Frame,
  ): Promise<void> {
    try {
      await this.setBounds(handle, frame);
    } catch (error) {
      this.logError(
        `hive layout: could not position a ${handle.app} window: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}
