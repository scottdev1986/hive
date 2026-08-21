import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runGit } from "../../adapters/git";
import { hiveInstanceSuffix } from "../../hive-home/home";
import { type JsonValue, requireJsonValue } from "../../shared/json";

const GitOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const IsoDateSchema = z.iso.datetime();

const SettlementResidueSchema = z.strictObject({
  targetRef: z.string().min(1),
  targetOid: GitOidSchema,
  mergeBaseOid: GitOidSchema.nullable(),
  branchOid: GitOidSchema.nullable(),
  worktreePresent: z.boolean(),
  dirtyFiles: z.array(z.string().min(1)),
  unaccountedCommitOids: z.array(GitOidSchema),
  stewardshipRefs: z.array(
    z.strictObject({ ref: z.string().min(1), oid: GitOidSchema.nullable() }),
  ),
  mainContainsBranchWork: z.boolean().nullable(),
  missing: z.array(
    z.enum(["branch", "worktree", "preserved-ref", "salvage-ref"]),
  ),
  releaseDisposition: z.enum([
    "automatic-release",
    "integrate-or-user-discard",
    "user-discard",
  ]),
});

const SettlementCaseBaseSchema = z.strictObject({
  version: z.literal(1),
  caseId: z.string().regex(/^[0-9a-f]{32}$/),
  revision: z.number().int().positive(),
  instanceId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  agentName: z.string().min(1).nullable(),
  generation: z.number().int().positive().nullable(),
  worktreePath: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  baseOid: GitOidSchema.nullable(),
  headOid: GitOidSchema.nullable(),
  preservedRef: z.string().min(1).nullable(),
  salvageRef: z.string().min(1).nullable(),
  firstSeenAt: IsoDateSchema,
  lastMeasuredAt: IsoDateSchema.nullable(),
  evidenceDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  evidenceFormat: z.literal("disposition-v1").nullable(),
  residue: SettlementResidueSchema.nullable(),
  /** What the last measurement found that release would destroy without asking: every path the worktree's ignore rules call reproducible. Recorded before any release is authorized, never used to authorize one. */
  regenerable: z.array(z.string().min(1)),
  landingReceipt: z
    .strictObject({
      sourceOid: GitOidSchema,
      targetOid: GitOidSchema,
      targetBranch: z.string().min(1),
      recordedAt: IsoDateSchema,
    })
    .nullable(),
  escalationTier: z.number().int().nonnegative(),
  /** Revision at which the case entered its current run of unattended states; null while a state someone advances owns it. The escalation sweep measures fruitless re-measurement against this baseline. */
  unattendedBaseRevision: z.number().int().positive().nullable(),
});

const DueSchema = z.union([
  z.strictObject({ nextActionAt: IsoDateSchema, watchedTrigger: z.null() }),
  z.strictObject({ nextActionAt: z.null(), watchedTrigger: z.string().min(1) }),
]);

const NonterminalSchema = SettlementCaseBaseSchema.extend({
  state: z.enum([
    "active",
    "settling",
    "assessing",
    "needs-integration",
    "resolution-in-progress",
    "owner-decision",
    "measurement-blocked",
  ]),
  owner: z.enum(["agent", "settlement-service", "resolver", "queen", "user"]),
  reason: z.string().min(1),
  due: DueSchema,
  blockedOn: z.null(),
  reviewAt: z.null(),
  proofDigest: z.null(),
});

const BlockedSchema = SettlementCaseBaseSchema.extend({
  state: z.literal("blocked"),
  owner: z.enum(["agent", "resolver", "queen", "user"]),
  reason: z.string().min(1),
  due: DueSchema,
  blockedOn: z.string().min(1),
  reviewAt: z.null(),
  proofDigest: z.null(),
});

const ParkedSchema = SettlementCaseBaseSchema.extend({
  state: z.literal("parked"),
  owner: z.enum(["queen", "user"]),
  reason: z.string().min(1),
  due: z.strictObject({
    nextActionAt: z.null(),
    watchedTrigger: z.string().min(1),
  }),
  blockedOn: z.null(),
  reviewAt: IsoDateSchema,
  proofDigest: z.null(),
});

