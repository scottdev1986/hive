import { z } from "zod";
import {
  SessionLocatorSchema,
  TerminalHostProcessIdentitySchema,
  type SessionLocator,
} from "../../schemas/session-protocol";
import type { HiveTerminalPolicy } from "./hive-terminal-host";
import type { VisibilitySourceIdentity } from "./terminal-host-visibility-contract";

const PositiveRevisionSchema = z.string().regex(/^[1-9][0-9]*$/);

export const WorkspaceTerminalStateSchema = z.enum([
  "pending",
  "attaching",
  "live",
  "reconnecting",
  "closing",
  "exited",
  "failed",
]);
export type WorkspaceTerminalState = z.infer<typeof WorkspaceTerminalStateSchema>;

export const WorkspaceVisibleTerminalSchema = z.strictObject({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  locator: SessionLocatorSchema.unwrap().extend({
    hostKind: z.literal("sessiond"),
  }).readonly().refine(
    (locator) => locator.subject.kind === "agent",
    "workspace visibility records require an agent sessiond locator",
  ),
  state: WorkspaceTerminalStateSchema,
}).readonly();
export type WorkspaceVisibleTerminal = z.infer<typeof WorkspaceVisibleTerminalSchema>;

export const WorkspaceVisibilitySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({
    sessionId: z.string().min(1),
    process: TerminalHostProcessIdentitySchema,
  }).readonly(),
  inventoryRevision: PositiveRevisionSchema,
  terminals: z.array(WorkspaceVisibleTerminalSchema).readonly(),
}).readonly();
export type WorkspaceVisibilitySnapshot = z.infer<
  typeof WorkspaceVisibilitySnapshotSchema
>;

export const WorkspaceVisibilityInventoryInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inventoryRevision: PositiveRevisionSchema,
  terminals: z.array(WorkspaceVisibleTerminalSchema).readonly(),
}).readonly();
export type WorkspaceVisibilityInventoryInput = z.infer<
  typeof WorkspaceVisibilityInventoryInputSchema
>;

export type WorkspaceVisibilityPublishResult =
  | Readonly<{ state: "accepted"; inventoryRevision: string }>
  | Readonly<{
      state: "rejected";
      reason:
        | "source-not-live"
        | "source-identity-mismatch"
        | "stale-revision"
        | "duplicate-terminal"
        | "locator-mismatch";
      currentRevision: string | null;
      diagnostic: string;
    }>;

export interface WorkspaceVisibilityDependencies {
  expectedInstanceId: string;
  observeProcess(processId: number): Readonly<{ startToken: string }> | null;
  discoverEngineBuildId(): Promise<string>;
}

export type WorkspaceVisibilityCandidate = Readonly<{
  agentId: string;
  agentName: string;
}>;

export type WorkspaceVisibilityAdmission = Readonly<{
  engineBuildId: string;
  visibility: HiveTerminalPolicy["visibility"];
}>;

const ADMITTING_STATES: ReadonlySet<WorkspaceTerminalState> = new Set([
  "pending",
  "attaching",
  "live",
  "reconnecting",
]);

function locatorKey(locator: SessionLocator): string {
  return `${locator.instanceId}\0${locator.sessionId}\0${locator.generation}`;
}

function sameSource(
  left: VisibilitySourceIdentity,
  right: VisibilitySourceIdentity,
): boolean {
  return left.sessionId === right.sessionId &&
    left.process.processId === right.process.processId &&
    left.process.startToken === right.process.startToken;
}

/**
 * Hive-owned authority for the Workspace's full terminal inventory. Snapshots
 * are volatile on purpose: after a daemon restart the live Workspace must
 * re-attest its whole UI model before any create or renewal is admitted.
 */
export class WorkspaceVisibilityAuthority {
  private current: WorkspaceVisibilitySnapshot | null = null;

  constructor(private readonly dependencies: WorkspaceVisibilityDependencies) {}

