import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../src/memory-service/episodic";
import { type MemoryEmbedder } from "../src/memory-service/embeddings";
import {
  incrementRecurrence,
  getRecurrenceCount,
  autoPromoteMistakes,
  isPromoted,
} from "../src/memory-service/promotion";
import {
  appendProposal,
  readProposals,
  removeProposal,
  generateProposalId,
  type Proposal,
} from "../src/memory-service/proposals";
import { writeMemoryFact } from "../src/memory-service/memory-store";

/** P1 Items #4 and #5 Tests */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("P1 Item #4: Mistakes recurrence≥2 auto-promote", () => {
  test("recurrence=1 does not promote", async () => {
    const root = await makeTempDir("hive-recurrence-1-");
    const episodic = new EpisodicStore(":memory:");

    const signature = "test:failure:npm-install";

    const written = await writeMemoryFact(root, {
      scope: "repo",
      topic: "pitfalls",
      title: "Pitfall: npm install failed",
      body: `## What failed\n\n- Failure signature: ${signature}\n\nTest failure`,
      tags: ["pitfall"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
      date: "2026-08-20",
      evidence: "Test evidence",
      supersedes: [],
    });

    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T10:00:00Z",
    );

    expect(getRecurrenceCount(episodic, signature)).toBe(1);

    const report = await autoPromoteMistakes({ repoRoot: root, episodic });

    expect(report.scanned).toBe(1);
    expect(report.promoted.length).toBe(0);
    expect(report.belowThreshold).toBe(1);
  });

  test("recurrence≥2 promotes to always-on", async () => {
    const root = await makeTempDir("hive-recurrence-2-");
    const episodic = new EpisodicStore(":memory:");

    const signature = "test:failure:build-error";

    const written = await writeMemoryFact(root, {
      scope: "repo",
      topic: "pitfalls",
      title: "Pitfall: build error",
      body: `## What failed\n\n- Failure signature: ${signature}\n\nBuild failed`,
      tags: ["pitfall"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
      date: "2026-08-20",
      evidence: "Test evidence",
      supersedes: [],
    });

    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T10:00:00Z",
    );
    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T11:00:00Z",
    );

    expect(getRecurrenceCount(episodic, signature)).toBe(2);

    const report = await autoPromoteMistakes({ repoRoot: root, episodic });

    expect(report.scanned).toBe(1);
    expect(report.promoted.length).toBe(1);
    const firstPromoted = report.promoted[0];
    if (firstPromoted === undefined) throw new Error("Expected promoted item");
    expect(firstPromoted.signature).toBe(signature);
    expect(firstPromoted.count).toBe(2);
    expect(isPromoted(episodic, signature)).toBe(true);
  });

  test("recurrence=3 promotes once", async () => {
    const root = await makeTempDir("hive-recurrence-3-");
    const episodic = new EpisodicStore(":memory:");

    const signature = "test:failure:lint-error";

    const written = await writeMemoryFact(root, {
      scope: "repo",
      topic: "pitfalls",
      title: "Pitfall: lint error",
      body: `## What failed\n\n- Failure signature: ${signature}\n\nLint failed`,
      tags: ["pitfall"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
      date: "2026-08-20",
      evidence: "Test evidence",
      supersedes: [],
    });

    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T10:00:00Z",
    );
    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T11:00:00Z",
    );
    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T12:00:00Z",
    );

    expect(getRecurrenceCount(episodic, signature)).toBe(3);

    const firstReport = await autoPromoteMistakes({ repoRoot: root, episodic });
    expect(firstReport.promoted.length).toBe(1);

    const secondReport = await autoPromoteMistakes({
      repoRoot: root,
      episodic,
    });
    expect(secondReport.promoted.length).toBe(0);
    expect(secondReport.alreadyPromoted).toBe(1);
  });

  test("promoted mistakes include always-on tag", async () => {
    const root = await makeTempDir("hive-promoted-tag-");
    const episodic = new EpisodicStore(":memory:");

    const signature = "test:failure:test-error";

    const written = await writeMemoryFact(root, {
      scope: "repo",
      topic: "pitfalls",
      title: "Pitfall: test error",
      body: `## What failed\n\n- Failure signature: ${signature}\n\nTest failed`,
      tags: ["pitfall"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
      date: "2026-08-20",
      evidence: "Test evidence",
      supersedes: [],
    });

    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T10:00:00Z",
    );
    incrementRecurrence(
      episodic,
      signature,
      written.id,
      "2026-08-20T11:00:00Z",
    );

    await autoPromoteMistakes({ repoRoot: root, episodic });

    const { discoverMemoryFacts } =
      await import("../src/memory-service/memory-store");
    const facts = await discoverMemoryFacts(root, "repo");
    const promoted = facts.filter(
      (f) => f.tags.includes("promoted") && f.tags.includes("always-on"),
    );

    expect(promoted.length).toBeGreaterThan(0);
    const firstPromotedFact = promoted[0];
    if (firstPromotedFact === undefined)
      throw new Error("Expected promoted fact");
    expect(firstPromotedFact.topic).toBe("mistakes-promoted");
  });
});