const SafeReleaseSchema = SettlementCaseBaseSchema.extend({
  state: z.literal("safe-release"),
  owner: z.literal("settlement-service"),
  reason: z.string().min(1),
  due: z.strictObject({
    nextActionAt: IsoDateSchema,
    watchedTrigger: z.null(),
  }),
  blockedOn: z.null(),
  reviewAt: z.null(),
  proofDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const SettlementCaseSchema = z.discriminatedUnion("state", [
  NonterminalSchema,
  BlockedSchema,
  ParkedSchema,
  SafeReleaseSchema,
]);

export type SettlementCase = z.infer<typeof SettlementCaseSchema>;

export interface StoredSettlementCase {
  readonly record: SettlementCase;
  readonly ref: string;
  readonly objectOid: string;
}

const SettlementAggregateSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  noticeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  rendered: z.string().min(1),
  updatedAt: IsoDateSchema,
  autoSettled: z.number().int().nonnegative(),
  openCases: z.number().int().nonnegative(),
});

export type SettlementAggregate = z.infer<typeof SettlementAggregateSchema>;

export interface StoredSettlementAggregate {
  readonly record: SettlementAggregate;
  readonly ref: string;
  readonly objectOid: string;
}

export interface OpenSettlementCaseInput {
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly generation: number | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseOid: string | null;
  readonly now: string;
  readonly reason: string;
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

/**
 * Reads blobs written before current settlement evidence.
 *
 * Those records carry a `wiring` map and no `regenerable` list. The seal decides nothing now, so
 * the map is dropped and the list starts empty until the next measurement fills it. Reading is
 * where this belongs: one unreadable record fails the whole inventory, and every open case
 * predates the change. A digest without `evidenceFormat` includes ambient target-tip state and
 * must be refreshed before a destructive decision can use it.
 */
function currentDocument(document: unknown): JsonValue {
  const json = requireJsonValue(document, "settlement case blob");
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return json;
  }
  const { wiring: _wiring, ...fields } = json;
  return {
    ...fields,
    regenerable: fields.regenerable ?? [],
    evidenceFormat: fields.evidenceFormat ?? null,
    residue: fields.residue ?? null,
    unattendedBaseRevision: fields.unattendedBaseRevision ?? null,
  };
}

function caseIdentity(input: {
  instanceId: string;
  agentId: string | null;
  generation: number | null;
  worktreePath: string | null;
  branch: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32);
}

function sameIdentity(
  record: SettlementCase,
  input: OpenSettlementCaseInput,
): boolean {
  return (
    record.agentId === input.agentId &&
    record.agentName === input.agentName &&
    record.generation === input.generation &&
    record.worktreePath === input.worktreePath &&
    record.branch === input.branch &&
    record.baseOid === input.baseOid
  );
}

/**
 * Stores open settlement cases as Git refs pointing at JSON blobs.
 *
 * SQL may project these records, but Git is the authority: a daemon restart or
 * replacement database can rebuild the open inventory from these refs alone.
 * Every update uses compare-and-swap against the blob the caller read.
 *
 * Among open cases, a non-null branch names exactly one case: it is the work
 * bundle. agentId, generation and worktreePath are attributes of that bundle,
 * not a second identity. Two writers that disagree on those fields still
 * share the branch, so they must share the case.
 *
 * A sweep lists once, then looks up by branch for every inventoried branch.
 * The store keeps that list as an index so a miss is a map lookup, not another
 * walk of every case blob.
 */
export class SettlementCaseStore {
  readonly instanceId: string;
  private readonly prefix: string;
  /**
   * Complete open-case snapshot for this instance, or null when nothing has
   * enumerated yet. `list` and the first branch lookup populate it; writes and
   * closes keep it current. The reconcile loop looks up a case per inventoried
   * branch, so a miss must not re-read every case from git.
   */
  private inventory: Map<string, StoredSettlementCase> | null = null;

  constructor(
    readonly repoRoot: string,
    instanceId = hiveInstanceSuffix(),
  ) {
    this.instanceId = instanceId;
    this.prefix = `refs/hive-settlement/${instanceId}`;
  }

  async open(input: OpenSettlementCaseInput): Promise<StoredSettlementCase> {
    if (input.branch !== null) {
      const byBranch = await this.findOpenByBranch(input.branch);
      if (byBranch !== null) return byBranch;
    }
    const caseId = caseIdentity({
      instanceId: this.instanceId,
      agentId: input.agentId,
      generation: input.generation,
      worktreePath: input.worktreePath,
      branch: input.branch,
    });
    const existing = await this.read(caseId);
    if (existing !== null) {
      if (!sameIdentity(existing.record, input)) {
        throw new Error(`settlement case identity drift: ${caseId}`);
      }
      return existing;
    }
    const record = SettlementCaseSchema.parse({
      version: 1,
      caseId,
      revision: 1,
      instanceId: this.instanceId,
      agentId: input.agentId,
      agentName: input.agentName,
      generation: input.generation,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseOid: input.baseOid,
      headOid: input.baseOid,
      preservedRef: null,
      salvageRef: null,
      firstSeenAt: input.now,
      lastMeasuredAt: null,
      evidenceDigest: null,
      evidenceFormat: null,
      residue: null,
      regenerable: [],
      landingReceipt: null,
      escalationTier: 0,
      unattendedBaseRevision: null,
      state: "active",
      owner: input.agentId === null ? "settlement-service" : "agent",
      reason: input.reason,
      due: { nextActionAt: null, watchedTrigger: "agent-generation-ended" },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    });
    return this.write(record, null);
  }

