import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getHiveHome } from "../hive-home/home";
import { buildMemoryRecallBundle, type MemoryRecallDeps } from "./recall";
import { discoverMemoryFacts, type MemoryFact } from "./memory-store";

export interface WakePackSlot {
  name: string;
  content: string;
  tokens: number;
  floor: boolean; // Never drop if true
}

export interface WakePackCompileOptions {
  repoRoot: string;
  memoryRecallDeps: MemoryRecallDeps;
  query: string;
  handoffCard?: string;
  maxTokens?: number;
}

export interface WakePackResult {
  slots: WakePackSlot[];
  totalTokens: number;
  cap: {
    crossed: boolean;
    omitted: string[];
  };
}

const CONSTITUTION_CONTENT = `# Hive Constitution

## Core Principles
- Project-agnostic software factory
- Learn from verified mistakes
- Human-approved profile and conventions
- Citation-validation before load-bearing use
- Fail-closed on unimplemented features
`;

async function readProfileIfExists(): Promise<string | null> {
  const profilePath = join(getHiveHome(), "profile.md");
  try {
    return await readFile(profilePath, "utf-8");
  } catch {
    return null;
  }
}

async function readProjectConventions(repoRoot: string): Promise<string | null> {
  // Try AGENTS.md, CLAUDE.md, then short docs gotchas
  const candidates = [
    join(repoRoot, "AGENTS.md"),
    join(repoRoot, "CLAUDE.md"),
    join(repoRoot, "docs", "conventions.md"),
  ];
  
  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf-8");
      // Extract short gotchas only (first 500 lines or 10KB)
      const lines = content.split("\n").slice(0, 500);
      return lines.join("\n").slice(0, 10000);
    } catch {
      continue;
    }
  }
  
  return null;
}

async function readMistakesLedger(repoRoot: string, lastN = 10): Promise<string> {
  const ledgerPath = join(repoRoot, ".hive", "memory", "wiki", "mistakes", "ledger.md");
  try {
    const content = await readFile(ledgerPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-lastN).join("\n");
  } catch {
    return "";
  }
}

function estimateTokens(text: string): number {
  // Rough estimate: 4 chars per token
  return Math.ceil(text.length / 4);
}

/**
 * P0: Compile wake pack with floor slots + ordered drop + CAP signals.
 * Floor slots (never dropped): constitution, profile slot, project slot, mistakes, handoff, CAP warning.
 * Index picked via RRF/hybrid (≤30 rows).
 * Ordered drop: graph extras → non-floor mail → extra index rows.
 * Empty store + omit ⇒ CAP CROSSED. Empty store ⇒ explicit empty note.
 */
