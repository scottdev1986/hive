/**
 * P1 #5: Proposal generator for consolidator
 *
 * Generates proposals for profile and project changes based on similar articles
 * and repeated patterns in the memory store.
 */

import type { EpisodicStore } from "./episodic";
import type { ConsolidationCandidate } from "./consolidate";
import { appendProposal, generateProposalId, type Proposal } from "./proposals";
import { discoverMemoryFacts } from "./memory-store";

export interface ProposalGenerationReport {
  generated: number;
  appended: number;
  errors: string[];
}

export async function generateAndAppendProposals(options: {
  repoRoot: string;
  episodic: EpisodicStore;
  similar: ConsolidationCandidate[];
}): Promise<ProposalGenerationReport> {
  const { repoRoot, similar } = options;
  const report: ProposalGenerationReport = {
    generated: 0,
    appended: 0,
    errors: [],
  };

  const proposals: Proposal[] = [];

  for (const candidate of similar.slice(0, 5)) {
    const facts = await discoverMemoryFacts(
      repoRoot,
      candidate.scope as "repo" | "global",
    );
    const older = facts.find((f) => f.id === candidate.olderId);
    const newer = facts.find((f) => f.id === candidate.newerId);

    if (!older || !newer) continue;

    const category = determineCategory(older, newer);
    if (category === null) continue;

    const proposal: Proposal = {
      id: generateProposalId(category, proposals.length + 1),
      createdAt: new Date().toISOString(),
      category,
      title: `Consolidate: ${older.title} and ${newer.title}`,
      rationale: `These articles are similar (cosine ${candidate.score.toFixed(3)}) and may represent repeated patterns or conventions that should be documented.`,
      proposedChange: `Consider merging these articles:\n\nOlder (${older.id}):\n${older.body.slice(0, 200)}...\n\nNewer (${newer.id}):\n${newer.body.slice(0, 200)}...`,
      source: "consolidator",
    };

    proposals.push(proposal);
    report.generated += 1;
  }

  for (const proposal of proposals) {
    try {
      await appendProposal(repoRoot, proposal);
      report.appended += 1;
    } catch (error) {
      report.errors.push(
        `Failed to append proposal ${proposal.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  return report;
}

function determineCategory(
  older: { topic: string; title: string; tags: readonly string[] },
  newer: { topic: string; title: string; tags: readonly string[] },
): "profile" | "project" | "mistake" | null {
  if (older.topic === "pitfalls" || newer.topic === "pitfalls") {
    return "mistake";
  }

  if (older.topic === "preferences" || newer.topic === "preferences") {
    return "profile";
  }

  const projectTopics = [
    "conventions",
    "architecture",
    "patterns",
    "standards",
  ];
  if (
    projectTopics.includes(older.topic) ||
    projectTopics.includes(newer.topic)
  ) {
    return "project";
  }

  return "project";
}