  private pickOpenByBranch(
    branch: string,
    cases: Iterable<StoredSettlementCase>,
  ): StoredSettlementCase | null {
    const matches: StoredSettlementCase[] = [];
    for (const stored of cases) {
      if (stored.record.branch === branch) matches.push(stored);
    }
    return (
      matches.find((candidate) => candidate.record.worktreePath !== null) ??
      matches.find((candidate) => candidate.record.agentId !== null) ??
      matches[0] ??
      null
    );
  }

  private async findOpenByBranch(
    branch: string,
  ): Promise<StoredSettlementCase | null> {
    return this.pickOpenByBranch(branch, await this.casesForLookup());
  }

  private async casesForLookup(): Promise<Iterable<StoredSettlementCase>> {
    if (this.inventory !== null) return this.inventory.values();
    const loaded = await this.loadCasesFromGit();
    this.replaceInventory(loaded);
    return loaded;
  }

  private replaceInventory(cases: readonly StoredSettlementCase[]): void {
    this.inventory = new Map(
      cases.map((stored) => [stored.record.caseId, stored]),
    );
  }

  private remember(stored: StoredSettlementCase): void {
    this.inventory?.set(stored.record.caseId, stored);
  }

  private forget(caseId: string): void {
    this.inventory?.delete(caseId);
  }

  async read(caseId: string): Promise<StoredSettlementCase | null> {
    if (!/^[0-9a-f]{32}$/.test(caseId)) {
      throw new Error(`invalid settlement case id: ${caseId}`);
    }
    const ref = `${this.prefix}/${caseId}`;
    const resolved = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (resolved.exitCode !== 0) {
      if (resolved.timedOut || resolved.stderr.trim() !== "") {
        assertGitSuccess(resolved, "rev-parse");
      }
      return null;
    }
    return this.readCaseBlob(
      ref,
      caseId,
      GitOidSchema.parse(resolved.stdout.trim()),
    );
  }

  private async readCaseBlob(
    ref: string,
    caseId: string,
    objectOid: string,
  ): Promise<StoredSettlementCase> {
    const blob = await runGit(this.repoRoot, ["cat-file", "blob", objectOid]);
    assertGitSuccess(blob, "cat-file blob");
    const record = SettlementCaseSchema.parse(
      currentDocument(JSON.parse(blob.stdout)),
    );
    if (record.caseId !== caseId || record.instanceId !== this.instanceId) {
      throw new Error(`settlement case ref/content identity mismatch: ${ref}`);
    }
    return { record, ref, objectOid };
  }

