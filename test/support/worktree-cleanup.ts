import {
  createWorktreeSettlementBoundary,
  listWorktrees,
  readRefOid,
} from "../../src/adapters/worktrees";

export async function releaseTestWorktree(
  repoRoot: string,
  worktreePath: string,
  options: {
    deleteBranch?: boolean;
    branch?: string;
    discardTracked?: boolean;
    force?: boolean;
  } = {},
): Promise<void> {
  const registration = (await listWorktrees(repoRoot)).find(
    (worktree) => worktree.path === worktreePath,
  );
  const branch = options.deleteBranch
    ? (options.branch ?? registration?.branch ?? null)
    : null;
  const branchOid =
    branch === null ? null : await readRefOid(repoRoot, `refs/heads/${branch}`);
  const boundary = createWorktreeSettlementBoundary();
  await boundary.mutator.apply(
    boundary.issuer.issue({
      kind: "release-worktree",
      repoRoot,
      worktreePath,
      branch,
      branchOid,
      expectedDigest: "test-cleanup",
      revalidate: async () => "test-cleanup",
    }),
  );
}
