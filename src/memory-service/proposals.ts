/**
 * P1 #5: Proposals inbox
 *
 * Wire docs/memory-proposals.md from stub into a real inbox path agents/consolidator can append
 * proposals to, and a deterministic read/consume path.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PROPOSALS_FILE = "docs/memory-proposals.md";
const PROPOSAL_MARKER = "## Pending Proposals";

export interface Proposal {
  id: string;
  createdAt: string;
  category: "profile" | "project" | "mistake";
  title: string;
  rationale: string;
  proposedChange: string;
  source: string;
}

export interface ProposalsInbox {
  proposals: Proposal[];
  raw: string;
}

function formatProposal(proposal: Proposal): string {
  return [
    `### ${proposal.id}: ${proposal.title}`,
    "",
    `**Category**: ${proposal.category}`,
    `**Created**: ${proposal.createdAt}`,
    `**Source**: ${proposal.source}`,
    "",
    `**Rationale**: ${proposal.rationale}`,
    "",
    `**Proposed change**:`,
    "",
    "```",
    proposal.proposedChange,
    "```",
    "",
  ].join("\n");
}

export async function readProposals(repoRoot: string): Promise<ProposalsInbox> {
  const proposalsPath = join(repoRoot, PROPOSALS_FILE);

  try {
    const raw = await readFile(proposalsPath, "utf-8");
    const proposals = parseProposals(raw);
    return { proposals, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { proposals: [], raw: "" };
    }
    throw error;
  }
}

function parseProposals(content: string): Proposal[] {
  const proposals: Proposal[] = [];
  const lines = content.split("\n");

  let inPending = false;
  let currentProposal: Partial<Proposal> | null = null;
  let inProposedChange = false;
  let proposedChangeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === PROPOSAL_MARKER) {
      inPending = true;
      continue;
    }

    if (!inPending) continue;

    if (line.startsWith("### ")) {
      if (currentProposal && currentProposal.id) {
        if (inProposedChange) {
          currentProposal.proposedChange = proposedChangeLines
            .join("\n")
            .trim();
        }
        proposals.push(currentProposal as Proposal);
      }

      const match = line.match(/^### ([^:]+): (.+)$/);
      if (match) {
        currentProposal = {
          id: match[1].trim(),
          title: match[2].trim(),
        };
        inProposedChange = false;
        proposedChangeLines = [];
      }
      continue;
    }

    if (currentProposal) {
      if (line.startsWith("**Category**: ")) {
        const category = line
          .replace("**Category**: ", "")
          .trim() as Proposal["category"];
        currentProposal.category = category;
      } else if (line.startsWith("**Created**: ")) {
        currentProposal.createdAt = line.replace("**Created**: ", "").trim();
      } else if (line.startsWith("**Source**: ")) {
        currentProposal.source = line.replace("**Source**: ", "").trim();
      } else if (line.startsWith("**Rationale**: ")) {
        currentProposal.rationale = line.replace("**Rationale**: ", "").trim();
      } else if (line === "**Proposed change**:") {
        inProposedChange = true;
      } else if (
        inProposedChange &&
        line === "```" &&
        proposedChangeLines.length === 0
      ) {
        continue;
      } else if (inProposedChange && line === "```") {
        currentProposal.proposedChange = proposedChangeLines.join("\n").trim();
        inProposedChange = false;
        proposedChangeLines = [];
      } else if (inProposedChange) {
        proposedChangeLines.push(line);
      }
    }
  }

  if (currentProposal && currentProposal.id) {
    if (inProposedChange) {
      currentProposal.proposedChange = proposedChangeLines.join("\n").trim();
    }
    proposals.push(currentProposal as Proposal);
  }

  return proposals;
}

export async function appendProposal(
  repoRoot: string,
  proposal: Proposal,
): Promise<void> {
  const proposalsPath = join(repoRoot, PROPOSALS_FILE);

  let content: string;
  try {
    content = await readFile(proposalsPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      content = [
        "# Hive Memory Proposals",
        "",
        "This file holds consolidator and human proposals for user profile and committed project conventions before review and application to the always-on wake pack.",
        "",
        "**Review policy:** Profile and project layer changes must be review-gated. The consolidator proposes changes by adding them to this file; humans review and manually apply accepted proposals to `~/.hive/profile.md` (user preferences) or committed `docs/` / `AGENTS.md` (project conventions).",
        "",
        "**Status:** This is the single visible list for pending proposals. No silent merges.",
        "",
        "---",
        "",
        PROPOSAL_MARKER,
        "",
        "(empty)",
      ].join("\n");
    } else {
      throw error;
    }
  }

  const markerIndex = content.indexOf(PROPOSAL_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Proposals file missing ${PROPOSAL_MARKER} section`);
  }

  const emptyIndex = content.indexOf("(empty)", markerIndex);
  let insertAfter = markerIndex + PROPOSAL_MARKER.length + 1;
  let prefix = content.slice(0, insertAfter);
  let suffix = content.slice(insertAfter);

  if (emptyIndex !== -1 && emptyIndex < insertAfter + 50) {
    suffix = suffix.replace("(empty)\n", "");
  }

  const formattedProposal = formatProposal(proposal);
  const newContent = prefix + "\n" + formattedProposal + suffix;

  await writeFile(proposalsPath, newContent, "utf-8");
}

export async function removeProposal(
  repoRoot: string,
  proposalId: string,
): Promise<void> {
  const proposalsPath = join(repoRoot, PROPOSALS_FILE);
  const content = await readFile(proposalsPath, "utf-8");

  const lines = content.split("\n");
  const newLines: string[] = [];
  let skipUntilNextSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith(`### ${proposalId}:`)) {
      skipUntilNextSection = true;
      continue;
    }

    if (skipUntilNextSection && line.startsWith("### ")) {
      skipUntilNextSection = false;
    }

    if (!skipUntilNextSection) {
      newLines.push(line);
    }
  }

  let newContent = newLines.join("\n");

  const markerIndex = newContent.indexOf(PROPOSAL_MARKER);
  if (markerIndex !== -1) {
    const afterMarker = newContent.slice(markerIndex + PROPOSAL_MARKER.length);
    if (afterMarker.trim() === "") {
      newContent =
        newContent.slice(0, markerIndex + PROPOSAL_MARKER.length) +
        "\n\n(empty)";
    }
  }

  await writeFile(proposalsPath, newContent, "utf-8");
}

export function generateProposalId(category: string, index: number): string {
  const timestamp = new Date().toISOString().split("T")[0].replace(/-/g, "");
  return `${category}-${timestamp}-${index}`;
}
