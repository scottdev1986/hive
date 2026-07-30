import type { HiveDatabase } from "./db";
import type { GraphifyService } from "./graphify-service";
import {
  type ClaudeTelemetryReader,
  clampPct,
  type GraphifyCallCursor,
  type GrokTelemetry,
  type GrokTelemetryReader,
  readGraphifyCalls,
  type TelemetryReader,
  type ToolTelemetry,
} from "./tool-telemetry";
import type { AgentRecord } from "../schemas";
import { unknownVendor } from "../schemas";

/**
 * Everything the telemetry sweep reaches for, named explicitly.
 *
 * `graphifyCalls` is passed by reference because the sweep advances the cursor
 * in place.
 */
export interface ToolTelemetryRefreshDeps {
  db: HiveDatabase;
  graphify: GraphifyService | undefined;
  graphifyCalls: Map<string, GraphifyCallCursor>;
  readClaudeTelemetry: ClaudeTelemetryReader;
  readCodexTelemetry: TelemetryReader;
  readGrokTelemetry: GrokTelemetryReader;
  readLiveModel: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  readGrokLiveModel: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
}

/**
 * Pull each live agent's context% and artifact freshness from its tool's
 * durable files: Claude transcripts and Codex rollouts.
 * Hook traffic carries neither, so this sweep is what keeps the status
 * table's context column true. For a Codex TUI agent the rollout mtime is
 * also the only mid-turn liveness signal — a fresh rollout promotes a
 * stuck "spawning" row to working.
 */
