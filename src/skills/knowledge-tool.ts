import { z } from "zod";
import type { HiveToolServer } from "../daemon/authorization/mcp-tool-policy";
import type { Action, Capability } from "../schemas/authority";
import { toolResult } from "../shared/mcp-tool-result";
import {
  type KnowledgeIndexEntry,
  knowledgeDigest,
  QUEEN_KNOWLEDGE,
  queenKnowledgeIndex,
  resolveQueenKnowledge,
} from "./knowledge";

/** What hive_knowledge answers, discriminated by kind: the body for a known topic, the index for no topic, and a typed refusal (with the same index) for an unknown one. */
export type KnowledgeResult =
  | {
      kind: "body";
      topic: string;
      skillName: string;
      digest: string;
      body: string;
    }
  | { kind: "index"; entries: KnowledgeIndexEntry[] }
  | {
      kind: "refusal";
      topic: string;
      validTopics: string[];
      fix: string;
      entries: KnowledgeIndexEntry[];
    };

export interface KnowledgeToolDeps {
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

export function registerKnowledgeTool(
  server: HiveToolServer,
  capability: Capability,
  deps: KnowledgeToolDeps,
): void {
  server.registerTool(
    "hive_knowledge",
    {
      title: "Pull a shipped queen skill by topic",
      description:
        "The queen's pull path to the knowledge Hive ships for her. Call with topic=<topic> for the full skill body, its content digest, and its skill name; call with no topic for the index of valid topics and their one-line summaries. An unknown topic returns the same index with a typed refusal naming the valid topics. Orchestrator role only; every other role is refused.",
      inputSchema: z.object({
        topic: z
          .string()
          .min(1)
          .optional()
          .describe(
            'A queen-knowledge topic from the index, e.g. "alignment". Omit for the index.',
          ),
      }),
    },
    async ({ topic }) => {
      deps.authorizeTool(capability, "hive_knowledge", "knowledge:read");
      if (topic === undefined) {
        const index: KnowledgeResult = {
          kind: "index",
          entries: queenKnowledgeIndex(),
        };
        return toolResult(index, "knowledge");
      }
      const resolved = resolveQueenKnowledge(topic);
      if (resolved === null) {
        const validTopics = QUEEN_KNOWLEDGE.map((entry) => entry.topic);
        const refusal: KnowledgeResult = {
          kind: "refusal",
          topic,
          validTopics,
          fix: `Fix: call hive_knowledge with topic=<one of ${validTopics.join(", ")}>`,
          entries: queenKnowledgeIndex(),
        };
        return toolResult(refusal, "knowledge");
      }
      const body: KnowledgeResult = {
        kind: "body",
        topic: resolved.entry.topic,
        skillName: resolved.skill.name,
        digest: knowledgeDigest(resolved.skill.content),
        body: resolved.skill.content,
      };
      return toolResult(body, "knowledge");
    },
  );
}
