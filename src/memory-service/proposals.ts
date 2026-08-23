import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoCode } from "../shared/error-message";

const PROPOSALS_FILE = "docs/memory-proposals.md";
const PROPOSAL_MARKER = "## Pending Proposals";
const PROPOSAL_CATEGORIES = ["profile", "project", "mistake"] as const;

export interface Proposal {
  id: string;
  createdAt: string;
  category: (typeof PROPOSAL_CATEGORIES)[number];
  title: string;
  rationale: string;
  proposedChange: string;
  source: string;
}

function parseProposalCategory(value: string): Proposal["category"] | null {
  for (const category of PROPOSAL_CATEGORIES) {
    if (value === category) return category;
  }
  return null;
}

function completeProposal(partial: Partial<Proposal>): Proposal | null {
  if (
    partial.id === undefined ||
    partial.createdAt === undefined ||
    partial.category === undefined ||
    partial.title === undefined ||
    partial.rationale === undefined ||
    partial.proposedChange === undefined ||
    partial.source === undefined
  ) {
    return null;
  }
  return {
    id: partial.id,
    createdAt: partial.createdAt,
    category: partial.category,
    title: partial.title,
    rationale: partial.rationale,
    proposedChange: partial.proposedChange,
    source: partial.source,
  };
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
    if (isErrnoCode(error, "ENOENT")) {
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

  for (const line of lines) {
    if (line.trim() === PROPOSAL_MARKER) {
      inPending = true;
      continue;
    }

    if (!inPending) continue;

    if (line.startsWith("### ")) {
      if (currentProposal !== null) {
        if (inProposedChange) {
          currentProposal.proposedChange = proposedChangeLines
            .join("\n")
            .trim();
        }
        const completed = completeProposal(currentProposal);
        if (completed !== null) proposals.push(completed);
      }

      const match = /^### ([^:]+): (.+)$/.exec(line);
      const id = match?.[1];
      const title = match?.[2];
      if (id !== undefined && title !== undefined) {
        currentProposal = {
          id: id.trim(),
          title: title.trim(),
        };
        inProposedChange = false;
        proposedChangeLines = [];
      }
      continue;
    }

    if (currentProposal) {
      if (line.startsWith("**Category**: ")) {
        const category = parseProposalCategory(
          line.replace("**Category**: ", "").trim(),
        );
        if (category !== null) currentProposal.category = category;
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
      } else if (inProposedChange && line === "```") {
        currentProposal.proposedChange = proposedChangeLines.join("\n").trim();
        inProposedChange = false;
        proposedChangeLines = [];
      } else if (inProposedChange) {
        proposedChangeLines.push(line);
      }
    }
  }

  if (currentProposal !== null) {
    if (inProposedChange) {
      currentProposal.proposedChange = proposedChangeLines.join("\n").trim();
    }
    const completed = completeProposal(currentProposal);
    if (completed !== null) proposals.push(completed);
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
    if (isErrnoCode(error, "ENOENT")) {
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

  for (const line of lines) {
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
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${category}-${timestamp}-${index}`;
}