export async function compileWakePack(
  options: WakePackCompileOptions,
): Promise<WakePackResult> {
  const maxTokens = options.maxTokens ?? 2000;
  const slots: WakePackSlot[] = [];
  
  // Floor slot 1: Constitution (always-on)
  const constitutionContent = CONSTITUTION_CONTENT;
  slots.push({
    name: "constitution",
    content: constitutionContent,
    tokens: estimateTokens(constitutionContent),
    floor: true,
  });
  
  // Floor slot 2: Profile (~/.hive/profile.md or reserved empty stub)
  const profileContent = await readProfileIfExists();
  if (profileContent !== null && profileContent.trim().length > 0) {
    slots.push({
      name: "profile",
      content: profileContent,
      tokens: estimateTokens(profileContent),
      floor: true,
    });
  } else {
    // Reserved empty stub - distinguishable from dropped
    const emptyStub = "(Profile slot reserved but empty - create ~/.hive/profile.md for personal preferences)";
    slots.push({
      name: "profile",
      content: emptyStub,
      tokens: estimateTokens(emptyStub),
      floor: true,
    });
  }
  
  // Floor slot 3: Project conventions (from AGENTS.md/CLAUDE.md/docs or explicit empty stub)
  const projectContent = await readProjectConventions(options.repoRoot);
  if (projectContent !== null && projectContent.trim().length > 0) {
    slots.push({
      name: "project",
      content: `# Project Conventions\n\n${projectContent}`,
      tokens: estimateTokens(projectContent),
      floor: true,
    });
  } else {
    // Explicit empty stub - NOT silent absence
    const emptyStub = "(Project conventions slot: no AGENTS.md, CLAUDE.md, or docs/conventions.md found. Create one for project-specific rules.)";
    slots.push({
      name: "project",
      content: emptyStub,
      tokens: estimateTokens(emptyStub),
      floor: true,
    });
  }
  
  // Floor slot 4: Mistakes ledger last-N
  const mistakesContent = await readMistakesLedger(options.repoRoot);
  if (mistakesContent.trim().length > 0) {
    slots.push({
      name: "mistakes",
      content: `# Recent Mistakes (Last N)\n\n${mistakesContent}`,
      tokens: estimateTokens(mistakesContent),
      floor: true,
    });
  } else {
    const emptyNote = "(Mistakes ledger empty - no verified pitfalls yet)";
    slots.push({
      name: "mistakes",
      content: emptyNote,
      tokens: estimateTokens(emptyNote),
      floor: true,
    });
  }
  
  // Floor slot 5: Handoff card (when spawning specialist)
  if (options.handoffCard !== undefined && options.handoffCard.trim().length > 0) {
    slots.push({
      name: "handoff",
      content: options.handoffCard,
      tokens: estimateTokens(options.handoffCard),
      floor: true,
    });
  }
  
  // Memory index via RRF/hybrid (≤30 rows, floor with CAP when store non-empty)
  const recallBundle = await buildMemoryRecallBundle(
    options.query,
    options.memoryRecallDeps,
    30,
  );
  
  const indexRows = [
    ...recallBundle.pitfalls.map((p) => `[pitfall] ${p.title}`),
    ...recallBundle.articles.map((a) => a.title),
  ];
  
  // Calculate floor budget used so far
  const floorTokens = slots.reduce((sum, slot) => sum + slot.tokens, 0);
  const remainingBudget = maxTokens - floorTokens;
  
  // Fit index rows into remaining budget
  const indexContent: string[] = [];
  let indexTokens = 0;
  let omittedCount = 0;
  
  for (const row of indexRows) {
    const rowTokens = estimateTokens(row);
    if (indexTokens + rowTokens <= remainingBudget) {
      indexContent.push(row);
      indexTokens += rowTokens;
    } else {
      omittedCount++;
    }
  }
  
  // Check if store is non-empty
  const allFacts = [
    ...(await discoverMemoryFacts(options.repoRoot, "repo").catch(() => [] as MemoryFact[])),
    ...(await discoverMemoryFacts(options.repoRoot, "global").catch(() => [] as MemoryFact[])),
  ];
  const storeNonEmpty = allFacts.length > 0;
  
  // Build index slot with CAP warning if needed
  let indexSlotContent = "";
  const capCrossed = storeNonEmpty && omittedCount > 0;
  const storeEmpty = !storeNonEmpty && indexContent.length === 0;
  
  if (storeEmpty) {
    // Explicit empty (not identical to dropped)
    indexSlotContent = "# Memory Index\n\n(Memory store is empty - no articles yet. Use memory_write to record knowledge.)";
  } else if (capCrossed) {
    // CAP CROSSED: non-empty store + omitted rows
    indexSlotContent = `# Memory Index

⚠️ CAP CROSSED: ${omittedCount} ${omittedCount === 1 ? "entry" : "entries"} omitted due to budget. Use memory_search for complete results.

Shown (${indexContent.length}/${indexRows.length}):
${indexContent.join("\n")}`;
  } else {
    // Complete index fits
    indexSlotContent = `# Memory Index

${indexContent.length > 0 ? indexContent.join("\n") : "(No index entries)"}`;
  }
  
  slots.push({
    name: "index",
    content: indexSlotContent,
    tokens: estimateTokens(indexSlotContent),
    floor: true, // Floor: never silent zero when store non-empty
  });
  
  const totalTokens = slots.reduce((sum, slot) => sum + slot.tokens, 0);
  
  return {
    slots,
    totalTokens,
    cap: {
      crossed: capCrossed,
      omitted: capCrossed ? [`${omittedCount} index entries`] : [],
    },
  };
}

/**
 * P0: Seed non-empty pack on first compile.
 * - Project from AGENTS.md/CLAUDE.md/docs (read-only import, do not invent)
 * - Mistakes distilled from verified pitfalls into ledger lines
 * - Profile may be empty
 */
export async function seedWakePack(repoRoot: string): Promise<void> {
  // Check if ledger already exists
  const ledgerPath = join(repoRoot, ".hive", "memory", "wiki", "mistakes", "ledger.md");
  try {
    await readFile(ledgerPath, "utf-8");
    // Ledger exists, skip seeding
    return;
  } catch {
    // Ledger doesn't exist, seed it
  }
  
  // Distill mistakes from verified pitfalls
  const facts = await discoverMemoryFacts(repoRoot, "repo").catch(() => []);
  const verifiedPitfalls = facts.filter(
    (f) => f.kind === "pitfall" && f.status === "verified"
  );
  
  if (verifiedPitfalls.length === 0) {
    // No verified pitfalls to distill
    return;
  }
  
  // Create ledger with last-N distilled lines
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(ledgerPath), { recursive: true });
  
  const ledgerLines = verifiedPitfalls
    .slice(-10)
    .map((p) => `do_not: ${p.title}; verified ${p.verified ?? p.date}; see ${p.id}`)
    .join("\n");
  
  await writeFile(ledgerPath, `# Mistakes Ledger\n\n${ledgerLines}\n`, "utf-8");
}
