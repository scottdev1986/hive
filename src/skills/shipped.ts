import hiveClaude from "../../skills/agent/claude/hive-claude/SKILL.md" with { type: "text" };
import codeReview from "../../skills/agent/code_review/code-review/SKILL.md" with { type: "text" };
import hiveCodex from "../../skills/agent/codex/hive-codex/SKILL.md" with { type: "text" };
import hiveGrok from "../../skills/agent/grok/hive-grok/SKILL.md" with { type: "text" };
import hiveMemory from "../../skills/agent/hive-memory/SKILL.md" with { type: "text" };
import karpathyGuidelines from "../../skills/agent/karpathy-guidelines/SKILL.md" with { type: "text" };
import hiveKimi from "../../skills/agent/kimi/hive-kimi/SKILL.md" with { type: "text" };
import hiveOpencode from "../../skills/agent/opencode/hive-opencode/SKILL.md" with { type: "text" };
import hiveAlignment from "../../skills/queen/hive-alignment/SKILL.md" with { type: "text" };
import hiveBoardConventions from "../../skills/queen/hive-board-conventions/SKILL.md" with { type: "text" };
import hiveDispatch from "../../skills/queen/hive-dispatch/SKILL.md" with { type: "text" };
import hiveEscalation from "../../skills/queen/hive-escalation/SKILL.md" with { type: "text" };
import hiveLanding from "../../skills/queen/hive-landing/SKILL.md" with { type: "text" };
import hiveMailDiscipline from "../../skills/queen/hive-mail-discipline/SKILL.md" with { type: "text" };
import hiveSuccession from "../../skills/queen/hive-succession/SKILL.md" with { type: "text" };
import hiveWorktreeLifecycle from "../../skills/queen/hive-worktree-lifecycle/SKILL.md" with { type: "text" };
import type { SkillAudience, SkillTool } from "../adapters/skills";
import { CAPABILITY_PROVIDERS } from "../schemas/capability";
import type { RoutingCategory } from "../schemas/routing-policy";
import { SKILL_ROLES, type SkillRole } from "../schemas/skill-address";

export interface ShippedSkill {
  name: string;
  content: string;
  /** The CLIs this skill is for. Vendors read from different native directories and each Hive vendor contract speaks to one vendor, so a skill says who it is for rather than landing everywhere. */
  tools: SkillTool[];
  /** The readers this skill is for. The vendor contracts teach a worktree an agent is standing in and a queen never is; a queen reading one is being told she is somewhere she is not. */
  roles: SkillRole[];
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
  {
    name: "hive-memory",
    content: hiveMemory,
    tools: [...CAPABILITY_PROVIDERS],
    roles: [...SKILL_ROLES],
  },
  // The queen's, and only hers: it governs the conversation she has with the user before any agent exists. An agent already holds a scoped task and has nobody to align with, so this would be pure context cost in a worktree.
  {
    name: "hive-alignment",
    content: hiveAlignment,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-board-conventions",
    content: hiveBoardConventions,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-dispatch",
    content: hiveDispatch,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-escalation",
    content: hiveEscalation,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-landing",
    content: hiveLanding,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-mail-discipline",
    content: hiveMailDiscipline,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-succession",
    content: hiveSuccession,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "hive-worktree-lifecycle",
    content: hiveWorktreeLifecycle,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["queen"],
  },
  {
    name: "karpathy-guidelines",
    content: karpathyGuidelines,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["agent"],
  },
  {
    name: "code-review",
    content: codeReview,
    tools: [...CAPABILITY_PROVIDERS],
    roles: ["agent"],
    categories: ["code_review"],
  },
];

/** Where one shipped skill installs, relative to a skills root — the same addresses the user writes by hand under `.hive/skills`. Derived from the fields that decide who receives it, never from the source path, so `skills/` and `.hive/skills/` cannot drift into disagreeing about what a directory means. A skill addressed to every vendor gets no vendor segment, because `agent/` already reaches all of them and listing five vendors would say the same thing five times — and would stop being true the day a sixth arrives. More than one address is normal: `hive-memory` is the queen's and an agent's alike, and the grammar has no way to say "both" in one directory, so it installs to both. That is also why the source tree under `skills/` holds each skill exactly once, at one of its addresses, rather than a copy per address. */
export function shippedSkillAddresses(skill: ShippedSkill): string[] {
  const everyVendor = CAPABILITY_PROVIDERS.every((vendor) =>
    skill.tools.includes(vendor),
  );
  const vendors = everyVendor ? [null] : skill.tools;
  const addresses: string[] = [];
  for (const role of skill.roles) {
    // A queen is spawned under no category, so a category segment under `queen/` would address a reader that cannot exist.
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
