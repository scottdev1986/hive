import { createHash } from "node:crypto";
import { SHIPPED_SKILLS, type ShippedSkill } from "./shipped";

export interface QueenKnowledgeEntry {
  /** The name the queen asks for: hive_knowledge topic="memory". */
  topic: string;
  /** The SHIPPED_SKILLS entry that holds the body. */
  skillName: string;
  /** One line, rendered in both the tool's index and the queen policy's skill index. */
  summary: string;
  /** This registry is the queen's pull path; an agent's skills already reach its worktree by provisioning, so an agent entry here would be a second door to something it already has. */
  roles: readonly ["queen"];
}

export const QUEEN_KNOWLEDGE: readonly QueenKnowledgeEntry[] = [
  {
    topic: "alignment",
    skillName: "hive-alignment",
    summary: "align with the user before delegating any work",
    roles: ["queen"],
  },
  {
    topic: "memory",
    skillName: "hive-memory",
    summary: "compile immutable observations into canonical repo knowledge",
    roles: ["queen"],
  },
  {
    topic: "worktree-lifecycle",
    skillName: "hive-worktree-lifecycle",
    summary: "decide worktree teardown, preservation, salvage, and release",
    roles: ["queen"],
  },
  {
    topic: "escalation",
    skillName: "hive-escalation",
    summary: "adjudicate a CAPABILITY ESCALATION: upgrade or decline, promptly",
    roles: ["queen"],
  },
  {
    topic: "dispatch",
    skillName: "hive-dispatch",
    summary: "decide reuse-vs-spawn and which category a new task gets",
    roles: ["queen"],
  },
  {
    topic: "mail-discipline",
    skillName: "hive-mail-discipline",
    summary: "poll/claim/settle protocol, lanes, and what publishing proves",
    roles: ["queen"],
  },
  {
    topic: "landing",
    skillName: "hive-landing",
    summary: "when to spawn an integrator and what a landing refusal means",
    roles: ["queen"],
  },
  {
    topic: "succession",
    skillName: "hive-succession",
    summary: "checkpoint timing and what a backup-generation boot must do",
    roles: ["queen"],
  },
  {
    topic: "board-conventions",
    skillName: "hive-board-conventions",
    summary:
      "task stories, state transitions, and where rulings and evidence live",
    roles: ["queen"],
  },
];

/** The entry for a topic with its shipped body resolved, or null when the topic names nothing the queen has. A registry entry pointing at an unshipped skill is a bug the agreement test catches; the throw keeps the same disagreement loud at runtime instead of serving a missing body. */
export function resolveQueenKnowledge(
  topic: string,
): { entry: QueenKnowledgeEntry; skill: ShippedSkill } | null {
  const entry = QUEEN_KNOWLEDGE.find((candidate) => candidate.topic === topic);
  if (entry === undefined) return null;
  const skill = SHIPPED_SKILLS.find(
    (candidate) => candidate.name === entry.skillName,
  );
  if (skill === undefined) {
    throw new Error(
      `queen-knowledge topic ${entry.topic} names unshipped skill ${entry.skillName}`,
    );
  }
  return { entry, skill };
}

/** A shipped body's digest in the `sha256:<hex>` form the hierarchy schemas use, so a caller can tell whether the body it holds is still the body Hive ships without re-pulling it. */
export function knowledgeDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** One row of the knowledge index: what a topic is called and what it is for. */
export interface KnowledgeIndexEntry {
  topic: string;
  summary: string;
}

/** The topic+summary pairs both index surfaces render: the tool's no-topic answer and the queen policy's skill index. */
export function queenKnowledgeIndex(): KnowledgeIndexEntry[] {
  return QUEEN_KNOWLEDGE.map((entry) => ({
    topic: entry.topic,
    summary: entry.summary,
  }));
}

/** The queen policy's skill-index section, one line per entry, each naming its own pull path. Rendered here from the registry so the policy cannot drift from what hive_knowledge serves. */
export const QUEEN_KNOWLEDGE_INDEX = [
  "Skills shipped for you — load a full body with hive_knowledge topic=<topic>:",
  ...QUEEN_KNOWLEDGE.map(
    (entry) =>
      `- ${entry.topic} — ${entry.summary} (hive_knowledge topic=${entry.topic})`,
  ),
].join("\n");
