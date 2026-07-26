import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Action, Capability, CapabilityStore } from "./capabilities";
import type { HiveDatabase } from "./db";
import { z } from "zod";
import { toolResult } from "./tool-result";

const nothingToLand = (name: string, branch: string | null): Error =>
  new Error(
    `Nothing to land for ${name}: every commit on ${
      branch ?? "its branch"
    } is already on main, so there is no diff to merge.\n` +
      "No re-arm approval was filed — a landing grant is not needed to merge nothing.\n" +
      "Fix: if you have new work, commit it on your branch and land again; otherwise you are done.",
  );

/**
 * The landing tool, with its dependencies named.
 *
 * Seventh and final tool-group extraction out of `createMcpServer` (audit §11).
 * Landing is one tool but its own group: it is the only surface that spends a
 * one-shot credential, so it reaches for the grant decision and the re-arm
 * filing that nothing else touches.
 */
const LandRequestSchema = z.object({
  agent: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative(),
});

const LAND_REARM_NOTE =
  "Hive has already filed the re-arm approval for you — there is no command to run.\n" +
  "Fix: the orchestrator approves that request, which grants exactly one more hive_land.";

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
  landAgent: (
    name: string,
    capabilityEpoch: number,
  ) => Promise<{ commit: string }>;
  decideSpentLandGrant: (
    capability: Capability,
    branch: string | null,
    mayAutoRearm: boolean,
  ) => Promise<"nothing-to-land" | "rearmed" | "ask">;
  fileLandRearmApproval: (subject: string) => void;
}

export function registerLandTool(
  server: McpServer,
  capability: Capability,
  deps: LandToolDeps,
): void {
  server.registerTool(
    "hive_land",
    {
      title: "Land an agent branch",
      description:
        "Land completed writer work through Hive's capability-gated fast-forward. Commit first, rebase the primary checkout's current branch, then rerun the relevant tests and typecheck. Abort and report any rebase conflict; never merge into the primary checkout directly. If the target moved, rebase and retry.",
      inputSchema: LandRequestSchema,
    },
    async ({ agent: name, capabilityEpoch }) => {
      const branch = deps.db.getAgentByName(name)?.branch ?? null;
      try {
        deps.authorizeTool(capability, "hive_land", "branch:land", name);
      } catch (error) {
        // A spent grant is a dead end the caller cannot fix alone (a live
        // agent asked to land follow-up work simply stalls). Measure before
        // spending a human on it: an empty branch needs no grant at all, and a
        // rebased branch with real work re-arms on Hive's own evidence.
        if (error instanceof Error && error.message.includes("already spent")) {
          const outcome = await deps.decideSpentLandGrant(
            capability,
            branch,
            true,
          );
          if (outcome === "nothing-to-land") throw nothingToLand(name, branch);
          if (outcome === "ask") {
            deps.fileLandRearmApproval(capability.subject);
            throw new Error(`${error.message}. ${LAND_REARM_NOTE}`);
          }
          // Re-armed: the one-shot is available again and the land proceeds.
        } else {
          throw error;
        }
      }
      // Reserve the one-shot right before merging, so two concurrent lands
      // cannot both reach git. A lost fast-forward race releases it again:
      // main moved, the writer must rebase, and the retry has to be possible.
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
        // A lost reservation race means another land of this same branch is in
        // flight, so this one is never auto-re-armed — but if that land already
        // merged everything, there is still nothing here to grant.
        if (
          (await deps.decideSpentLandGrant(capability, branch, false)) ===
          "nothing-to-land"
        ) {
          throw nothingToLand(name, branch);
        }
        deps.fileLandRearmApproval(capability.subject);
        throw new Error(
          `The one-shot branch:land grant for ${capability.subject} is already spent. ${LAND_REARM_NOTE}`,
        );
      }
      try {
        return toolResult(
          await deps.landAgent(name, capabilityEpoch),
          "result",
        );
      } catch (error) {
        deps.capabilities.releaseOneShot(capability, "branch:land");
        throw error;
      }
    },
  );
}
