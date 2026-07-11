/**
 * The skills Hive ships to a user's machine.
 *
 * Ship-vs-dev is decided by directory, and this file is the whole seam:
 * `skills/` ships, everything under `.hive/skills/` and `.claude/skills/` is
 * Hive's own development kit and must never reach a stranger's disk. The rule
 * is enforceable rather than aspirational because Hive is distributed as a
 * `bun build --compile` binary (src/release/build.ts) — only what `src/cli.ts`
 * imports exists on a user's machine. There is no repo out there to read from.
 *
 * So a shipped skill has to be *inside* the binary, and the import attribute
 * below is what puts it there: `with { type: "text" }` inlines the file's
 * contents into the bundle as a string literal. Adding a skill means adding an
 * import here — a skill that nobody imports is a skill nobody ships, and
 * `shipped.test.ts` fails when this list and `skills/` disagree.
 */
import hiveClaude from "../../skills/hive-claude/SKILL.md" with { type: "text" };
import hiveCodex from "../../skills/hive-codex/SKILL.md" with { type: "text" };
import karpathyGuidelines from "../../skills/karpathy-guidelines/SKILL.md" with {
  type: "text",
};
import type { SkillTool } from "../adapters/skills";

export interface ShippedSkill {
  /** Directory name, and the `name` in the skill's own frontmatter. */
  name: string;
  /** Verbatim SKILL.md, inlined into the binary at build time. */
  content: string;
  /** The CLIs this skill is for. Claude Code and Codex read from different
   * directories and Hive's two harness skills speak to one vendor each, so a
   * skill says who it is for rather than landing everywhere. */
  tools: SkillTool[];
}

export const SHIPPED_SKILLS: readonly ShippedSkill[] = [
  { name: "hive-claude", content: hiveClaude, tools: ["claude"] },
  { name: "hive-codex", content: hiveCodex, tools: ["codex"] },
  {
    name: "karpathy-guidelines",
    content: karpathyGuidelines,
    tools: ["claude", "codex"],
  },
];

/** The shipped skills a given CLI should be given. */
export function shippedSkillsFor(tool: SkillTool): ShippedSkill[] {
  return SHIPPED_SKILLS.filter((skill) => skill.tools.includes(tool));
}