  publish(snapshot: WorkspaceVisibilitySnapshot): WorkspaceVisibilityPublishResult {
    const parsed = WorkspaceVisibilitySnapshotSchema.parse(snapshot);
    if (!this.sourceIsLive(parsed.source)) {
      return this.rejected("source-not-live", "workspace process identity is not live");
    }

    const prior = this.current;
    if (prior !== null) {
      if (!sameSource(prior.source, parsed.source)) {
        if (this.sourceIsLive(prior.source)) {
          return this.rejected(
            "source-identity-mismatch",
            "another live Workspace source already owns the inventory",
          );
        }
      } else if (BigInt(parsed.inventoryRevision) <= BigInt(prior.inventoryRevision)) {
        return this.rejected(
          "stale-revision",
          "workspace inventory revision did not advance",
        );
      }
    }

    const locators = new Set<string>();
    const agents = new Set<string>();
    const names = new Set<string>();
    for (const terminal of parsed.terminals) {
      const key = locatorKey(terminal.locator);
      if (locators.has(key) || agents.has(terminal.agentId) || names.has(terminal.agentName)) {
        return this.rejected(
          "duplicate-terminal",
          "workspace inventory contains duplicate terminal ownership",
        );
      }
      if (
        terminal.locator.instanceId !== this.dependencies.expectedInstanceId ||
        terminal.locator.subject.kind !== "agent" ||
        terminal.locator.subject.agentId !== terminal.agentId ||
        terminal.locator.engineBuildId === null
      ) {
        return this.rejected(
          "locator-mismatch",
          "workspace terminal does not bind the exact Hive agent locator",
        );
      }
      locators.add(key);
      agents.add(terminal.agentId);
      names.add(terminal.agentName);
    }

    this.current = parsed;
    return { state: "accepted", inventoryRevision: parsed.inventoryRevision };
  }

  async prepare(): Promise<Readonly<{ engineBuildId: string }> | null> {
    try {
      const engineBuildId = await this.dependencies.discoverEngineBuildId();
      return engineBuildId.length === 0 ? null : { engineBuildId };
    } catch {
      return null;
    }
  }

  async admit(
    candidate: WorkspaceVisibilityCandidate,
  ): Promise<WorkspaceVisibilityAdmission | null> {
    const snapshot = this.current;
    if (snapshot === null || !this.sourceIsLive(snapshot.source)) return null;
    const matches = snapshot.terminals.filter(
      (terminal) => terminal.agentId === candidate.agentId &&
        terminal.agentName === candidate.agentName,
    );
    if (matches.length !== 1) return null;
    const terminal = matches[0]!;
    if (!ADMITTING_STATES.has(terminal.state)) return null;
    if (
      terminal.locator.subject.kind !== "agent" ||
      terminal.locator.subject.agentId !== candidate.agentId ||
      terminal.locator.engineBuildId === null
    ) return null;

    let engineBuildId: string;
    try {
      engineBuildId = await this.dependencies.discoverEngineBuildId();
    } catch {
      return null;
    }
    if (terminal.locator.engineBuildId !== engineBuildId) return null;
    return {
      engineBuildId,
      visibility: {
        workspaceSessionId: snapshot.source.sessionId,
        workspacePid: snapshot.source.process.processId,
        workspaceStartToken: snapshot.source.process.startToken,
        openTerminalRevision: snapshot.inventoryRevision,
      },
    };
  }

  currentSnapshot(): WorkspaceVisibilitySnapshot | null {
    return this.current;
  }

  private sourceIsLive(source: VisibilitySourceIdentity): boolean {
    try {
      return this.dependencies.observeProcess(source.process.processId)?.startToken ===
        source.process.startToken;
    } catch {
      return false;
    }
  }

  private rejected(
    reason: Extract<WorkspaceVisibilityPublishResult, { state: "rejected" }>["reason"],
    diagnostic: string,
  ): WorkspaceVisibilityPublishResult {
    return {
      state: "rejected",
      reason,
      currentRevision: this.current?.inventoryRevision ?? null,
      diagnostic,
    };
  }
}
