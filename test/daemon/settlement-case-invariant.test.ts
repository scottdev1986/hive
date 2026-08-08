import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessStrandedWork,
  listSettlementBranches,
  reconcileOrphanedWorktrees,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  SettlementCaseSchema,
  SettlementCaseStore,
  type SettlementCase,
  type StoredSettlementCase,
} from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

/**
 * Every open settlement case must have a way out. A case with none is preserved forever with
 * nobody to ask and nothing to ask them — the failure this service exists to prevent, which its
 * own implementation has now exhibited three separate times, each found by a different accident.
 *
 * Each state declares which ways out it has and every declared one is exercised here. The
 * invariant is that the declared set is never empty, not that any particular way out is present:
 * requiring all of them of all states would demand that `parked` be re-measured, destroying the
 * deliberate hold it exists to express, and that `active` time out, killing a live agent's case.
 *
 * WHAT THIS CANNOT COVER. It reasons about the state machine, not about whether a pass measures
 * correctly once it gets there. A pass that selects a case and then reaches a wrong conclusion is
 * still reachable by this test, and a clock that fires into a no-op still counts as a clock. The
 * question answered here is only "can anything ever happen to a case in this state", which is the
 * question that was answered wrongly three times. It also cannot see a way out that lives outside
 * this process — a trigger some other component promises to fire is taken on faith, so a state
 * relying on one is only as sound as that promise.
 */

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

/**
 * The states the schema accepts, read off the schema itself. A state added to the discriminated
 * union appears here without anyone remembering to add it, which is the point: the defect this
 * test exists to catch is a state nobody established a way out for.
 */
function statesFromSchema(): string[] {
  return SettlementCaseSchema.options.flatMap((option) => {
    const state: unknown = option.shape.state;
    const enumerated = (state as { options?: unknown }).options;
    if (Array.isArray(enumerated)) return enumerated as string[];
    const literal = (state as { value?: unknown }).value;
    return typeof literal === "string" ? [literal] : [];
  });
}

const FIRST_SEEN_AT = "2026-08-12T12:00:00.000Z";

/**
 * The two ways a case can stop being stuck. `sweep` means a measurement pass selects and rewrites
 * it even when the live world names nothing of its bundle; `clock` means elapsed time alone
 * advances it. Neither subsumes the other: a deliberate hold like `parked` must NOT be re-measured
 * or the hold is destroyed, and a live agent's case must NOT time out, so states legitimately
 * differ in which they have.
 */
type WayOut = "sweep" | "clock";

interface StateContract {
  /** Every way out this state has. Non-empty by type: a state with none is the defect itself. */
  readonly waysOut: readonly [WayOut, ...WayOut[]];
  readonly build: (base: SettlementCase) => SettlementCase;
}

/**
 * One contract per state, and the compile-time half of the enumeration: a total Record over the
 * state union, so a new state fails `tsc` here rather than being silently skipped, and the
 * non-empty tuple means it cannot be added without naming how a case in it ever gets out. The
 * runtime cross-check below proves the two halves still agree — a schema read that quietly
 * returned nothing would otherwise leave every assertion iterating an empty list and passing.
 */
const CASES: Record<SettlementCase["state"], StateContract> = {
  active: {
    waysOut: ["sweep"],
    build: (base) =>
      ({
        ...base,
        state: "active",
        owner: "agent",
        reason: "agent generation owns an active worktree bundle",
        due: { nextActionAt: null, watchedTrigger: "agent-generation-ended" },
      }) as SettlementCase,
  },
  settling: {
    waysOut: ["sweep"],
    build: (base) =>
      ({
        ...base,
        state: "settling",
        owner: "settlement-service",
        reason: "termination is in flight",
      }) as SettlementCase,
  },
  assessing: {
    waysOut: ["sweep"],
    build: (base) =>
      ({
        ...base,
        state: "assessing",
        owner: "settlement-service",
        reason: "settlement service is acquiring one consistent measurement",
      }) as SettlementCase,
  },
  "needs-integration": {
    waysOut: ["sweep", "clock"],
    build: (base) =>
      ({
        ...base,
        state: "needs-integration",
        owner: "resolver",
        reason: "1 commit(s) are not accounted for on main",
      }) as SettlementCase,
  },
  "resolution-in-progress": {
    // A resolver holding a lease is not re-measured, so the clock is the only thing that can end
    // an abandoned lease. Without it a case here waits on a resolver that may never return.
    waysOut: ["clock"],
    build: (base) =>
      ({
        ...base,
        state: "resolution-in-progress",
        owner: "resolver",
        reason: "resolver lease is active",
        due: { nextActionAt: null, watchedTrigger: "resolver-completed" },
      }) as SettlementCase,
  },
  "owner-decision": {
    waysOut: ["clock"],
    build: (base) =>
      ({
        ...base,
        state: "owner-decision",
        owner: "user",
        reason: "content needs a product decision",
      }) as SettlementCase,
  },
  "measurement-blocked": {
    waysOut: ["sweep"],
    build: (base) =>
      ({
        ...base,
        state: "measurement-blocked",
        owner: "settlement-service",
        reason: "an instrument failed while the worktree was still there",
      }) as SettlementCase,
  },
  blocked: {
    waysOut: ["clock"],
    build: (base) =>
      ({
        ...base,
        state: "blocked",
        owner: "queen",
        reason: "waiting for a named dependency",
        blockedOn: "task-dependency",
      }) as SettlementCase,
  },
  parked: {
    waysOut: ["clock"],
    build: (base) =>
      ({
        ...base,
        state: "parked",
        owner: "user",
        reason: "deliberate retention",
        due: { nextActionAt: null, watchedTrigger: "review-due" },
        reviewAt: FIRST_SEEN_AT,
      }) as SettlementCase,
  },
  "safe-release": {
    waysOut: ["sweep"],
    build: (base) =>
      ({
        ...base,
        state: "safe-release",
        owner: "settlement-service",
        reason: "exact content accounted for",
        due: { nextActionAt: FIRST_SEEN_AT, watchedTrigger: null },
        proofDigest: "a".repeat(64),
      }) as SettlementCase,
  },
};

