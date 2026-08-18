import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runGit } from "../../adapters/git";
import { hiveInstanceSuffix } from "../../hive-home/home";

const GitOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const SettlementDecisionSchema = z.strictObject({
  version: z.literal(1),
  decisionId: z.string().regex(/^[0-9a-f]{32}$/),
  instanceId: z.string().min(1),
  caseId: z.string().regex(/^[0-9a-f]{32}$/),
  caseRevision: z.number().int().positive(),
  evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  worktreePath: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  branchOid: GitOidSchema.nullable(),
  refs: z.array(z.strictObject({ ref: z.string().min(1), oid: GitOidSchema })),
  residue: z.array(z.string().min(1)),
  outcome: z.literal("discard"),
  reason: z.string().min(1),
  decisionOwner: z.string().min(1),
  mintedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  executedAt: z.iso.datetime().nullable(),
  executedBy: z.string().min(1).nullable(),
  removedPaths: z.array(z.string()),
  removedRefs: z.array(z.string()),
});

export type SettlementDecision = z.infer<typeof SettlementDecisionSchema>;

export interface StoredSettlementDecision {
  readonly record: SettlementDecision;
  readonly ref: string;
  readonly objectOid: string;
}

function assertGitSuccess(
  result: Awaited<ReturnType<typeof runGit>>,
  operation: string,
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`);
  throw new Error(`git ${operation} failed: ${detail}`);
}

export class SettlementDecisionStore {
  private readonly prefix: string;

  constructor(
    private readonly repoRoot: string,
    private readonly instanceId = hiveInstanceSuffix(),
  ) {
    this.prefix = `refs/hive-settlement-decision/${instanceId}`;
  }

  async mint(
    input: Omit<
      SettlementDecision,
      | "version"
      | "decisionId"
      | "instanceId"
      | "executedAt"
      | "executedBy"
      | "removedPaths"
      | "removedRefs"
    >,
  ): Promise<StoredSettlementDecision> {
    const record = SettlementDecisionSchema.parse({
      ...input,
      version: 1,
      decisionId: randomUUID().replaceAll("-", ""),
      instanceId: this.instanceId,
      executedAt: null,
      executedBy: null,
      removedPaths: [],
      removedRefs: [],
    });
    return this.write(record, null);
  }

  async read(decisionId: string): Promise<StoredSettlementDecision | null> {
    if (!/^[0-9a-f]{32}$/.test(decisionId)) {
      throw new Error(`invalid settlement decision id: ${decisionId}`);
    }
    const ref = `${this.prefix}/${decisionId}`;
    const resolved = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (resolved.exitCode !== 0) {
      if (resolved.timedOut || resolved.stderr.trim() !== "") {
        assertGitSuccess(resolved, "rev-parse settlement decision");
      }
      return null;
    }
    const objectOid = GitOidSchema.parse(resolved.stdout.trim());
    const blob = await runGit(this.repoRoot, ["cat-file", "blob", objectOid]);
    assertGitSuccess(blob, "cat-file settlement decision");
    const record = SettlementDecisionSchema.parse(JSON.parse(blob.stdout));
    if (
      record.decisionId !== decisionId ||
      record.instanceId !== this.instanceId
    ) {
      throw new Error(`settlement decision ref/content mismatch: ${ref}`);
    }
    return { record, ref, objectOid };
  }

  async markExecuted(
    stored: StoredSettlementDecision,
    input: {
      readonly executedAt: string;
      readonly executedBy: string;
      readonly removedPaths: readonly string[];
      readonly removedRefs: readonly string[];
    },
  ): Promise<StoredSettlementDecision> {
    if (stored.record.executedAt !== null) {
      throw new Error(
        `settlement decision already executed: ${stored.record.decisionId}`,
      );
    }
    return this.write(
      SettlementDecisionSchema.parse({
        ...stored.record,
        ...input,
        removedPaths: [...input.removedPaths],
        removedRefs: [...input.removedRefs],
      }),
      stored.objectOid,
    );
  }

  private async write(
    record: SettlementDecision,
    expectedOid: string | null,
  ): Promise<StoredSettlementDecision> {
    const path = join(
      tmpdir(),
      `hive-settlement-decision-${randomUUID()}.json`,
    );
    try {
      await writeFile(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const hashed = await runGit(this.repoRoot, ["hash-object", "-w", path]);
      assertGitSuccess(hashed, "hash-object settlement decision");
      const objectOid = GitOidSchema.parse(hashed.stdout.trim());
      const ref = `${this.prefix}/${record.decisionId}`;
      const updated = await runGit(this.repoRoot, [
        "update-ref",
        ref,
        objectOid,
        expectedOid ?? "0".repeat(40),
      ]);
      assertGitSuccess(updated, "update-ref settlement decision");
      const readBack = await this.read(record.decisionId);
      if (readBack === null || readBack.objectOid !== objectOid) {
        throw new Error(`settlement decision write did not read back: ${ref}`);
      }
      return readBack;
    } finally {
      await rm(path, { force: true });
    }
  }
}
