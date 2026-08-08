import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReviewAdmittedForCandidate,
  type ReviewAdmissionReader,
} from "../../src/daemon/hierarchy-service/review-admission";
import { type Review, ReviewSchema } from "../../src/schemas/integration-stage";

const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const author = {
  nodeId: "node_018f4f5e-0000-7000-8000-000000000001",
  agentId: "author",
  generation: 1,
};
const reviewer = {
  nodeId: "node_018f4f5e-0000-7000-8000-000000000002",
  agentId: "reviewer",
  generation: 1,
};
const coauthor = {
  nodeId: "node_018f4f5e-0000-7000-8000-000000000003",
  agentId: "coauthor",
  generation: 1,
};
const digest = `sha256:${"a".repeat(64)}`;
const changedDigest = `sha256:${"b".repeat(64)}`;

interface GitFixture {
  root: string;
  baseSha: string;
  headSha: string;
}

interface RebaseFixture {
  reviewed: GitFixture;
  rebased: GitFixture;
}

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function createGitFixture(
  headAuthor: "author" | "reviewer" | "coauthor" = "author",
  parentMarker = "first-parent",
): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "hive-review-admission-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "candidate.txt"), "base\n");
  writeFileSync(join(root, "parent.txt"), `${parentMarker}\n`);
  git(root, "add", "candidate.txt", "parent.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");

  writeFileSync(join(root, "candidate.txt"), "candidate\n");
  git(root, "add", "candidate.txt");
  git(
    root,
    "-c",
    `user.name=${headAuthor}`,
    "-c",
    `user.email=${headAuthor}@example.test`,
    "commit",
    "-q",
    "-m",
    "candidate",
  );
  return { root, baseSha, headSha: git(root, "rev-parse", "HEAD") };
}

function createRebaseFixture(): RebaseFixture {
  const reviewed = createGitFixture();
  git(reviewed.root, "checkout", "-q", "-b", "rebased", reviewed.baseSha);
  writeFileSync(join(reviewed.root, "parent.txt"), "second-parent\n");
  git(reviewed.root, "add", "parent.txt");
  git(reviewed.root, "commit", "-q", "-m", "new parent");
  const baseSha = git(reviewed.root, "rev-parse", "HEAD");
  git(reviewed.root, "cherry-pick", reviewed.headSha);
  return {
    reviewed,
    rebased: {
      root: reviewed.root,
      baseSha,
      headSha: git(reviewed.root, "rev-parse", "HEAD"),
    },
  };
}

function createMergeFixture(): GitFixture {
  const fixture = createGitFixture();
  const mainBranch = git(fixture.root, "branch", "--show-current");
  git(fixture.root, "checkout", "-q", "-b", "reviewer-side", fixture.baseSha);
  writeFileSync(join(fixture.root, "reviewer.txt"), "reviewer side\n");
  git(fixture.root, "add", "reviewer.txt");
  git(
    fixture.root,
    "-c",
    "user.name=reviewer",
    "-c",
    "user.email=reviewer@example.test",
    "commit",
    "-q",
    "-m",
    "reviewer side",
  );
  git(fixture.root, "checkout", "-q", mainBranch);
  git(
    fixture.root,
    "-c",
    "user.name=author",
    "-c",
    "user.email=author@example.test",
    "merge",
    "-q",
    "--no-ff",
    "reviewer-side",
    "-m",
    "merge candidate",
  );
  return { ...fixture, headSha: git(fixture.root, "rev-parse", "HEAD") };
}

function reviewFor(fixture: GitFixture): Review {
  return ReviewSchema.parse({
    reviewId: "review_018f4f5e-0000-7000-8000-000000000001",
    revision: "1",
    reviewer,
    authors: [author],
    candidate: {
      commitSha: fixture.headSha,
      patchDigest: digest,
      baseSha: fixture.baseSha,
    },
    revisions: {
      spec: { revision: "1", digest },
      task: { taskId, revision: "1" },
      contracts: [],
    },
    environment: { toolchain: "bun", environment: "test" },
    findings: [],
    verdict: "accepted",
    evidenceArtifactRefs: [],
    invalidation: { state: "current" },
  });
}

