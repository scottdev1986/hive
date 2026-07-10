import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearCreationLeases,
  evidenceOf,
  clearVolumeCache,
  describeVolume,
  FoundationBookmarkProvider,
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  NullBookmarkProvider,
  probeGit,
  ProjectRegistry,
  resolveOrCreate,
  resolveProject,
  sanitizedGitEnv,
  setVolumeHelperPath,
  UnauthenticatedLedgerAccess,
} from "../src/index";
import type { BookmarkProvider, ResolveOptions, Resolution } from "../src/index";
import { attachDiskImage, buildGitTopology, commitFile, DiskImageUnavailable, git, tempRoot } from "./fixtures";
import { ensureFsidHelper } from "./helper";

export type ScenarioStatus = "pass" | "fail" | "skipped";

export interface ScenarioResult {
  id: string;
  title: string;
  status: ScenarioStatus;
  /** What a pass establishes about the blueprint. */
  proves: string;
  /** Raw measured facts, quoted verbatim into the evidence log. */
  observations: string[];
  detail?: string;
}

class Check {
  readonly observations: string[] = [];
  note(line: string): void {
    this.observations.push(line);
  }
  assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }
  equal<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

interface Ctx {
  root: string;
  options: ResolveOptions;
  registry: ProjectRegistry;
  ledger: InMemoryManagedWorktreeLedger;
  bookmarks: BookmarkProvider;
}

function newContext(root: string, bookmarks: BookmarkProvider): Ctx {
  const registry = new ProjectRegistry();
  const ledger = new InMemoryManagedWorktreeLedger();
  return {
    root,
    registry,
    ledger,
    bookmarks,
    options: {
      registry,
      ledger,
      ledgerCapability: LedgerCapability.issue("supervisor"),
      bookmarks,
    },
  };
}

/** Register a project the way `hive init` would, and return its HiveUUID. */
function register(ctx: Ctx, dir: string, idempotencyKey = dir): string {
  const result = resolveOrCreate(dir, ctx.options, idempotencyKey);
  if (result.status !== "RESOLVED") {
    throw new Error(`expected RESOLVED registering ${dir}, got ${result.status}`);
  }
  return result.hiveUuid;
}

/** The explicit create an operator must perform after a tombstone. */
function explicitCreate(ctx: Ctx, resolution: Resolution): string {
  if (resolution.status !== "NEEDS_SETUP") throw new Error("explicitCreate needs NEEDS_SETUP");
  const bookmark = ctx.bookmarks.available ? ctx.bookmarks.create(resolution.key.canonicalPath) : null;
  return ctx.registry.create(resolution.key, resolution.evidence, bookmark).hiveUuid;
}

type ScenarioFn = (check: Check) => void;

interface Scenario {
  id: string;
  title: string;
  proves: string;
  run: ScenarioFn;
}

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

