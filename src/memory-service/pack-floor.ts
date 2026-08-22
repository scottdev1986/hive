/**
 * P0: Shared pack floor loaders for HiveSpawner and queen launch
 */

import { join } from "node:path";
import { getHiveHome } from "../daemon/hive-home/home";

/** P0: Load constitution (always-on core principles). */
export function loadConstitution(): string {
  return [
    "# Hive Constitution",
    "",
    "## Core Principles",
    "- Project-agnostic software factory",
    "- Learn from verified mistakes",
    "- Human-approved profile and conventions",
    "- Citation-validation before load-bearing use",
    "- Fail-closed on unimplemented features",
  ].join("\n");
}

/** P0: Load user profile from ~/.hive/profile.md (or explicit empty stub). */
export async function loadProfile(): Promise<string> {
  const profilePath = join(getHiveHome(), "profile.md");
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(profilePath, "utf-8");
    if (content.trim().length > 0) {
      return content;
    }
  } catch {
    // Profile doesn't exist or unreadable
  }
  return "(Profile slot reserved but empty - create ~/.hive/profile.md for personal preferences)";
}

/** P0: Load project documentation from AGENTS.md, CLAUDE.md, or docs/README.md (or explicit empty stub). */
export async function loadProjectDoc(repoRoot: string): Promise<string> {
  const candidates = ["AGENTS.md", "CLAUDE.md", "docs/README.md"];

  for (const candidate of candidates) {
    const candidatePath = join(repoRoot, candidate);
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(candidatePath, "utf8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        const preview = trimmed.slice(0, 2000);
        return `Project documentation from ${candidate}:\n\n${preview}${trimmed.length > 2000 ? "\n\n(truncated)" : ""}`;
      }
    } catch {
      // File missing or unreadable, try next candidate
    }
  }

  return "Project documentation not found. This repository has no AGENTS.md, CLAUDE.md, or docs/README.md.";
}

/** P0: Load recent mistakes from episodic ledger (last N). Returns empty if episodic undefined (CLI context). */
export function loadRecentMistakes(
  episodic:
    | {
        listEvents: () => Array<{
          id: string;
          type: string;
          ts: string;
          summary: string;
        }>;
      }
    | undefined,
): readonly string[] {
  if (episodic === undefined) return [];

  const events = episodic
    .listEvents()
    .filter((e) => e.type === "pitfall" || e.type === "mistake")
    .slice(-10);

  return events.map((event) => {
    const date = event.ts.slice(0, 10);
    return `- E${event.id} (${date}): ${event.summary}`;
  });
}