function readerFor(
  _fixture: GitFixture,
  overrides: {
    candidateAuthors?: readonly string[];
    overlappingTask?: boolean;
    validatedShas?: readonly string[];
  } = {},
): ReviewAdmissionReader {
  return {
    candidateAuthorAgentIds: () =>
      overrides.candidateAuthors ?? [author.agentId],
    hasOverlappingAuthorTask: () => overrides.overlappingTask ?? false,
    hasFreshValidationEvidenceAt: (sha) =>
      (overrides.validatedShas ?? []).includes(sha),
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("review admission independence", () => {
  test("admits an independent exact candidate as a positive control", () => {
    const fixture = createGitFixture();
    expect(
      isReviewAdmittedForCandidate(
        reviewFor(fixture),
        reviewFor(fixture).candidate,
        readerFor(fixture),
      ),
    ).toBe(true);
  });

  test("rejects a reviewer named in stored candidate authorship", () => {
    const fixture = createGitFixture("reviewer");
    const review = reviewFor(fixture);
    expect(
      isReviewAdmittedForCandidate(
        review,
        review.candidate,
        readerFor(fixture, { candidateAuthors: [reviewer.agentId] }),
      ),
    ).toBe(false);
  });

  test("stored candidate authorship is authoritative without git-email inference", () => {
    const fixture = createMergeFixture();
    const review = reviewFor(fixture);
    const allAuthors = readerFor(fixture, {
      candidateAuthors: [author.agentId, reviewer.agentId],
    }).candidateAuthorAgentIds(review.candidate);
    expect(allAuthors).toContain(reviewer.agentId);
    expect(
      isReviewAdmittedForCandidate(
        review,
        review.candidate,
        readerFor(fixture, {
          candidateAuthors: [author.agentId, reviewer.agentId],
        }),
      ),
    ).toBe(false);
  });

  test("rejects the same reviewer and author identity", () => {
    const fixture = createGitFixture("coauthor");
    const review = ReviewSchema.parse({
      ...reviewFor(fixture),
      reviewer: { ...reviewer, agentId: author.agentId },
      authors: [author, coauthor],
    });
    expect(
      isReviewAdmittedForCandidate(
        review,
        review.candidate,
        readerFor(fixture),
      ),
    ).toBe(false);
  });

  test("rejects a reviewer with an overlapping author task", () => {
    const fixture = createGitFixture();
    const review = reviewFor(fixture);
    expect(
      isReviewAdmittedForCandidate(
        review,
        review.candidate,
        readerFor(fixture, { overlappingTask: true }),
      ),
    ).toBe(false);
  });
});

describe("review admission candidate binding", () => {
  test("rejects a changes-requested verdict with a blocking finding", () => {
    const fixture = createGitFixture();
    const review = ReviewSchema.parse({
      ...reviewFor(fixture),
      verdict: "changes-requested",
      findings: [
        {
          findingId: "block-1",
          summary: "unsafe change",
          severity: "blocking",
        },
      ],
    });
    expect(
      isReviewAdmittedForCandidate(
        review,
        review.candidate,
        readerFor(fixture),
      ),
    ).toBe(false);
  });

  test("invalidates a changed patch digest", () => {
    const fixture = createGitFixture();
    const review = reviewFor(fixture);
    expect(
      isReviewAdmittedForCandidate(
        review,
        { ...review.candidate, patchDigest: changedDigest },
        readerFor(fixture, { validatedShas: [review.candidate.commitSha] }),
      ),
    ).toBe(false);
  });

  test("identical patch rebase needs evidence at the exact new synthetic SHA", () => {
    const { reviewed, rebased } = createRebaseFixture();
    const review = reviewFor(reviewed);
    const candidate = {
      ...review.candidate,
      baseSha: rebased.baseSha,
      commitSha: rebased.headSha,
    };
    expect(git(reviewed.root, "diff", reviewed.baseSha, reviewed.headSha)).toBe(
      git(rebased.root, "diff", rebased.baseSha, rebased.headSha),
    );

    expect(
      isReviewAdmittedForCandidate(
        review,
        candidate,
        readerFor(rebased, { validatedShas: [review.candidate.commitSha] }),
      ),
    ).toBe(false);
    expect(
      isReviewAdmittedForCandidate(
        review,
        candidate,
        readerFor(rebased, { validatedShas: [candidate.commitSha] }),
      ),
    ).toBe(true);
  });

  test("an invalidated review cannot use the identical-patch rebase exception", () => {
    const { reviewed, rebased } = createRebaseFixture();
    const review = ReviewSchema.parse({
      ...reviewFor(reviewed),
      invalidation: { state: "invalidated", reason: "base-changed" },
    });
    expect(
      isReviewAdmittedForCandidate(
        review,
        {
          ...review.candidate,
          baseSha: rebased.baseSha,
          commitSha: rebased.headSha,
        },
        readerFor(rebased, { validatedShas: [rebased.headSha] }),
      ),
    ).toBe(false);
  });

  test("a changed patch cannot use the identical-patch rebase exception", () => {
    const { reviewed, rebased } = createRebaseFixture();
    const review = reviewFor(reviewed);
    expect(
      isReviewAdmittedForCandidate(
        review,
        {
          patchDigest: changedDigest,
          baseSha: rebased.baseSha,
          commitSha: rebased.headSha,
        },
        readerFor(rebased, { validatedShas: [rebased.headSha] }),
      ),
    ).toBe(false);
  });

  test("a same-base commit change is not an identical-patch rebase", () => {
    const { reviewed, rebased } = createRebaseFixture();
    const review = reviewFor(reviewed);
    expect(
      isReviewAdmittedForCandidate(
        review,
        { ...review.candidate, commitSha: rebased.headSha },
        readerFor(rebased, { validatedShas: [rebased.headSha] }),
      ),
    ).toBe(false);
  });

  test("a changed base without a new commit is not an identical-patch rebase", () => {
    const { reviewed, rebased } = createRebaseFixture();
    const review = reviewFor(reviewed);
    expect(
      isReviewAdmittedForCandidate(
        review,
        { ...review.candidate, baseSha: rebased.baseSha },
        readerFor(rebased, { validatedShas: [review.candidate.commitSha] }),
      ),
    ).toBe(false);
  });
});
