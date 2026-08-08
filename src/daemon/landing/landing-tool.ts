import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import { z } from "zod";
import type {
  Action,
  Capability,
  CapabilityStore,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import type { AgentRecord } from "../../schemas/agent";
import {
  classifyNothingToLand,
  type HierarchyLanding,
  type LandReadiness,
  type NothingToLandEvidence,
  NothingToLandError,
  type NothingToLandKind,
  type SpentLandGrantAskReason,
  type SpentLandGrantDecision,
} from "./landing-service";
import type { ProjectGate } from "./project-gate";
import { toolResult } from "../../shared/mcp-tool-result";

const nothingToLand = (
  name: string,
  branch: string | null,
  kind: NothingToLandKind,
  sourceOid: string | null = null,
): NothingToLandError => {
  const label = branch ?? "its branch";
  const detail =
    kind === "already-landed"
      ? `${label} has commits beyond its recorded spawn base, but every one is already on main. The branch's work is already landed; you are done.`
      : kind === "no-commits"
        ? `${label} is still at its recorded spawn base, so it has never held a commit to merge.`
        : `every commit on ${label} is already on main, but Hive has no recorded spawn base that can distinguish previously landed work from a branch that never held work.`;
  const fix =
    kind === "already-landed"
      ? "Fix: do not redo the landed work; only commit and land again if you have new follow-up work."
      : kind === "no-commits"
        ? `Fix: commit your work on ${label}, then land again.`
        : `Fix: inspect ${label}'s history against main before deciding whether work is already delivered or still needs to be committed.`;
  return new NothingToLandError(
    label,
    kind,
    sourceOid,
    `Nothing to land for ${name}: ${detail}\n` +
      "No re-arm approval was filed — a landing grant is not needed to merge nothing.\n" +
      fix,
  );
};

/** The landing tool, with its dependencies named. Seventh and final tool-group extraction out of `createMcpServer` (audit §11). Landing is one tool but its own group: it is the only surface that spends a one-shot credential, so it reaches for the grant decision and the re-arm filing that nothing else touches. */
const LandRequestSchema = z.strictObject({
  agent: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative(),
});

const LAND_REARM_NOTE =
  "Hive has already filed the re-arm approval for you — there is no command to run.\n" +
  "Fix: the orchestrator approves that request, which grants exactly one more hive_land.";

/** The sentence that turns a bare "grant is spent" into a diagnosis. Every caller reaching this spent the grant — that is never the whole story, and naming only it once sent agents to wait on a user when their next step was a rebase. When the target moved, both SHAs go in the message: the main the branch was based on, and the main it found. */
const spentAskDetail = (
  reason: SpentLandGrantAskReason,
  readiness: LandReadiness | null,
): string => {
  switch (reason) {
    case "target-moved": {
      // Reached only when the checkout is attached (detachment is its own reason above), so the target branch has a name and the Fix must use it — never "HEAD", never "the current branch".
      const target = readiness?.targetBranch ?? "the landing target";
      return (
        ` The landing target has also moved: ${target} is now at ${
          readiness?.targetHead ?? "a commit Hive could not read"
        }, which the branch does not contain (its fork point is ${
          readiness?.baseSha ?? "a fork point Hive could not read"
        }), so even a re-armed grant would not fast-forward.` +
        `\nFix: rebase onto ${target}, re-run your gates, then retry hive_land.`
      );
    }
    case "target-detached":
      return (
        ` The primary checkout is detached at ${
          readiness?.targetHead ?? "a commit Hive could not read"
        } — it is not on any branch, so there is no landing target, and the` +
        " branch's relation to main cannot be measured against one. Do not" +
        " rebase onto the checkout's current position: it may be another" +
        " agent's unlanded work." +
        "\nFix: the primary checkout must be restored to its branch first —" +
        " report the detachment to the orchestrator, then retry hive_land."
      );
    case "readiness-unreadable":
      return (
        " Hive could not measure whether the branch is rebased on the primary" +
        " checkout's current branch — its git reads returned no answer, and no" +
        " answer is never a yes — so this one needs a user."
      );
    case "branch-unknown":
      return (
        " No branch is recorded for the agent, so Hive cannot measure landing" +
        " readiness at all."
      );
    case "rearm-budget-exhausted":
      return " The automatic re-arm budget is exhausted, so this one needs a user.";
    case "rearm-not-permitted":
      return "";
  }
};

export interface LandToolDeps {
  db: HiveDatabase;
  capabilities: CapabilityStore;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  projectGate: ProjectGate;
  readNothingToLandEvidence: (
    agent: AgentRecord,
    sourceOid: string | null,
  ) => Promise<NothingToLandEvidence>;
  landAgent: (
    name: string,
    capabilityEpoch: number,
  ) => Promise<{ commit: string; landedCommits: string[] }>;
  /** Hierarchy work lands through the grant-derived promotion engine, not the flat main fast-forward. When this returns a landing, that landing runs instead of landAgent; null means a durable legacy-flat agent. Absent entirely, only the flat path exists. Resolving and landing arrive as one value, so there is no half-wired state to guard against. */
  resolveHierarchyLand?: (agentName: string) => HierarchyLanding | null;
  decideSpentLandGrant: (
    capability: Capability,
    branch: string | null,
    mayAutoRearm: boolean,
  ) => Promise<SpentLandGrantDecision>;
  fileLandRearmApproval: (subject: string) => void;
}

export function registerLandTool(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: LandToolDeps,
): void {
  server.registerTool(
    "hive_land",
    {
      title: "Land an agent branch",
      description:
        "Land completed writer work through Hive's capability-gated fast-forward. Read the agent's current capabilityEpoch from hive_status, commit first, rebase the primary checkout's current branch, then rerun the relevant tests and typecheck. Abort and report any rebase conflict; never merge into the primary checkout directly. If the target moved, rebase and retry.",
      inputSchema: LandRequestSchema,
    },
    async (rawInput) => {
      const { agent: name, capabilityEpoch } =
        LandRequestSchema.parse(rawInput);
      const agent = deps.db.getAgentByName(name);
      const branch = agent?.branch ?? null;
      const classifyNoop = async (
        sourceOid: string | null,
      ): Promise<NothingToLandKind> => {
        if (agent === null) return "unknown";
        const evidence = await deps
          .readNothingToLandEvidence(agent, sourceOid)
          .catch(() => ({ sourceOid, baseOid: null }));
        return classifyNothingToLand(evidence);
      };
      let hierarchy: HierarchyLanding | null | undefined;
      try {
        deps.authorizeTool(capability, "hive_land", "branch:land", name);
      } catch (error) {
        // A spent grant is a dead end the caller cannot fix alone (a live agent asked to land follow-up work simply stalls). Measure before spending a user on it: an empty branch needs no grant at all, and a rebased branch with real work re-arms on Hive's own evidence.
        if (error instanceof Error && error.message.includes("already spent")) {
          hierarchy = deps.resolveHierarchyLand?.(name) ?? null;
          if (hierarchy !== null) {
            deps.fileLandRearmApproval(capability.subject);
            throw new Error(`${error.message}. ${LAND_REARM_NOTE}`);
          }
          const outcome = await deps.decideSpentLandGrant(
            capability,
            branch,
            true,
          );
          if (outcome.kind === "nothing-to-land") {
            throw nothingToLand(name, branch, await classifyNoop(null));
          }
          if (outcome.kind === "ask") {
            deps.fileLandRearmApproval(capability.subject);
            throw new Error(
              `${error.message}.${spentAskDetail(
                outcome.reason,
                outcome.readiness,
              )} ${LAND_REARM_NOTE}`,
            );
          }
          // Re-armed: the one-shot is available again and the land proceeds.
        } else {
          throw error;
        }
      }
      if (hierarchy === undefined) {
        hierarchy = deps.resolveHierarchyLand?.(name) ?? null;
      }
      // Reserve the one-shot right before merging, so two concurrent lands cannot both reach git. A lost fast-forward race releases it again: main moved, the writer must rebase, and the retry has to be possible.
      if (!deps.capabilities.consumeOneShot(capability, "branch:land")) {
        deps.capabilities.audit({
          route: "/mcp:hive_land",
          action: "branch:land",
          callerSubject: capability.subject,
          callerRole: capability.role,
          capabilityId: capability.id,
          requestedSubject: name,
          epoch: capability.epoch,
          decision: "deny",
          reason: "capability.replayed",
        });
        // A lost reservation race means another land of this same branch is in flight, so this one is never auto-re-armed — but if that land already merged everything, there is still nothing here to grant.
        if (
          hierarchy === null &&
          (await deps.decideSpentLandGrant(capability, branch, false)).kind ===
            "nothing-to-land"
        ) {
          throw nothingToLand(name, branch, await classifyNoop(null));
        }
        deps.fileLandRearmApproval(capability.subject);
        throw new Error(
          `Another hive_land call for ${capability.subject} is already in ` +
            "flight and holds the branch:land reservation — the grant is busy, " +
            `not spent. ${LAND_REARM_NOTE}`,
        );
      }
      try {
        if (agent?.worktreePath === null || agent?.worktreePath === undefined) {
          throw new Error(
            `Cannot land ${name}: it has no worktree for the project gate to inspect.`,
          );
        }
        await deps.projectGate(agent.worktreePath);
        // Hierarchy landing accepts only the authority derived by the resolver; caller-supplied flat identity and epoch stay on the legacy path.
        if (hierarchy !== null) {
          return toolResult(await hierarchy.land(), "result");
        }
        return toolResult(
          await deps.landAgent(name, capabilityEpoch),
          "result",
        );
      } catch (error) {
        deps.capabilities.releaseOneShot(capability, "branch:land");
        if (error instanceof NothingToLandError) {
          const kind =
            error.kind === "unknown"
              ? await classifyNoop(error.sourceOid)
              : error.kind;
          throw nothingToLand(name, branch, kind, error.sourceOid);
        }
        throw error;
      }
    },
  );
}
