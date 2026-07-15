import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Worker vendor skills ship with every spawn and are the progressive-disclosure
 * contract for agents that open them. Codex QA at b8135cb found a systematic
 * omission: every operational address said "orchestrator" and none taught queen.
 * These skills must match spawn-prompt wording and David's docs contract:
 * queen is preferred; orchestrator remains a compatibility synonym and
 * architectural role word.
 */
const WORKER_SKILLS = [
  "skills/hive-claude/SKILL.md",
  "skills/hive-codex/SKILL.md",
  "skills/hive-grok/SKILL.md",
] as const;

/** Operational address patterns that must prefer queen (the systematic sweep). */
const OPERATIONAL_QUEEN_MARKERS = [
  "to queen with `hive_send`",
  "report to queen rather than grinding",
  "message queen naming the conflicting files",
  "message queen instead of retrying",
  "hand it to queen",
  "hold from queen",
] as const;

/** Pre-queen operational address phrases that must not reappear. */
const FORBIDDEN_OPERATIONAL_ORCHESTRATOR = [
  "to the orchestrator with `hive_send`",
  "report to the orchestrator rather",
  "message the orchestrator naming",
  "message the orchestrator instead",
  "hand it to the orchestrator",
  "hold from the orchestrator",
  "wait for the orchestrator",
  "report it to the orchestrator",
] as const;

const repoRoot = join(import.meta.dir, "../..");

describe("worker vendor skills name the root queen (systematic)", () => {
  for (const relative of WORKER_SKILLS) {
    test(`${relative}: identity, preferred address, synonym, full operational sweep`, () => {
      const text = readFileSync(join(repoRoot, relative), "utf8");

      // Identity + synonym (architectural role word "orchestrator" is OK here).
      expect(text).toContain("Your orchestrator is named queen");
      expect(text).toContain(
        'synonym "orchestrator" remains accepted for compatibility',
      );
      expect(text).toContain("Address it as queen without quotation marks");

      // Every operational address site from the QA line list.
      for (const marker of OPERATIONAL_QUEEN_MARKERS) {
        expect(text).toContain(marker);
      }

      // Grok-only operational sites (also in the QA line list).
      if (relative.includes("hive-grok")) {
        expect(text).toContain("report it to queen naming the tool");
        expect(text).toContain("Report it to queen with the model and tool name");
        expect(text).toContain("wait for queen");
      }

      for (const forbidden of FORBIDDEN_OPERATIONAL_ORCHESTRATOR) {
        expect(text).not.toContain(forbidden);
      }
    });
  }
});