/**
 * A repository whose settlement case names a bundle that is entirely gone: no worktree directory,
 * no registration, no branch, no stewardship ref. That is the live shape three cases were stuck in.
 *
 * Only the all-absent combination is built, deliberately. Every partial absence leaves something
 * the live world still names — a branch in the inventory, a registered worktree, a stewardship ref
 * — and each of those is the selector for a pass that then reaches the case. All-absent is the one
 * combination where no such selector exists, so it is the strictest case and the only one that was
 * ever the bug. Enumerating the partial combinations would multiply the fixture count without
 * asking a question the passes can fail.
 */
async function fixture(state: SettlementCase["state"]) {
  const root = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "settlement-invariant-"),
  );
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# invariant\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  const store = new SettlementCaseStore(repo);
  const opened = await store.open({
    agentId: null,
    agentName: "maya",
    generation: null,
    worktreePath: join(repo, ".hive", "worktrees", "maya"),
    branch: "hive/maya-invariant",
    baseOid: await git(repo, "rev-parse", "main"),
    now: FIRST_SEEN_AT,
    reason: "synthetic case",
  });
  const stored = await store.update(opened, CASES[state].build(opened.record));
  expect(stored.record.state).toBe(state);
  return { repo, store, stored };
}

function service(repo: string, db: HiveDatabase, now: () => number) {
  return new WorktreeLifecycleService({
    db,
    repoRoot: repo,
    clock: () => new Date(now()),
    publish: async () => {},
    assessStrandedWork,
    listSettlementBranches,
    reconcileOrphanedWorktrees,
    processLiveness: async () => "dead",
  });
}

/** Whether anything wrote to the case: it settled, or its stored object was rewritten. */
async function advanced(
  store: SettlementCaseStore,
  before: StoredSettlementCase,
): Promise<boolean> {
  const after = await store.read(before.record.caseId);
  return after === null || after.objectOid !== before.objectOid;
}

describe("every open settlement case has a way out", () => {
  const states = statesFromSchema();

  test("the schema enumeration and the declared cases name the same states", () => {
    // The positive control for both assertions below. If reading the schema ever returns nothing,
    // every per-state test would iterate an empty list and report success without testing a thing.
    expect(states.length).toBeGreaterThan(0);
    expect([...states].sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const state of states) {
    const typed = state as SettlementCase["state"];
    const contract = CASES[typed];

    if (contract.waysOut.includes("sweep")) {
      test(`${state} gets out by sweep: a pass re-measures it when the world names nothing`, async () => {
        const { repo, store, stored } = await fixture(typed);
        const db = new HiveDatabase(":memory:");
        try {
          // The clock does not move, so no escalation tier can fire. Anything that rewrites the
          // case here is a measurement pass reaching it, not a timer touching it on the way past.
          await service(repo, db, () => Date.parse(FIRST_SEEN_AT))
            .reconcileOrphanedWorktrees()
            .catch(() => undefined);
          expect(await advanced(store, stored)).toBe(true);
        } finally {
          db.close();
        }
      });
    }

    if (contract.waysOut.includes("clock")) {
      test(`${state} gets out by clock: time alone eventually advances it`, async () => {
        const { repo, store, stored } = await fixture(typed);
        const db = new HiveDatabase(":memory:");
        try {
          // Only the debt pass runs, so this isolates the clock from the measurement passes: no
          // sweep can reach the case, and the only thing that changed is how much time has passed.
          const later = Date.parse(FIRST_SEEN_AT) + 400 * 24 * 60 * 60_000;
          await service(repo, db, () => later).updateSettlementDebt();
          expect(await advanced(store, stored)).toBe(true);
        } finally {
          db.close();
        }
      });
    }
  }
});
