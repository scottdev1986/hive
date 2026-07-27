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

import hiveClaude from "../../skills/agent/claude/hive-claude/SKILL.md" with {
  type: "text",
};
import codeReview from "../../skills/agent/code_review/code-review/SKILL.md" with {
  type: "text",
};
import hiveCodex from "../../skills/agent/codex/hive-codex/SKILL.md" with {
  type: "text",
};
import hiveGrok from "../../skills/agent/grok/hive-grok/SKILL.md" with {
  type: "text",
};
import hiveMemory from "../../skills/agent/hive-memory/SKILL.md" with {
  type: "text",
};
import karpathyGuidelines from "../../skills/agent/karpathy-guidelines/SKILL.md" with {
  type: "text",
};
import hiveKimi from "../../skills/agent/kimi/hive-kimi/SKILL.md" with {
  type: "text",
};
import hiveOpencode from "../../skills/agent/opencode/hive-opencode/SKILL.md" with {
  type: "text",
};
import hiveAlignment from "../../skills/queen/hive-alignment/SKILL.md" with {
  type: "text",
};
import type { SkillAudience, SkillTool } from "../adapters/skills";
import { CAPABILITY_PROVIDERS } from "../schemas/capability";
import type { RoutingCategory } from "../schemas/routing-policy";
import { SKILL_ROLES, type SkillRole } from "../schemas/skill-address";

export interface ShippedSkill {
  /** Directory name, and the `name` in the skill's own frontmatter. */
  name: string;
  /** Verbatim SKILL.md, inlined into the binary at build time. */
  content: string;
  /** The CLIs this skill is for. Claude Code and Codex read from different
   * directories and Hive's two harness skills speak to one vendor each, so a
   * skill says who it is for rather than landing everywhere. */
  tools: SkillTool[];
  /** The readers this skill is for. The vendor contracts teach a worktree an
   * agent is standing in and a queen never is; a queen reading one is being
   * told she is somewhere she is not. */
  roles: SkillRole[];
  /** The task categories this skill is for, when it speaks to some and not
   * others. Absent means every category — the common case, and not the same
   * claim as listing all of them. */
  categories?: RoutingCategory[];
}

export const SHIPPED_SKILLS: readonly ShippedSkill[] = [
  {
    name: "hive-claude",
    content: hiveClaude,
    tools: ["claude"],
    roles: ["agent"],
  },
  {
    name: "hive-codex",
    content: hiveCodex,
    tools: ["codex"],
    roles: ["agent"],
  },
  { name: "hive-grok", content: hiveGrok, tools: ["grok"], roles: ["agent"] },
  { name: "hive-kimi", content: hiveKimi, tools: ["kimi"], roles: ["agent"] },
  {
    name: "hive-opencode",
    content: hiveOpencode,
    tools: ["opencode"],
    roles: ["agent"],
  },
  // "Every vendor" is spelled as the union, not a hand-typed list, so a new
  // vendor's agents receive the all-vendor skills without anyone remembering
  // this file exists. "Every role" is spelled the same way, for the same
  // reason.
  {
    name: "hive-memory",
    content: hiveMemory,
    tools: [...CAPABILITY_PROVIDERS],
    roles: [...SKILL_ROLES],
  },
  // The queen's, and only hers: it governs the conversation she has with the
  // user before any agent exists. An agent already holds a scoped task and has
  // nobody to align with, so this would be pure context cost in a worktree.
  {
    name: "hive-alignment",
    content: hiveAlignment,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  // Coding guidance, and the queen writes no implementation code — her brief
  // forbids it. Agents only.
  {
    name: "karpathy-guidelines",
    content: karpathyGuidelines,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["agent"],
  },
  // Any vendor can be assigned a cross-vendor review, so every vendor gets it —
  // but only an agent actually spawned to review one. The skill's own first
  // line is "The orchestrator spawned you with category `code_review`", which
  // is a claim the category address now enforces instead of asserting.
  {
    name: "code-review",
    content: codeReview,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["agent"],
    categories: ["code_review"],
  },
];

/**
 * Where one shipped skill installs, relative to a skills root — the same
 * addresses the user writes by hand under `.hive/skills`.
 *
 * Derived from the fields that decide who receives it, never from the source
 * path, so `skills/` and `.hive/skills/` cannot drift into disagreeing about
 * what a directory means. A skill addressed to every vendor gets no vendor
 * segment, because `agent/` already reaches all of them and listing five
 * vendors would say the same thing five times — and would stop being true the
 * day a sixth arrives.
 *
 * More than one address is normal: `hive-memory` is the queen's and an agent's
 * alike, and the grammar has no way to say "both" in one directory, so it
 * installs to both. That is also why the source tree under `skills/` holds each
 * skill exactly once, at one of its addresses, rather than a copy per address.
 */
export function shippedSkillAddresses(skill: ShippedSkill): string[] {
  const everyVendor = CAPABILITY_PROVIDERS.every((vendor) =>
    skill.tools.includes(vendor),
  );
  const vendors = everyVendor ? [null] : skill.tools;
  const addresses: string[] = [];
  for (const role of skill.roles) {
    // A queen is spawned under no category, so a category segment under
    // `queen/` would address a reader that cannot exist.
    const categories =
      role === "queen" || skill.categories === undefined
        ? [null]
        : skill.categories;
    for (const vendor of vendors) {
      for (const category of categories) {
        addresses.push(
          [role, vendor, category].filter((part) => part !== null).join("/"),
        );
      }
    }
  }
  return [...new Set(addresses)];
}

/**
 * The shipped skills one audience should be given.
 *
 * A skill with no `categories` is for every category *including none*: an agent
 * spawned without one still gets the general skills, and gets no
 * category-addressed skill at all, because there is no category it was sent to
 * work under.
 */
export function shippedSkillsFor(audience: SkillAudience): ShippedSkill[] {
  const category = audience.role === "agent" ? audience.category : undefined;
  return SHIPPED_SKILLS.filter(
    (skill) =>
      skill.tools.includes(audience.tool) &&
      skill.roles.includes(audience.role) &&
      (skill.categories === undefined ||
        (category !== undefined && skill.categories.includes(category))),
  );
}
