import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Worker vendor skills ship with every spawn and are the progressive-disclosure
 * contract for agents that open them. They must name the preferred root address
 * (queen) and keep the orchestrator synonym — matching spawn-prompt wording and
 * David's docs contract. A regression here re-taught only "orchestrator".
 */
const WORKER_SKILLS = [
  "skills/hive-claude/SKILL.md",
  "skills/hive-codex/SKILL.md",
  "skills/hive-grok/SKILL.md",
] as const;

const repoRoot = join(import.meta.dir, "../..");

describe("worker vendor skills name the root queen", () => {
  for (const relative of WORKER_SKILLS) {
    test(`${relative} prefers queen and keeps the orchestrator synonym`, () => {
      const text = readFileSync(join(repoRoot, relative), "utf8");
      expect(text).toContain("Your orchestrator is named queen");
      expect(text).toContain("to queen with `hive_send`");
      expect(text).toContain('synonym "orchestrator" remains accepted');
      // Must not teach only the old address as the operational destination.
      expect(text).not.toMatch(
        /Send completion reports[\s\S]{0,80}to the orchestrator with `hive_send`/,
      );
    });
  }
});