export async function refreshToolTelemetry(
  deps: ToolTelemetryRefreshDeps,
): Promise<void> {
  for (const agent of deps.db.listAgents()) {
    if (
      agent.status === "dead" ||
      agent.status === "done" ||
      agent.status === "failed"
    )
      continue;
    const worktree = agent.worktreePath;
    if (worktree === null || worktree === undefined) continue;
    let telemetry: ToolTelemetry | null = null;
    let claudeContext: number | null = null;
    let grokTelemetry: GrokTelemetry | null = null;
    // The vendor switch sits outside the read's catch: a failed read is
    // routine and skips the agent, but a vendor with no reader is a bug that
    // must be heard — swallowing it would report this agent's context off
    // Codex's rollout parser and call the wrong number telemetry.
    switch (agent.tool) {
      case "claude":
        try {
          claudeContext = (
            await deps.readClaudeTelemetry(worktree, agent.toolSessionId)
          ).contextTokens;
        } catch {
          continue;
        }
        break;
      case "codex":
        try {
          telemetry = await deps.readCodexTelemetry(
            worktree,
            agent.toolSessionId,
          );
        } catch {
          continue;
        }
        break;
      case "grok":
        try {
          grokTelemetry = await deps.readGrokTelemetry(
            worktree,
            agent.toolSessionId,
          );
        } catch {
          continue;
        }
        break;
      case "kimi":
        // No kimi telemetry artifact is wired: the CLI's hooks live only in
        // the operator's global config (which Hive never writes) and no
        // session-transcript reader exists yet, so there is nothing
        // measured to read.
        break;
      case "opencode":
        // opencode's session data lives in a sqlite database with no
        // telemetry reader wired, and its plugins are global-config only.
        break;
      default:
        unknownVendor(agent.tool, "refreshToolTelemetry");
    }
    // Layer-3 graphify adoption count, off the same artifacts. Only when
    // this daemon has a graphify service at all. An unreadable known
    // artifact keeps its measured cursor; no exact session clears it.
    if (deps.graphify !== undefined) {
      const cursor = await readGraphifyCalls(
        agent.tool,
        worktree,
        agent.toolSessionId,
        deps.graphifyCalls.get(agent.id),
      ).catch(() => null);
      if (cursor === null) deps.graphifyCalls.delete(agent.id);
      else deps.graphifyCalls.set(agent.id, cursor);
    }
    // Re-read after the file I/O: hook events may have advanced the row.
    const current = deps.db.getAgentById(agent.id);
    if (
      current === null ||
      current.status === "dead" ||
      current.status === "done" ||
      current.status === "failed"
    )
      continue;
    const updates: Partial<AgentRecord> = {};
    // What each vendor's read *means* for the row, dispatched once. The two
    // arms are not symmetric and must not be written as claude-or-else: what
    // Claude's transcript yields is a token count that still needs a window,
    // and what Codex's rollout yields is a percentage and an mtime. A third
    // vendor has neither until someone measures it, so it gets an arm of its
    // own or it gets a compile error — never Codex's arm by default, which
    // would write a percentage nothing computed.
    switch (current.tool) {
      case "claude": {
        // Claude occupancy: the transcript's measured token count over a
        // measured window — never a guessed denominator. The window is the one
        // the statusline payload carried (contextWindow on the row); when no
        // report has ever carried it, a token count that exceeds 200k is itself
        // proof of the 1M window, because the API served a request no 200k
        // window could hold. With neither, occupancy is unknown and the sweep
        // writes nothing: unlike the codex arm it never records null over a
        // number, because the statusline handler's direct reading may be the
        // only observation there is, and a null contextPct marks an agent
        // ineligible for reuse, so the flicker would not be cosmetic.
        if (claudeContext !== null) {
          const window =
            current.contextWindow ??
            (claudeContext > 200_000 ? 1_000_000 : undefined);
          if (window !== undefined) {
            const pct = clampPct((100 * claudeContext) / window);
            if (pct !== current.contextPct) updates.contextPct = pct;
          }
        }
        // The model the agent is *running*. The statusline handler observes
        // this too, but only for agents whose statusline reports actually
        // arrive — which is a subscriber-only path — so the sweep is what
        // makes it true for everyone. A row nobody corrects is a row
        // `hive status` lies from.
        if (current.worktreePath !== null) {
          const live = await deps
            .readLiveModel(current.worktreePath, current.toolSessionId)
            .catch(() => null);
          if (live !== null && live !== current.liveModel) {
            updates.liveModel = live;
          }
        }
        break;
      }
      case "codex": {
        // Write null observations so stale context values do not stand forever.
        // Unknown is a finding, not the absence of one.
        if (telemetry !== null && telemetry.contextPct !== current.contextPct) {
          updates.contextPct = telemetry.contextPct;
        }
        if (
          !current.writeRevoked &&
          current.status !== "control-paused" &&
          telemetry !== null &&
          telemetry.lastActivityAt !== null &&
          telemetry.lastActivityAt > current.lastEventAt
        ) {
          updates.lastEventAt = telemetry.lastActivityAt;
          if (current.status === "spawning") updates.status = "working";
        }
        break;
      }
      case "grok": {
        // Grok's occupancy is the vendor's own reading, and like the codex
        // arm the sweep records what it observed *including* "nothing": a
        // null that is skipped as "no new information" leaves whatever the
        // row was born with standing forever.
        if (
          grokTelemetry !== null &&
          grokTelemetry.contextPct !== current.contextPct
        ) {
          updates.contextPct = grokTelemetry.contextPct;
        }
        // The turn boundary nothing else reports. Grok drives no lifecycle
        // hooks, so the session's own updates.jsonl is the observable. Its last record
        // says whether a turn is streaming or finished. Unknown
        // (turnCompleted null) writes nothing rather than guessing a state.
        if (
          !current.writeRevoked &&
          current.status !== "control-paused" &&
          current.status !== "awaiting-approval" &&
          grokTelemetry !== null &&
          grokTelemetry.lastActivityAt !== null &&
          grokTelemetry.lastActivityAt > current.lastEventAt
        ) {
          updates.lastEventAt = grokTelemetry.lastActivityAt;
          if (grokTelemetry.turnCompleted === true) updates.status = "idle";
          else if (grokTelemetry.turnCompleted === false) {
            updates.status = "working";
          }
        }
        if (current.worktreePath !== null) {
          const live = await deps
            .readGrokLiveModel(current.worktreePath, current.toolSessionId)
            .catch(() => null);
          if (live !== null && live !== current.liveModel) {
            updates.liveModel = live;
          }
        }
        break;
      }
      case "kimi":
        // No Kimi telemetry artifact is wired.
        break;
      case "opencode":
        break;
      default:
        unknownVendor(current.tool, "refreshToolTelemetry");
    }
    if (Object.keys(updates).length > 0) {
      deps.db.upsertAgent({ ...current, ...updates });
    }
  }
}
