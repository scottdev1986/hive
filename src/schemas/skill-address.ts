import { z } from "zod";
import { CAPABILITY_PROVIDERS } from "./capability";
import { ROUTING_CATEGORIES, type RoutingCategory } from "./routing-policy";

/**
 * Who a skill is for.
 *
 * A queen and an agent are not the same reader and never were: the vendor
 * contracts teach "you woke up in a worktree", which is false for a queen, and
 * a queen's own knowledge is noise in a worktree. Before this existed the only
 * axis was vendor, so every skill Hive or a user wrote reached every reader of
 * that vendor and the mismatch was left to the model to notice.
 */
export const SkillRoleSchema = z.enum(["queen", "agent"]);
export type SkillRole = z.infer<typeof SkillRoleSchema>;
export const SKILL_ROLES = SkillRoleSchema.options;

/** A role Hive has no branch for — the `unknownVendor` contract, for roles: a
 * new role becomes a compile error at every dispatch site rather than a
 * plausible answer computed for the wrong reader. */
export function unknownRole(role: never, site: string): never {
  throw new Error(
    `${site}: unknown skill role ${JSON.stringify(role)}; Hive knows ${SKILL_ROLES.join(
      " and ",
    )}`,
  );
}

/**
 * The routing categories that name a directory.
 *
 * `default` is excluded and must stay excluded: it is the user-authored
 * fallback *chain* consulted when a category has none, not a task an agent is
 * ever spawned under. A `default/` bucket would be a directory that looks
 * addressable and reaches nobody.
 */
export const SKILL_CATEGORY_BUCKETS: readonly RoutingCategory[] =
  ROUTING_CATEGORIES.filter((category) => category !== "default");

/**
 * The directory names that are buckets rather than skills, at one level of one
 * role's tree. A name in here can never be a skill, so this is also the list of
 * names a user cannot call a skill at that level.
 *
 * Levels differ, deliberately: a category addresses what an agent was spawned
 * to do, and a queen is spawned under no category at all, so `planning` is a
 * bucket under `agent/` and an ordinary skill name under `queen/`.
 */
export function skillBucketNames(
  role: SkillRole,
  level: "role" | "vendor",
): readonly string[] {
  switch (role) {
    case "queen":
      return level === "role" ? CAPABILITY_PROVIDERS : [];
    case "agent":
      return level === "role"
        ? [...CAPABILITY_PROVIDERS, ...SKILL_CATEGORY_BUCKETS]
        : SKILL_CATEGORY_BUCKETS;
    default:
      return unknownRole(role, "skill bucket names");
  }
}