describe("P1 Item #5: Proposals inbox", () => {
  test("append proposal to empty inbox", async () => {
    const root = await makeTempDir("hive-proposals-1-");
    await mkdir(join(root, "docs"), { recursive: true });

    const proposal: Proposal = {
      id: generateProposalId("profile", 1),
      createdAt: "2026-08-22T10:00:00Z",
      category: "profile",
      title: "Add code style preference",
      rationale: "User consistently prefers semicolons",
      proposedChange: "Use semicolons in all JavaScript/TypeScript code",
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(1);
    const firstProposal = inbox.proposals[0];
    if (firstProposal === undefined) throw new Error("Expected proposal");
    expect(firstProposal.id).toBe(proposal.id);
    expect(firstProposal.title).toBe(proposal.title);
    expect(firstProposal.category).toBe("profile");
  });

  test("append multiple proposals", async () => {
    const root = await makeTempDir("hive-proposals-2-");
    await mkdir(join(root, "docs"), { recursive: true });

    const proposal1: Proposal = {
      id: generateProposalId("project", 1),
      createdAt: "2026-08-22T10:00:00Z",
      category: "project",
      title: "Document naming convention",
      rationale: "Repeated pattern in codebase",
      proposedChange: "Use kebab-case for file names",
      source: "consolidator",
    };

    const proposal2: Proposal = {
      id: generateProposalId("mistake", 2),
      createdAt: "2026-08-22T11:00:00Z",
      category: "mistake",
      title: "Common error pattern",
      rationale: "Seen 3 times this week",
      proposedChange: "Always check null before accessing properties",
      source: "consolidator",
    };

    await appendProposal(root, proposal1);
    await appendProposal(root, proposal2);

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(2);
    const firstProposal = inbox.proposals[0];
    const secondProposal = inbox.proposals[1];
    if (firstProposal === undefined || secondProposal === undefined)
      throw new Error("Expected proposals");
    expect(firstProposal.id).toBe(proposal1.id);
    expect(secondProposal.id).toBe(proposal2.id);
  });

  test("remove proposal from inbox", async () => {
    const root = await makeTempDir("hive-proposals-3-");
    await mkdir(join(root, "docs"), { recursive: true });

    const proposal: Proposal = {
      id: generateProposalId("profile", 1),
      createdAt: "2026-08-22T10:00:00Z",
      category: "profile",
      title: "Test proposal",
      rationale: "Test rationale",
      proposedChange: "Test change",
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    let inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(1);

    await removeProposal(root, proposal.id);

    inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(0);
  });

  test("read proposals returns empty for missing file", async () => {
    const root = await makeTempDir("hive-proposals-4-");

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(0);
  });

  test("deterministic proposal ID generation", () => {
    const id1 = generateProposalId("profile", 1);
    const id2 = generateProposalId("profile", 2);
    const id3 = generateProposalId("project", 1);

    expect(id1).toMatch(/^profile-\d{8}-1$/);
    expect(id2).toMatch(/^profile-\d{8}-2$/);
    expect(id3).toMatch(/^project-\d{8}-1$/);
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });

  test("proposal format includes all required fields", async () => {
    const root = await makeTempDir("hive-proposals-5-");
    await mkdir(join(root, "docs"), { recursive: true });

    const proposal: Proposal = {
      id: "test-proposal-1",
      createdAt: "2026-08-22T10:00:00Z",
      category: "project",
      title: "Test proposal",
      rationale: "Test rationale for the proposal",
      proposedChange: "The actual change to be made",
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(
      join(root, "docs/memory-proposals.md"),
      "utf-8",
    );

    expect(content).toContain("### test-proposal-1:");
    expect(content).toContain("**Category**: project");
    expect(content).toContain("**Created**: 2026-08-22T10:00:00Z");
    expect(content).toContain("**Source**: consolidator");
    expect(content).toContain("**Rationale**: Test rationale");
    expect(content).toContain("**Proposed change**:");
    expect(content).toContain("The actual change to be made");
  });

  test("Fixture: profile/project files unchanged after proposals", async () => {
    const root = await makeTempDir("hive-proposals-unchanged-");
    await mkdir(join(root, "docs"), { recursive: true });

    const {
      writeFile,
      access,
      readFile: fsReadFile,
    } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    const { getHiveHome } = await import("../src/hive-home/home");

    const agentsContent = "# AGENTS.md\n\nExisting project conventions";
    await writeFile(join(root, "AGENTS.md"), agentsContent, "utf-8");

    const profilePath = join(getHiveHome(), "profile.md");
    let profileExisted = true;
    let originalProfileContent = "";
    try {
      await access(profilePath, constants.F_OK);
      originalProfileContent = await fsReadFile(profilePath, "utf-8");
    } catch {
      profileExisted = false;
    }

    const proposal: Proposal = {
      id: generateProposalId("profile", 1),
      createdAt: "2026-08-22T10:00:00Z",
      category: "profile",
      title: "Add profile preference",
      rationale: "User prefers something",
      proposedChange: "Add this to profile",
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    const agentsAfter = await fsReadFile(join(root, "AGENTS.md"), "utf-8");
    expect(agentsAfter).toBe(agentsContent);

    if (profileExisted) {
      const profileAfter = await fsReadFile(profilePath, "utf-8");
      expect(profileAfter).toBe(originalProfileContent);
    }

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(1);
    const firstProposal = inbox.proposals[0];
    if (firstProposal === undefined) throw new Error("Expected proposal");
    expect(firstProposal.category).toBe("profile");
  });
});