function withTopology(bookmarks: BookmarkProvider, body: (ctx: Ctx, t: ReturnType<typeof buildGitTopology>, check: Check) => void): ScenarioFn {
  return (check) => {
    const root = tempRoot();
    try {
      clearCreationLeases();
      const topology = buildGitTopology(root);
      body(newContext(root, bookmarks), topology, check);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function buildScenarios(bookmarks: BookmarkProvider): Scenario[] {
  const scenarios: Scenario[] = [];

  scenarios.push({
    id: "symlink-alias",
    title: "A symlink alias resolves to the same project",
    proves: "Gate 1: nested paths and symlinks resolve to one Hive.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const alias = join(ctx.root, "alias");
      symlinkSync(t.main, alias);
      const viaAlias = resolveProject(alias, ctx.options);
      check.equal(viaAlias.status, "RESOLVED", "alias must resolve");
      if (viaAlias.status !== "RESOLVED") return;
      check.equal(viaAlias.hiveUuid, uuid, "alias must reach the same Hive");
      check.note(`realpath(${alias}) collapsed onto ${viaAlias.key.canonicalPath}`);
    }),
  });

  scenarios.push({
    id: "nested-path",
    title: "A deep subdirectory resolves to the repository root",
    proves: "Step 4: the canonical physical worktree root is the boundary.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const nested = resolveProject(t.nestedPath, ctx.options);
      check.equal(nested.status, "RESOLVED", "nested path must resolve");
      if (nested.status !== "RESOLVED") return;
      check.equal(nested.hiveUuid, uuid, "nested path must reach the root's Hive");
      check.note(`${t.nestedPath} -> ${nested.key.canonicalPath}`);
    }),
  });

  scenarios.push({
    id: "nested-repository",
    title: "A nested independent repository is its own project",
    proves: "Step 4: a nested repository is its own nearest project.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const outer = register(ctx, t.main);
      const inner = register(ctx, t.innerRepo);
      check.assert(outer !== inner, "nested repository must not inherit the outer Hive");
      const innerProbe = probeGit(t.innerRepo);
      check.note(`inner git-common-dir ${innerProbe.gitCommonDir} differs from outer`);
    }),
  });

  scenarios.push({
    id: "submodule",
    title: "A submodule is its own project with its own repo family",
    proves: "Step 4/5: a submodule is its own nearest project and does not share a landing lease.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const mainUuid = register(ctx, t.main);
      const result = resolveOrCreate(t.submodule, ctx.options, "sub");
      check.equal(result.status, "RESOLVED", "submodule must resolve");
      if (result.status !== "RESOLVED") return;
      check.assert(result.hiveUuid !== mainUuid, "submodule must be a distinct Hive");
      check.equal(result.key.kind, "git-submodule", "kind must be git-submodule");
      check.assert(result.key.superprojectRoot === t.main, "superprojectRoot must name the superproject");
      const mainRecord = ctx.registry.findByUuid(mainUuid);
      check.assert(
        result.key.repoFamilyKey !== mainRecord?.repoFamilyKey,
        "submodule must not share the superproject's repo family",
      );
      check.note(`submodule git-dir ${result.key.gitDir}`);
      check.note(`submodule repoFamilyKey ${result.key.repoFamilyKey}`);
    }),
  });

  scenarios.push({
    id: "linked-worktree",
    title: "A user linked worktree is a distinct Hive that shares a repo family",
    proves: "Step 5 + landing lease: distinct identity, shared refs.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const mainUuid = register(ctx, t.main);
      const wt = resolveOrCreate(t.linkedWorktree, ctx.options, "wt");
      check.equal(wt.status, "RESOLVED", "linked worktree must resolve");
      if (wt.status !== "RESOLVED") return;
      check.assert(wt.hiveUuid !== mainUuid, "linked worktree must be a distinct Hive");
      check.equal(wt.key.kind, "git-linked-worktree", "kind must be git-linked-worktree");
      const mainRecord = ctx.registry.findByUuid(mainUuid);
      check.equal(wt.key.repoFamilyKey, mainRecord?.repoFamilyKey ?? null, "must share the repo family");
      check.note(`linked git-dir ${wt.key.gitDir}`);
      check.note(`shared repoFamilyKey ${wt.key.repoFamilyKey}`);
    }),
  });

  scenarios.push({
    id: "separate-clone",
    title: "A separate clone is a distinct Hive with a distinct repo family",
    proves: "Step 5: separate clones are distinct and never share a landing lease.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const mainUuid = register(ctx, t.main);
      const clone = resolveOrCreate(t.clone, ctx.options, "clone");
      check.equal(clone.status, "RESOLVED", "clone must resolve");
      if (clone.status !== "RESOLVED") return;
      check.assert(clone.hiveUuid !== mainUuid, "clone must be a distinct Hive");
      const mainRecord = ctx.registry.findByUuid(mainUuid);
      check.assert(clone.key.repoFamilyKey !== mainRecord?.repoFamilyKey, "clone must have its own repo family");
      check.note(`clone repoFamilyKey ${clone.key.repoFamilyKey}`);
    }),
  });

  scenarios.push({
    id: "bare-repository",
    title: "A bare repository is refused",
    proves: "Step 3 + Gate 1: bare repositories are refused.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const result = resolveProject(t.bare, ctx.options);
      check.equal(result.status, "REJECTED", "bare repository must be rejected");
      if (result.status !== "REJECTED") return;
      check.equal(result.reason, "BARE_REPOSITORY", "rejection reason");
      check.note(`rev-parse --show-toplevel is fatal inside a bare repo; bareness queried separately`);
    }),
  });

  scenarios.push({
    id: "inside-git-dir",
    title: "The .git directory is not a project root",
    proves: "Step 3: only a worktree can be a project.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const result = resolveProject(join(t.main, ".git"), ctx.options);
      check.equal(result.status, "REJECTED", "inside .git must be rejected");
      if (result.status !== "REJECTED") return;
      check.equal(result.reason, "INSIDE_GIT_DIR", "rejection reason");
    }),
  });

  scenarios.push({
    id: "git-env-hijack",
    title: "A hostile GIT_DIR in the environment cannot redirect discovery",
    proves: "Step 3 must sanitize Git's environment before discovery.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const hijacked = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
        cwd: t.main,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: t.bare },
      }).trim();
      check.note(`unsanitized: GIT_DIR=${t.bare} makes rev-parse report ${hijacked}`);
      check.assert(hijacked === t.bare, "the hijack must actually work, or this scenario proves nothing");

      const sanitized = sanitizedGitEnv({ ...process.env, GIT_DIR: t.bare });
      check.assert(sanitized["GIT_DIR"] === undefined, "GIT_DIR must be stripped");

      const original = process.env["GIT_DIR"];
      process.env["GIT_DIR"] = t.bare;
      try {
        const probe = probeGit(t.main);
        check.equal(probe.gitDir, join(t.main, ".git"), "sanitized discovery must ignore GIT_DIR");
        check.note(`sanitized: probeGit reports ${probe.gitDir}`);
      } finally {
        if (original === undefined) delete process.env["GIT_DIR"];
        else process.env["GIT_DIR"] = original;
      }
    }),
  });

  scenarios.push({
    id: "rename",
    title: "Renaming a project root requires a confirmed rebind",
    proves: "Gate 2: moved projects require confirmed rebind, and the HiveUUID survives.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const renamed = join(ctx.root, "renamed");
      renameSync(t.main, renamed);

      const result = resolveProject(renamed, ctx.options);
      check.equal(result.status, "NEEDS_REBIND", "a renamed project must not silently attach");
      if (result.status !== "NEEDS_REBIND") return;
      check.equal(result.reason, "MOVED", "rebind reason");
      check.equal(result.hiveUuid, uuid, "the HiveUUID must be preserved across the move");
      check.note(`rename detected by evidence: ino unchanged at ${statSync(renamed).ino}`);

      const rebound = ctx.registry.rebind(uuid, result.key, evidenceOf(renamed), ctx.bookmarks.create(renamed));
      check.equal(rebound.hiveUuid, uuid, "rebind preserves the Hive");
      const after = resolveProject(renamed, ctx.options);
      check.equal(after.status, "RESOLVED", "after an explicit rebind the project resolves");
    }),
  });

  scenarios.push({
    id: "move-across-parents",
    title: "Moving a project to a different parent directory requires a rebind",
    proves: "Gate 2, for a move that changes more than the leaf name.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const newParent = join(ctx.root, "elsewhere");
      mkdirSync(newParent);
      const moved = join(newParent, "project");
      renameSync(t.main, moved);

      const result = resolveProject(moved, ctx.options);
      check.equal(result.status, "NEEDS_REBIND", "moved project must not silently attach");
      if (result.status !== "NEEDS_REBIND") return;
      check.equal(result.hiveUuid, uuid, "HiveUUID preserved");
      check.equal(result.confirmedCanonicalPath, t.main, "the stale confirmed path is reported");
    }),
  });

  scenarios.push({
    id: "move-then-impostor",
    title: "A fresh directory at a moved project's old path never inherits it",
    proves:
      "The decisive case. A plain bookmark resolves path-first, so it points at the impostor " +
      "and AGREES with the confirmed path. Only filesystem evidence refuses.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const record = ctx.registry.findByUuid(uuid);
      const moved = join(ctx.root, "moved-project");
      renameSync(t.main, moved);

      // An unrelated directory takes over the old path while the real project lives on.
      mkdirSync(t.main);
      writeFileSync(join(t.main, "IMPOSTOR"), "not the project");

      if (ctx.bookmarks.available && record?.bookmark) {
        const resolved = ctx.bookmarks.resolve(record.bookmark);
        check.note(`bookmark resolved to ${resolved?.path} (isStale=${resolved?.isStale})`);
        check.assert(resolved?.path === t.main, "measured: the bookmark abandons the moved dir for the impostor");
        check.note(`the real project is alive at ${moved}, yet the bookmark points at ${t.main}`);
        check.note(`bookmark path == confirmed path, so a path comparison would have ATTACHED the impostor`);
      }

      const atOldPath = resolveProject(t.main, ctx.options);
      check.equal(atOldPath.status, "NEEDS_SETUP", "the impostor must not resolve to the old Hive");
      if (atOldPath.status !== "NEEDS_SETUP") return;
      check.equal(atOldPath.reason, "TOMBSTONED_PATH", "the old path must be tombstoned");
      check.equal(atOldPath.formerHiveUuid, uuid, "the tombstone names the evicted Hive");
      check.note(`refusal came from evidence: ino ${record?.evidence.ino} != ${statSync(t.main).ino}`);

      const atNewPath = resolveProject(moved, ctx.options);
      check.equal(atNewPath.status, "NEEDS_REBIND", "the real project is still findable at its new path");
      if (atNewPath.status !== "NEEDS_REBIND") return;
      check.equal(atNewPath.hiveUuid, uuid, "found by inode, not by bookmark");
    }),
  });

  scenarios.push({
    id: "delete-recreate",
    title: "A deleted and recreated path never inherits the old identity",
    proves: "Gate 2: deleted/recreated paths never inherit automatically.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuid = register(ctx, t.main);
      const beforeIno = statSync(t.main).ino;

      rmSync(t.main, { recursive: true, force: true });
      mkdirSync(t.main);
      git(t.main, "init", "-q", "-b", "main");
      commitFile(t.main, "README.md");
      const afterIno = statSync(t.main).ino;
      check.note(`ino before ${beforeIno}, after ${afterIno}`);
      check.assert(beforeIno !== afterIno, "APFS did not reuse the inode");

      const result = resolveProject(t.main, ctx.options);
      check.equal(result.status, "NEEDS_SETUP", "recreated path must not inherit");
      if (result.status !== "NEEDS_SETUP") return;
      check.equal(result.reason, "TOMBSTONED_PATH", "the old identity is tombstoned");
      check.equal(result.formerHiveUuid, uuid, "the tombstone names the old Hive");

      const fresh = explicitCreate(ctx, result);
      check.assert(fresh !== uuid, "an explicit create mints a new HiveUUID");
      check.note(`explicit create minted ${fresh}, not ${uuid}`);

      const old = ctx.registry.findByUuid(uuid);
      check.equal(old?.state, "NEEDS_REBIND", "the evicted Hive survives in NEEDS_REBIND, not silently deleted");
    }),
  });

  scenarios.push({
    id: "plain-directory",
    title: "A plain directory uses its exact canonical root",
    proves: "Step 6: plain directories do not adopt ancestors or descendants.",
    run: withTopology(bookmarks, (ctx, _t, check) => {
      const plain = join(ctx.root, "plain");
      mkdirSync(join(plain, "child"), { recursive: true });
      const uuid = register(ctx, plain);

      const child = resolveProject(join(plain, "child"), ctx.options);
      check.equal(child.status, "AMBIGUOUS_PLAIN_ANCESTOR", "a registered plain ancestor forces a choice");
      if (child.status !== "AMBIGUOUS_PLAIN_ANCESTOR") return;
      check.equal(child.ancestorHiveUuid, uuid, "the ancestor is named");
      check.note(`child ${child.key.canonicalPath} did not silently attach to ${child.ancestorPath}`);
    }),
  });

  scenarios.push({
    id: "use-parent",
    title: "Use Parent is ephemeral: legal before the child is registered, refused after",
    proves: "Step 4: 'Use Parent' is an ephemeral override only before registration.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const outer = register(ctx, t.main);

      const before = resolveProject(t.innerRepo, { ...ctx.options, useParent: true });
      check.equal(before.status, "RESOLVED", "Use Parent resolves to the parent before registration");
      if (before.status !== "RESOLVED") return;
      check.equal(before.hiveUuid, outer, "Use Parent selects the outer Hive");

      register(ctx, t.innerRepo, "inner");
      const after = resolveProject(t.innerRepo, { ...ctx.options, useParent: true });
      check.equal(after.status, "REJECTED", "Use Parent is refused once the child exists");
      if (after.status !== "REJECTED") return;
      check.equal(after.reason, "USE_PARENT_AFTER_REGISTRATION", "rejection reason");
    }),
  });

  scenarios.push({
    id: "managed-worktree-ledger",
    title: "Managed-worktree ownership comes from the authenticated ledger, never from a repo file",
    proves: "Step 2: a repository file cannot assert managed-worktree ownership.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const owner = register(ctx, t.main);

      // A hostile repository plants a manifest claiming to be a managed worktree.
      mkdirSync(join(t.linkedWorktree, ".hive"), { recursive: true });
      writeFileSync(
        join(t.linkedWorktree, ".hive", "owner.json"),
        JSON.stringify({ owningHiveUuid: owner, paneId: "pane-0" }),
      );
      const unclaimed = resolveOrCreate(t.linkedWorktree, ctx.options, "wt");
      check.equal(unclaimed.status, "RESOLVED", "resolves");
      if (unclaimed.status !== "RESOLVED") return;
      check.assert(unclaimed.hiveUuid !== owner, "the planted file did NOT grant ownership");
      check.note(`.hive/owner.json claimed ${owner}; resolver assigned ${unclaimed.hiveUuid}`);

      // The Supervisor's ledger, and only it, can assert ownership.
      ctx.ledger.register({
        canonicalPath: t.linkedWorktree,
        owningHiveUuid: owner,
        paneId: "pane-3",
        agentName: "nina",
      });
      const claimed = resolveProject(t.linkedWorktree, ctx.options);
      check.equal(claimed.status, "RESOLVED", "ledger-owned worktree resolves");
      if (claimed.status !== "RESOLVED") return;
      check.equal(claimed.hiveUuid, owner, "the ledger routes it to the owning Hive");
      check.equal(claimed.key.kind, "managed-worktree", "kind reflects ledger ownership");

      let threw = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.ledger.lookup(t.linkedWorktree, { subject: "forged" } as any);
      } catch (error) {
        threw = error instanceof UnauthenticatedLedgerAccess;
      }
      check.assert(threw, "a forged capability cannot read the ledger");
    }),
  });

  scenarios.push({
    id: "concurrent-starts",
    title: "Twenty simultaneous starts for one root yield one HiveUUID",
    proves: "Gate 3: resolveOrCreate runs under a unique constraint and creation lease.",
    run: withTopology(bookmarks, (ctx, t, check) => {
      const uuids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const result = resolveOrCreate(t.main, ctx.options, "start-idem");
        if (result.status === "RESOLVED") uuids.add(result.hiveUuid);
      }
      check.equal(uuids.size, 1, "exactly one HiveUUID");
      check.equal(ctx.registry.size, 1, "exactly one registry record");
      check.note(`20 starts -> ${[...uuids][0]}`);
    }),
  });

  scenarios.push({
    id: "bookmark-path-first",
    title: "Plain Foundation bookmarks resolve path-first, not file-ID-first",
    proves:
      "Overturns the blueprint's premise that bookmarks 'follow moves silently'. They follow a " +
      "move only while the old path stays vacant.",
    run: (check) => {
      if (!bookmarks.available) throw new SkipScenario("swiftc unavailable; no Foundation bookmarks");
      const root = tempRoot();
      try {
        const a = join(root, "A");
        const b = join(root, "B");
        mkdirSync(a);
        const bookmark = bookmarks.create(a);
        check.assert(bookmark !== null, "bookmark created");
        if (!bookmark) return;

        const quiet = bookmarks.resolve(bookmark);
        check.equal(quiet?.isStale, false, "an untouched directory is not stale");

        renameSync(a, b);
        const afterMove = bookmarks.resolve(bookmark);
        check.equal(afterMove?.path, b, "with A vacant, the bookmark follows the move to B");
        check.equal(afterMove?.isStale, true, "and reports isStale");
        check.note(`after move: path=${afterMove?.path} isStale=${afterMove?.isStale}`);

        mkdirSync(a); // impostor
        const afterImpostor = bookmarks.resolve(bookmark);
        check.equal(afterImpostor?.path, a, "once A is repopulated the bookmark abandons B for A");
        check.note(`after impostor: path=${afterImpostor?.path} isStale=${afterImpostor?.isStale}`);
        check.assert(statSync(a).ino !== statSync(b).ino, "A and B are different inodes");
        check.note(`B still exists (ino ${statSync(b).ino}); bookmark chose A (ino ${statSync(a).ino})`);

        rmSync(b, { recursive: true });
        const afterDelete = bookmarks.resolve(bookmark);
        check.equal(afterDelete?.path, a, "with the real directory deleted the bookmark still names A");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  });

  scenarios.push({
    id: "inode-reuse",
    title: "APFS does not reuse directory inode numbers across delete/create",
    proves: "Filesystem evidence is a reliable *refusal* signal on APFS.",
    run: (check) => {
      const root = tempRoot();
      try {
        const seen = new Set<number>();
        const probe = join(root, "probe");
        for (let i = 0; i < 500; i++) {
          mkdirSync(probe);
          seen.add(statSync(probe).ino);
          rmSync(probe, { recursive: true });
        }
        check.equal(seen.size, 500, "500 create/delete cycles produced 500 distinct inodes");
        check.note(`500 cycles, ${seen.size} distinct inode numbers, 0 reuses`);
        check.note("this is measured behavior, not an APFS guarantee; birthtimeMs is the second signal");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  });

  scenarios.push({
    id: "case-insensitive-volume",
    title: "On a case-insensitive volume, Foo and foo are one project",
    proves: "Step 1: canonicalization honors the volume's case behavior.",
    run: onDiskImage(false, bookmarks, (ctx, mount, check) => {
      const dir = join(mount, "Project");
      mkdirSync(dir);
      const volume = describeVolume(dir);
      check.equal(volume.caseSensitive, false, "volume must be case-insensitive");
      check.note(`volume case behavior: caseSensitive=${volume.caseSensitive} via ${volume.caseProvenance}`);

      const uuid = register(ctx, dir);
      const viaLower = resolveProject(join(mount, "project"), ctx.options);
      check.equal(viaLower.status, "RESOLVED", "the lowercase spelling resolves");
      if (viaLower.status !== "RESOLVED") return;
      check.equal(viaLower.hiveUuid, uuid, "both spellings are one Hive");
      check.note(`realpath rewrote 'project' to on-disk spelling ${viaLower.key.canonicalPath}`);
    }),
  });

  scenarios.push({
    id: "case-sensitive-volume",
    title: "On a case-sensitive volume, Foo and foo are two projects",
    proves: "Step 1: identity-key folding must never merge two real directories.",
    run: onDiskImage(true, bookmarks, (ctx, mount, check) => {
      const upper = join(mount, "Project");
      const lower = join(mount, "project");
      mkdirSync(upper);
      mkdirSync(lower);
      const volume = describeVolume(upper);
      check.equal(volume.caseSensitive, true, "volume must be case-sensitive");
      check.note(`volume case behavior: caseSensitive=${volume.caseSensitive} via ${volume.caseProvenance}`);

      const upperUuid = register(ctx, upper, "upper");
      const lowerUuid = register(ctx, lower, "lower");
      check.assert(upperUuid !== lowerUuid, "two directories, two Hives");
      check.note(`Project -> ${upperUuid}`);
      check.note(`project -> ${lowerUuid}`);
    }),
  });

  scenarios.push({
    id: "cross-volume-move",
    title: "A cross-volume move is a copy and must not inherit the old identity",
    proves: "Evidence-based move detection degrades safely: a new inode is a new project.",
    run: onDiskImage(false, bookmarks, (ctx, mount, check) => {
      const source = join(mount, "Project");
      mkdirSync(source);
      const uuid = register(ctx, source);
      const beforeDev = statSync(source).dev;

      const destination = join(ctx.root, "moved-off-volume");
      execFileSync("cp", ["-R", source, destination]);
      rmSync(source, { recursive: true, force: true });

      const afterDev = statSync(destination).dev;
      check.assert(beforeDev !== afterDev, "the copy landed on a different volume");
      check.note(`dev ${beforeDev} -> ${afterDev}; a cross-volume move cannot preserve the inode`);

      const result = resolveProject(destination, ctx.options);
      check.equal(result.status, "NEEDS_SETUP", "the copy is a new project, not the old Hive");
      if (result.status !== "NEEDS_SETUP") return;
      check.equal(result.reason, "NEW_PROJECT", "no evidence links it to the old Hive");
      check.note(`the old Hive ${uuid} is not silently transplanted; it remains registered at its old path`);
    }),
  });

  return scenarios;
}

class SkipScenario extends Error {}

function onDiskImage(
  caseSensitive: boolean,
  bookmarks: BookmarkProvider,
  body: (ctx: Ctx, mount: string, check: Check) => void,
): ScenarioFn {
  return (check) => {
    const root = tempRoot();
    let image;
    try {
      clearCreationLeases();
      clearVolumeCache();
      try {
        image = attachDiskImage(caseSensitive, root);
      } catch (error) {
        if (error instanceof DiskImageUnavailable) throw new SkipScenario(error.message);
        throw error;
      }
      body(newContext(root, bookmarks), image.mountPoint, check);
    } finally {
      image?.detach();
      clearVolumeCache();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function runScenarios(): ScenarioResult[] {
  const helper = ensureFsidHelper();
  setVolumeHelperPath(helper);
  const bookmarks: BookmarkProvider = helper
    ? new FoundationBookmarkProvider(helper)
    : new NullBookmarkProvider();

  return buildScenarios(bookmarks).map((scenario) => {
    const check = new Check();
    try {
      scenario.run(check);
      return { id: scenario.id, title: scenario.title, status: "pass", proves: scenario.proves, observations: check.observations };
    } catch (error) {
      if (error instanceof SkipScenario) {
        return {
          id: scenario.id,
          title: scenario.title,
          status: "skipped",
          proves: scenario.proves,
          observations: check.observations,
          detail: error.message,
        };
      }
      return {
        id: scenario.id,
        title: scenario.title,
        status: "fail",
        proves: scenario.proves,
        observations: check.observations,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export { SkipScenario };