  private parseRefInventory(stdout: string): Array<readonly [string, string]> {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const parts = line.split(" ");
        return [parts[0] ?? "", parts[1] ?? ""] as const;
      })
      .filter(([ref, oid]) => ref !== "" && oid !== "");
  }

  private async loadCasesFromGit(
    targetBranch?: string,
  ): Promise<StoredSettlementCase[]> {
    const targetRef =
      targetBranch === undefined ? undefined : `refs/heads/${targetBranch}`;
    const result = await runGit(this.repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      ...(targetRef === undefined ? [] : [targetRef]),
      this.prefix,
    ]);
    assertGitSuccess(result, "for-each-ref");
    const entries = this.parseRefInventory(result.stdout);
    if (targetRef !== undefined) {
      const target = entries.find(([ref]) => ref === targetRef);
      if (target?.[1] === undefined) {
        throw new Error(
          `settlement ref inventory positive control failed: ${targetRef} is absent`,
        );
      }
      GitOidSchema.parse(target[1]);
    }
    const caseEntries = entries.flatMap(([ref, objectOid]) => {
      if (!ref.startsWith(`${this.prefix}/`)) return [];
      const caseId = ref.slice(this.prefix.length + 1);
      if (!/^[0-9a-f]{32}$/.test(caseId)) {
        throw new Error(`invalid settlement case id: ${caseId}`);
      }
      return [
        {
          ref,
          caseId,
          objectOid: GitOidSchema.parse(objectOid),
        },
      ];
    });
    return Promise.all(
      caseEntries.map(({ ref, caseId, objectOid }) =>
        this.readCaseBlob(ref, caseId, objectOid),
      ),
    );
  }

  /** Enumerate cases only after the same reader proves it can see main. */
  async list(targetBranch: string): Promise<StoredSettlementCase[]> {
    const cases = await this.loadCasesFromGit(targetBranch);
    this.replaceInventory(cases);
    return [...cases].sort((left, right) =>
      left.record.caseId.localeCompare(right.record.caseId),
    );
  }

  async update(
    stored: StoredSettlementCase,
    next: Omit<SettlementCase, "revision">,
  ): Promise<StoredSettlementCase> {
    if (next.caseId !== stored.record.caseId) {
      throw new Error("settlement case update changed its identity");
    }
    const record = SettlementCaseSchema.parse({
      ...next,
      revision: stored.record.revision + 1,
    });
    return this.write(record, stored.objectOid);
  }

  async close(stored: StoredSettlementCase): Promise<void> {
    const deleted = await runGit(this.repoRoot, [
      "update-ref",
      "-d",
      stored.ref,
      stored.objectOid,
    ]);
    assertGitSuccess(deleted, "update-ref -d");
    this.forget(stored.record.caseId);
    if ((await this.read(stored.record.caseId)) !== null) {
      throw new Error(
        `settlement case still exists after close: ${stored.ref}`,
      );
    }
  }

  async readAggregate(): Promise<StoredSettlementAggregate | null> {
    const ref = `refs/hive-settlement-aggregate/${this.instanceId}`;
    const resolved = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (resolved.exitCode !== 0) {
      if (resolved.timedOut || resolved.stderr.trim() !== "") {
        assertGitSuccess(resolved, "rev-parse settlement aggregate");
      }
      return null;
    }
    const objectOid = GitOidSchema.parse(resolved.stdout.trim());
    const blob = await runGit(this.repoRoot, ["cat-file", "blob", objectOid]);
    assertGitSuccess(blob, "cat-file settlement aggregate");
    return {
      record: SettlementAggregateSchema.parse(JSON.parse(blob.stdout)),
      ref,
      objectOid,
    };
  }

  async writeAggregate(
    record: SettlementAggregate,
    expectedOid: string | null,
  ): Promise<StoredSettlementAggregate> {
    const parsed = SettlementAggregateSchema.parse(record);
    const path = join(
      tmpdir(),
      `hive-settlement-aggregate-${randomUUID()}.json`,
    );
    try {
      await writeFile(path, `${JSON.stringify(parsed)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const hashed = await runGit(this.repoRoot, ["hash-object", "-w", path]);
      assertGitSuccess(hashed, "hash-object settlement aggregate");
      const objectOid = GitOidSchema.parse(hashed.stdout.trim());
      const ref = `refs/hive-settlement-aggregate/${this.instanceId}`;
      const updated = await runGit(this.repoRoot, [
        "update-ref",
        ref,
        objectOid,
        expectedOid ?? "0".repeat(40),
      ]);
      assertGitSuccess(updated, "update-ref settlement aggregate");
      const readBack = await this.readAggregate();
      if (readBack === null || readBack.objectOid !== objectOid) {
        throw new Error("settlement aggregate write did not read back");
      }
      return readBack;
    } finally {
      await rm(path, { force: true });
    }
  }

  private async write(
    record: SettlementCase,
    expectedOid: string | null,
  ): Promise<StoredSettlementCase> {
    const parsed = SettlementCaseSchema.parse(record);
    const path = join(tmpdir(), `hive-settlement-${randomUUID()}.json`);
    try {
      await writeFile(path, `${JSON.stringify(parsed)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const hashed = await runGit(this.repoRoot, ["hash-object", "-w", path]);
      assertGitSuccess(hashed, "hash-object");
      const objectOid = GitOidSchema.parse(hashed.stdout.trim());
      const ref = `${this.prefix}/${record.caseId}`;
      const updated = await runGit(this.repoRoot, [
        "update-ref",
        ref,
        objectOid,
        expectedOid ?? "0".repeat(40),
      ]);
      assertGitSuccess(updated, "update-ref");
      const readBack = await this.read(record.caseId);
      if (readBack === null || readBack.objectOid !== objectOid) {
        throw new Error(`settlement case write did not read back: ${ref}`);
      }
      this.remember(readBack);
      return readBack;
    } finally {
      await rm(path, { force: true });
    }
  }
}
