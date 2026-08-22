import type { FlatAssignment } from "../schemas/status-envelope";

export interface HandoffCard {
  goal: string;
  constraints: string[];
  mistakeIds: number[];
  files: string[];
  branch?: string;
  worktree?: string;
}

export interface HandoffSynthOptions {
  assignment?: Pick<FlatAssignment, "objective" | "task">;
  mistakesLedger?: string;
  profileRules?: string;
  recentFiles?: string[];
  branch?: string;
  worktree?: string;
}

/**
 * P0: Auto-synthesize handoff card from assignment when durable handoff missing.
 * Extracted from: assignment.objective|task, mistakes+profile constraints, file paths, branch/worktree.
 */
export function synthesizeHandoffCard(
  options: HandoffSynthOptions,
): HandoffCard | null {
  // Fail-closed: require at least assignment objective or task
  if (
    options.assignment === undefined ||
    (options.assignment.objective === undefined &&
      options.assignment.task === undefined)
  ) {
    return null; // Cannot synthesize without assignment
  }
  
  const goal =
    options.assignment.objective ?? options.assignment.task ?? "(No goal)";
  
  // Extract constraints from mistakes + profile
  const constraints: string[] = [];
  if (options.mistakesLedger !== undefined) {
    const mistakeLines = options.mistakesLedger
      .split("\n")
      .filter((line) => line.trim().startsWith("do_not:"))
      .map((line) => line.trim());
    constraints.push(...mistakeLines);
  }
  if (options.profileRules !== undefined) {
    const profileLines = options.profileRules
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(0, 5); // Top 5 profile rules
    constraints.push(...profileLines);
  }
  
  // Extract mistake IDs (E123 format)
  const mistakeIds: number[] = [];
  const mistakePattern = /E(\d+)/g;
  const ledgerText = options.mistakesLedger ?? "";
  for (const match of ledgerText.matchAll(mistakePattern)) {
    mistakeIds.push(Number(match[1]));
  }
  
  // Limit files to ≤3
  const files = (options.recentFiles ?? []).slice(0, 3);
  
  return {
    goal,
    constraints,
    mistakeIds,
    files,
    branch: options.branch,
    worktree: options.worktree,
  };
}

/**
 * P0: Serialize handoff card for injection into wake pack.
 */
export function serializeHandoffCard(card: HandoffCard): string {
  const lines = [
    "# Handoff Card",
    "",
    `## Goal`,
    card.goal,
    "",
  ];
  
  if (card.constraints.length > 0) {
    lines.push("## Constraints");
    for (const constraint of card.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push("");
  }
  
  if (card.mistakeIds.length > 0) {
    lines.push(`## Recent Mistakes: ${card.mistakeIds.map((id) => `E${id}`).join(", ")}`);
    lines.push("");
  }
  
  if (card.files.length > 0) {
    lines.push("## Relevant Files");
    for (const file of card.files) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  
  if (card.branch !== undefined || card.worktree !== undefined) {
    lines.push("## Context");
    if (card.branch !== undefined) {
      lines.push(`- Branch: ${card.branch}`);
    }
    if (card.worktree !== undefined) {
      lines.push(`- Worktree: ${card.worktree}`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}
