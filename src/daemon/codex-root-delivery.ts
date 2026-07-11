import { existsSync } from "node:fs";
import { CodexRootProtocolDriver } from "../adapters/tools/codex-app-server";
import { findLatestCodexSessionId } from "../adapters/tools/codex";
// The launcher owns the socket-path derivation; deriving it twice is how the
// daemon ends up probing a socket no root ever bound.
import { codexRootSocketPath } from "../cli/orchestrator";
import type { RootProtocolDeliverer } from "./delivery";

/** The connection surface this module needs from a root protocol driver;
 * CodexRootProtocolDriver satisfies it, tests inject fakes. */
export interface RootProtocolConnection {
  isLive(): boolean;
  deliverMessage(content: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface CodexRootDeliveryDependencies {
  /** Where the codex root's app-server listens. `hive codex` launches
   * `codex app-server --listen unix://<socket>` on this deterministic path,
   * so the socket's existence is the daemon's signal that a codex root is
   * (or recently was) running. */
  socketPath?: () => string;
  /** The root thread to steer. The remote TUI created it in the repo root,
   * so the newest rollout recorded for that cwd names it — the same disk
   * discovery crash recovery uses (SPEC decision 13). */
  discoverThreadId?: () => Promise<string | null>;
  connect?: (
    socketPath: string,
    threadId: string,
  ) => Promise<RootProtocolConnection>;
  socketExists?: (path: string) => boolean;
}

/**
 * Wake path for a Codex root (SPEC decision 1): the daemon attaches to the
 * root's own app-server as a second client, resumes the TUI's thread, and
 * injects a model-visible item — dual-client steering, never a pane paste.
 *
 * The connection is lazy and disposable. A failed connect or delivery simply
 * reports unconfirmed, the message stays durably queued, and
 * `deliverRootViaChannel` falls through to the Claude Channels path — so on a
 * Claude-root machine (no socket) this deliverer is inert, and a stale socket
 * file left by a dead codex root costs one failed connect, not a lost wake.
 */
export class CodexRootDelivery implements RootProtocolDeliverer {
  private driver: RootProtocolConnection | null = null;
  private connecting: Promise<boolean> | null = null;
  private readonly socketPath: () => string;
  private readonly discoverThreadId: () => Promise<string | null>;
  private readonly connect: (
    socketPath: string,
    threadId: string,
  ) => Promise<RootProtocolConnection>;
  private readonly socketExists: (path: string) => boolean;

  constructor(repoRoot: () => string, deps: CodexRootDeliveryDependencies = {}) {
    this.socketPath = deps.socketPath ?? (() => codexRootSocketPath());
    this.discoverThreadId = deps.discoverThreadId ??
      (() => findLatestCodexSessionId(repoRoot()));
    this.connect = deps.connect ??
      ((socket, threadId) => CodexRootProtocolDriver.connect(socket, threadId));
    this.socketExists = deps.socketExists ?? existsSync;
  }

  isLive(): boolean {
    if (this.driver?.isLive() === true) return true;
    // The path derivation may refuse (over-long TMPDIR); an unbuildable
    // socket name means "no codex root here", never a crashed wake.
    try {
      return this.socketExists(this.socketPath());
    } catch {
      return false;
    }
  }

  async deliverMessage(
    content: string,
    _meta: Record<string, string>,
  ): Promise<boolean> {
    if (this.driver === null || !this.driver.isLive()) {
      if (!(await this.ensureConnected())) return false;
    }
    const driver = this.driver;
    if (driver === null) return false;
    const confirmed = await driver.deliverMessage(content).catch(() => false);
    if (!confirmed) await this.dropDriver();
    return confirmed;
  }

  /** Serialized so concurrent wakes share one connect attempt instead of
   * racing two thread resumes onto the same app-server. */
  private ensureConnected(): Promise<boolean> {
    this.connecting ??= (async () => {
      await this.dropDriver();
      let socket: string;
      try {
        socket = this.socketPath();
        if (!this.socketExists(socket)) return false;
      } catch {
        return false;
      }
      const threadId = await this.discoverThreadId().catch(() => null);
      if (threadId === null) return false;
      try {
        this.driver = await this.connect(socket, threadId);
        return this.driver.isLive();
      } catch (error) {
        console.error(
          `Hive could not attach to the codex root app-server at ${socket}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        return false;
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async dropDriver(): Promise<void> {
    const stale = this.driver;
    this.driver = null;
    if (stale !== null) await stale.close().catch(() => undefined);
  }
}
