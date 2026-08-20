import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessStrandedWork,
  listSettlementBranches,
  reconcileOrphanedWorktrees,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { NAME_POOL } from "../../src/daemon/spawn/agent-name-selection";
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import {
  projectSettlementDebt,
  renderSettlementDebt,
  settlementDebtCondition,
  settlementDebtNeedsNotice,
} from "../../src/daemon/worktree-lifecycle-service/settlement-debt";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hive Test",
      GIT_AUTHOR_EMAIL: "hive@example.test",
      GIT_COMMITTER_NAME: "Hive Test",
      GIT_COMMITTER_EMAIL: "hive@example.test",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

describe("settlement debt at fifty worktrees", () => {
  test("a case no resolver ever advances becomes the owner's to decide", async () => {
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-hoard-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# hoard\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const tip = await git(repo, "rev-parse", "main");
    const store = new SettlementCaseStore(repo);
    const firstSeenAt = "2026-08-12T12:00:00.000Z";
    const db = new HiveDatabase(":memory:");
    let now = Date.parse(firstSeenAt);
    const service = () =>
      new WorktreeLifecycleService({
        db,
        repoRoot: repo,
        clock: () => new Date(now),
        publish: async () => {},
        assessStrandedWork,
        listSettlementBranches,
        reconcileOrphanedWorktrees,
      });
    try {
      // Unlanded work only a person can rule on: landing it and discarding it are both product
      // judgments. No resolver is ever leased, so nothing moves this case on its own.
      const opened = await store.open({
        agentId: null,
        agentName: "maya",
        generation: null,
        worktreePath: null,
        branch: "hive/maya-hoard",
        baseOid: tip,
        now: firstSeenAt,
        reason: "synthetic unlanded work",
      });
      await store.update(opened, {
        ...opened.record,
        state: "needs-integration",
        owner: "resolver",
        reason: "1 commit(s) are not accounted for on main",
        due: { nextActionAt: firstSeenAt, watchedTrigger: null },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });

      // Positive control: the case counts as resolving right now, so a later owner-decision count
      // of one is a transition rather than a reader that never saw the case at all.
      const before = await service().updateSettlementDebt();
      expect(before.aggregate.resolving).toBe(1);
      expect(before.aggregate.ownerDecision).toBe(0);
      expect(before.published).toBe(false);

      // Past the first escalation tier with nothing having moved it. "Resolving" would now be a
      // false report: no resolver exists to be resolving it.
      now += 25 * 60 * 60_000;
      const after = await service().updateSettlementDebt();
      expect(after.aggregate.ownerDecision).toBe(1);
      expect(after.aggregate.resolving).toBe(0);
      expect(after.published).toBe(true);

      const [settled] = await store.list("main");
      expect(settled?.record.state).toBe("owner-decision");
      expect(settled?.record.owner).toBe("user");
      expect(settled?.record.due.nextActionAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("48 closed proofs and two undecidable cases stay one legible aggregate", async () => {
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-debt-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# debt\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const tip = await git(repo, "rev-parse", "main");
    const store = new SettlementCaseStore(repo);
    const firstSeenAt = "2026-08-12T12:00:00.000Z";
    const safeOnly = projectSettlementDebt([], {
      now: Date.parse(firstSeenAt),
      autoSettled: 48,
      unavailableNames: 4,
      namePoolTotal: NAME_POOL.length,
      liveAgentIds: new Set<string>(),
    });
    await store.writeAggregate(
      {
        version: 1,
        digest: safeOnly.digest,
        noticeDigest: safeOnly.noticeDigest,
        rendered: renderSettlementDebt(safeOnly),
        updatedAt: firstSeenAt,
        autoSettled: 48,
        openCases: 0,
      },
      null,
    );
    let owner = await store.open({
      agentId: null,
      agentName: "maya",
      generation: null,
      worktreePath: null,
      branch: "hive/maya-debt",
      baseOid: tip,
      now: firstSeenAt,
      reason: "synthetic owner decision",
    });
    owner = await store.update(owner, {
      ...owner.record,
      state: "owner-decision",
      owner: "user",
      reason: "content needs a product decision",
      due: { nextActionAt: "2026-08-12T12:00:00.000Z", watchedTrigger: null },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    });
    let blocked = await store.open({
      agentId: null,
      agentName: "david",
      generation: null,
      worktreePath: null,
      branch: "hive/david-debt",
      baseOid: tip,
      now: firstSeenAt,
      reason: "synthetic blocked case",
    });
    blocked = await store.update(blocked, {
      ...blocked.record,
      state: "blocked",
      owner: "queen",
      reason: "waiting for a named dependency",
      due: { nextActionAt: null, watchedTrigger: "dependency-completed" },
      blockedOn: "task-dependency",
      reviewAt: null,
      proofDigest: null,
    });
    const projected = projectSettlementDebt([owner.record, blocked.record], {
      now: Date.parse("2026-08-12T12:00:00.000Z"),
      autoSettled: 48,
      unavailableNames: 6,
      namePoolTotal: NAME_POOL.length,
      liveAgentIds: new Set<string>(),
    });
    expect(projected.total).toBe(50);
    expect(projected.autoSettled).toBe(48);
    expect(projected.settling).toBe(0);
    expect(projected.ownerDecision).toBe(1);
    expect(projected.blocked).toBe(1);
    expect(renderSettlementDebt(projected)).toContain("name-pool 591/597 free");
    const withOneMoreRetainedBranch = projectSettlementDebt(
      [owner.record, blocked.record],
      {
        now: Date.parse("2026-08-12T12:00:00.000Z"),
        autoSettled: 48,
        unavailableNames: 7,
        namePoolTotal: NAME_POOL.length,
        liveAgentIds: new Set<string>(),
      },
    );
    expect(withOneMoreRetainedBranch.namePoolFree).toBe(
      projected.namePoolFree - 1,
    );

    const midRebase = await store.update(blocked, {
      ...blocked.record,
      state: "settling",
      owner: "settlement-service",
      reason: "rebase metadata is present",
      due: { nextActionAt: null, watchedTrigger: "git-operation-ended" },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    });
    const settlingProjection = projectSettlementDebt(
      [owner.record, midRebase.record],
      {
        now: Date.parse("2026-08-12T12:00:00.000Z"),
        autoSettled: 48,
        unavailableNames: 6,
        namePoolTotal: NAME_POOL.length,
        liveAgentIds: new Set<string>(),
      },
    );
    expect(settlingProjection.total).toBe(50);
    expect(settlingProjection.settling).toBe(1);
    blocked = await store.update(midRebase, {
      ...midRebase.record,
      state: "blocked",
      owner: "queen",
      reason: "waiting for a named dependency",
      due: { nextActionAt: null, watchedTrigger: "dependency-completed" },
      blockedOn: "task-dependency",
      reviewAt: null,
      proofDigest: null,
    });

    const db = new HiveDatabase(":memory:");
    const bodies: string[] = [];
    let now = Date.parse("2026-08-12T12:00:00.000Z");
    const service = () =>
      new WorktreeLifecycleService({
        db,
        repoRoot: repo,
        clock: () => new Date(now),
        publish: async (_from, _to, body) => {
          bodies.push(body);
        },
        assessStrandedWork,
        listSettlementBranches,
        reconcileOrphanedWorktrees,
      });
    expect((await service().updateSettlementDebt()).published).toBe(true);
    expect((await service().updateSettlementDebt()).published).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("50 cases");
    expect(bodies[0]).toContain("case-revision digest");

    const beforeRemeasure = await store.readAggregate();
    const currentBlocked = await store.read(blocked.record.caseId);
    if (currentBlocked === null) throw new Error("blocked case disappeared");
    blocked = await store.update(currentBlocked, { ...currentBlocked.record });
    expect((await service().updateSettlementDebt()).published).toBe(false);
    const afterRemeasure = await store.readAggregate();
    expect(afterRemeasure?.record.digest).not.toBe(
      beforeRemeasure?.record.digest,
    );
    expect(afterRemeasure?.record.noticeDigest).toBe(
      beforeRemeasure?.record.noticeDigest,
    );
    expect(bodies).toHaveLength(1);

    now += 60 * 60_000;
    expect((await service().updateSettlementDebt()).published).toBe(false);
    expect(bodies).toHaveLength(1);

    now += 2 * 24 * 60 * 60_000;
    expect((await service().updateSettlementDebt()).tierAdvances).toBe(2);
    expect(bodies).toHaveLength(2);
    expect((await service().updateSettlementDebt()).published).toBe(false);
    expect(bodies).toHaveLength(2);

    now += 8 * 24 * 60 * 60_000;
    expect((await service().updateSettlementDebt()).tierAdvances).toBe(2);
    expect(bodies).toHaveLength(3);

    // Past the last configured tier, still with no owner response. Stopping short of it would
    // prove silence over ten days and say nothing about the state the owner actually ends up in.
    now += 20 * 24 * 60 * 60_000;
    expect((await service().updateSettlementDebt()).tierAdvances).toBe(2);
    expect(bodies).toHaveLength(4);
    // The tiers are exhausted, so no later sweep can mint another message on age alone.
    now += 365 * 24 * 60 * 60_000;
    expect((await service().updateSettlementDebt()).tierAdvances).toBe(0);
    expect((await service().updateSettlementDebt()).published).toBe(false);
    expect(bodies).toHaveLength(4);

    const currentOwner = await store.read(owner.record.caseId);
    if (currentOwner === null) throw new Error("owner case disappeared");
    await store.update(currentOwner, {
      ...currentOwner.record,
      state: "resolution-in-progress",
      owner: "resolver",
      reason: "resolver lease is active",
      due: { nextActionAt: null, watchedTrigger: "resolver-completed" },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    });
    expect((await service().updateSettlementDebt()).published).toBe(true);
    expect(bodies).toHaveLength(5);
    expect(bodies.at(-1)).toContain("1 resolving");
    db.close();
  });
});

describe("settlement debt orchestrator notice", () => {
  test("only decision-bearing counts justify a wake", () => {
    const quiet = projectSettlementDebt([], {
      now: Date.parse("2026-08-15T12:00:00.000Z"),
      autoSettled: 22,
      unavailableNames: 3,
      namePoolTotal: NAME_POOL.length,
      liveAgentIds: new Set<string>(),
    });
    expect(quiet.blocked).toBe(0);
    expect(quiet.ownerDecision).toBe(0);
    expect(quiet.measurementBlocked).toBe(0);
    expect(settlementDebtNeedsNotice(quiet)).toBe(false);
    expect(
      settlementDebtCondition({ ...quiet, autoSettled: quiet.autoSettled + 1 }),
    ).not.toBe(settlementDebtCondition(quiet));

    expect(
      settlementDebtNeedsNotice({
        blocked: 1,
        ownerDecision: 0,
        measurementBlocked: 0,
        resolvingLiveAgent: 0,
      }),
    ).toBe(true);
    expect(
      settlementDebtNeedsNotice({
        blocked: 0,
        ownerDecision: 1,
        measurementBlocked: 0,
        resolvingLiveAgent: 0,
      }),
    ).toBe(true);
    expect(
      settlementDebtNeedsNotice({
        blocked: 0,
        ownerDecision: 0,
        measurementBlocked: 1,
        resolvingLiveAgent: 0,
      }),
    ).toBe(true);
  });

  test("a resolving case contradicts itself only while its agent is alive", async () => {
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-live-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# live\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const tip = await git(repo, "rev-parse", "main");
    const store = new SettlementCaseStore(repo);
    const opened = await store.open({
      agentId: "agent-nadia",
      agentName: "nadia",
      generation: 1,
      worktreePath: join(repo, ".hive", "worktrees", "nadia"),
      branch: "hive/nadia-work",
      baseOid: tip,
      now: "2026-08-15T12:00:00.000Z",
      reason: "discovered unlanded branch is awaiting settlement",
    });
    const resolving = await store.update(opened, {
      ...opened.record,
      state: "needs-integration",
      owner: "resolver",
      reason: "1 commit(s) are not accounted for on main",
      due: { nextActionAt: "2026-08-15T12:00:00.000Z", watchedTrigger: null },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    });
    const project = (liveAgentIds: ReadonlySet<string>) =>
      projectSettlementDebt([resolving.record], {
        now: Date.parse("2026-08-15T12:00:00.000Z"),
        autoSettled: 0,
        unavailableNames: 1,
        namePoolTotal: NAME_POOL.length,
        liveAgentIds,
      });

    // Alive: the sweep has filed a branch its author is still writing to.
    const live = project(new Set(["agent-nadia"]));
    expect(live.resolving).toBe(1);
    expect(live.resolvingLiveAgent).toBe(1);
    expect(renderSettlementDebt(live)).toContain("1 resolving (1 live-agent)");
    expect(settlementDebtNeedsNotice(live)).toBe(true);

    // The same case once that agent is gone: ordinary residue, and imani's
    // exclusion still holds — it is counted, rendered plainly, and wakes nobody.
    const dead = project(new Set(["agent-someone-else"]));
    expect(dead.resolving).toBe(1);
    expect(dead.resolvingLiveAgent).toBe(0);
    expect(renderSettlementDebt(dead)).toContain("1 resolving ·");
    expect(renderSettlementDebt(dead)).not.toContain("live-agent");
    expect(settlementDebtNeedsNotice(dead)).toBe(false);

    // A case owned by nobody cannot be contradicted by a live agent either.
    const unowned = await store.update(resolving, {
      ...resolving.record,
      agentId: null,
      agentName: null,
    });
    const orphan = projectSettlementDebt([unowned.record], {
      now: Date.parse("2026-08-15T12:00:00.000Z"),
      autoSettled: 0,
      unavailableNames: 1,
      namePoolTotal: NAME_POOL.length,
      liveAgentIds: new Set(["agent-nadia"]),
    });
    expect(orphan.resolving).toBe(1);
    expect(orphan.resolvingLiveAgent).toBe(0);
    expect(settlementDebtNeedsNotice(orphan)).toBe(false);
  });

  test("a parked case is blocked, so it still wakes", async () => {
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-parked-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# parked\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const tip = await git(repo, "rev-parse", "main");
    const store = new SettlementCaseStore(repo);
    const firstSeenAt = "2026-08-15T12:00:00.000Z";
    const opened = await store.open({
      agentId: null,
      agentName: "maya",
      generation: null,
      worktreePath: null,
      branch: "hive/maya-parked",
      baseOid: tip,
      now: firstSeenAt,
      reason: "failed-spawn retention",
    });
    await store.update(opened, {
      ...opened.record,
      state: "parked",
      owner: "queen",
      reason: "failed-spawn worktree retention was requested by configuration",
      due: { nextActionAt: null, watchedTrigger: "review-at" },
      blockedOn: null,
      reviewAt: "2026-08-22T12:00:00.000Z",
      proofDigest: null,
    });
    const db = new HiveDatabase(":memory:");
    const bodies: string[] = [];
    const service = new WorktreeLifecycleService({
      db,
      repoRoot: repo,
      clock: () => new Date(firstSeenAt),
      publish: async (_from, _to, body) => {
        bodies.push(body);
      },
      assessStrandedWork,
      listSettlementBranches,
      reconcileOrphanedWorktrees,
    });
    try {
      const result = await service.updateSettlementDebt();
      expect(result.aggregate.blocked).toBe(1);
      expect(result.published).toBe(true);
      expect(bodies).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("healthy fleet churn is silent and each decision-bearing state still publishes", async () => {
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-quiet-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# quiet\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const tip = await git(repo, "rev-parse", "main");
    const store = new SettlementCaseStore(repo);
    const firstSeenAt = "2026-08-15T12:00:00.000Z";
    const active = await store.open({
      agentId: "agent-maya",
      agentName: "maya",
      generation: 1,
      worktreePath: join(repo, "maya"),
      branch: "hive/maya-quiet",
      baseOid: tip,
      now: firstSeenAt,
      reason: "agent generation owns an active worktree bundle",
    });
    const db = new HiveDatabase(":memory:");
    const bodies: string[] = [];
    const now = Date.parse(firstSeenAt);
    const service = () =>
      new WorktreeLifecycleService({
        db,
        repoRoot: repo,
        clock: () => new Date(now),
        publish: async (_from, _to, body) => {
          bodies.push(body);
        },
        assessStrandedWork,
        listSettlementBranches,
        reconcileOrphanedWorktrees,
      });
    try {
      const first = await service().updateSettlementDebt();
      expect(first.aggregate.active).toBe(1);
      expect(first.aggregate.blocked).toBe(0);
      expect(first.aggregate.ownerDecision).toBe(0);
      expect(first.aggregate.measurementBlocked).toBe(0);
      expect(first.published).toBe(false);
      expect(bodies).toHaveLength(0);

      await store.open({
        agentId: "agent-nora",
        agentName: "nora",
        generation: 1,
        worktreePath: join(repo, "nora"),
        branch: "hive/nora-quiet",
        baseOid: tip,
        now: firstSeenAt,
        reason: "agent generation owns an active worktree bundle",
      });
      const spawned = await service().updateSettlementDebt();
      expect(spawned.aggregate.active).toBe(2);
      expect(spawned.published).toBe(false);
      expect(bodies).toHaveLength(0);

      const current = await store.read(active.record.caseId);
      if (current === null) throw new Error("active case disappeared");
      await store.update(current, {
        ...current.record,
        state: "measurement-blocked",
        owner: "settlement-service",
        reason:
          "the settlement case names an agent generation but its row is absent",
        due: { nextActionAt: firstSeenAt, watchedTrigger: null },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });
      const blockedMeasure = await service().updateSettlementDebt();
      expect(blockedMeasure.aggregate.measurementBlocked).toBe(1);
      expect(blockedMeasure.published).toBe(true);
      expect(bodies).toHaveLength(1);

      const measured = await store.read(active.record.caseId);
      if (measured === null) throw new Error("measured case disappeared");
      await store.update(measured, {
        ...measured.record,
        state: "active",
        owner: "agent",
        reason: "agent generation owns an active worktree bundle",
        due: { nextActionAt: null, watchedTrigger: "agent-generation-ended" },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });
      const cleared = await service().updateSettlementDebt();
      expect(cleared.aggregate.measurementBlocked).toBe(0);
      expect(cleared.aggregate.active).toBe(2);
      expect(cleared.published).toBe(false);
      expect(bodies).toHaveLength(1);

      const live = await store.read(active.record.caseId);
      if (live === null) throw new Error("cleared case disappeared");
      await store.update(live, {
        ...live.record,
        state: "blocked",
        owner: "queen",
        reason: "waiting for a named dependency",
        due: { nextActionAt: null, watchedTrigger: "dependency-completed" },
        blockedOn: "task-dependency",
        reviewAt: null,
        proofDigest: null,
      });
      const blocked = await service().updateSettlementDebt();
      expect(blocked.aggregate.blocked).toBe(1);
      expect(blocked.published).toBe(true);
      expect(bodies).toHaveLength(2);

      const waiting = await store.read(active.record.caseId);
      if (waiting === null) throw new Error("blocked case disappeared");
      await store.update(waiting, {
        ...waiting.record,
        state: "owner-decision",
        owner: "user",
        reason: "content needs a product decision",
        due: { nextActionAt: firstSeenAt, watchedTrigger: null },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });
      const decided = await service().updateSettlementDebt();
      expect(decided.aggregate.ownerDecision).toBe(1);
      expect(decided.published).toBe(true);
      expect(bodies).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
