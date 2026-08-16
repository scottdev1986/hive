import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { projectStrandedManifestEntity } from "../../src/daemon/status-service/status-hierarchy-projection";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import {
  ManifestJournal,
  projectStrandedManifestAttention,
  recoverSubtreeManifests,
} from "../../src/daemon/manifest-journal";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import type { AgentRecord } from "../../src/schemas/agent";
import type { DelegationGrant } from "../../src/schemas/hierarchy-node";
import { StrandedManifestAttentionSchema } from "../../src/schemas/hierarchy-projection";
import type { SessionLocator } from "../../src/schemas/session-protocol";
import {
  digestWorkManifest,
  type WorkManifest,
  workManifestRef,
} from "../../src/schemas/work-manifest";
import { killAgentTeardown } from "../kill-teardown";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { required } from "../required";

const timestamp = "2026-07-09T12:00:00.000Z";

/** A fixture repoRoot must have a committed landing target: teardown tests mock the stranded-work assessor, so their verdict must reach settlement after the inventory reader has proved it can see `main`. */
function initRepo(repo: string): void {
  Bun.spawnSync(["git", "-C", repo, "init", "-b", "main"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Hive Test",
      "-c",
      "user.email=hive@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

const strandedManifest: WorkManifest = {
  agentId: "agent-maya",
  agentName: "maya",
  runId: null,
  nodeId: null,
  branch: "hive/maya-server",
  worktreePath: "/tmp/hive-maya",
  dirtyFiles: ["src/server.ts"],
  unmergedCommits: 2,
  lastStatus: "working",
  classification: "stranded",
  classificationReason: "2 unmerged commit(s) and 1 dirty file(s) not on HEAD",
};

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not used in these tests");
  }
}

const hostNotReached = async (): Promise<never> => {
  throw new Error("terminal host method not expected in this test");
};

/** A landed-host double with no live sessions: every Hive-level inspect and
 * terminate resolves through the absent-session path, which is what a dead
 * agent's teardown actually meets. */
const emptyTerminalHost = {
  waitForHostExit: async () => ({ kind: "inherited" as const }),
  create: hostNotReached,
  capture: hostNotReached,
  claimInput: hostNotReached,
  submitInput: hostNotReached,
  resize: hostNotReached,
  inspect: hostNotReached,
  terminate: hostNotReached,
  issueAttach: hostNotReached,
  list: async () => [],
};

/** A journal double that records WHEN append runs relative to teardown's
 * destructive steps, while still writing through the real journal. */
class LoggingJournal extends ManifestJournal {
  constructor(
    db: HiveDatabase,
    private readonly ops: string[],
  ) {
    super(db);
  }

  override append(manifest: WorkManifest, at?: string) {
    this.ops.push("journal-append");
    return super.append(manifest, at);
  }
}

function bindCompletedHost(db: HiveDatabase, locator: SessionLocator): void {
  db.bindTerminalHostSession({
    locator: { ...locator, hostKind: "sessiond" as const },
    visibility: {
      workspaceSessionId: "workspace-fixture",
      workspacePid: 4100,
      workspaceStartToken: "4100:123456",
      openTerminalRevision: "1",
    },
  });
  db.completeTerminalHostSession(locator, {
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    verifiedShellRoot: {
      pid: 4300,
      startToken: "4300:123456",
      processGroupId: 4300,
    },
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      state: "visible" as const,
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
  });
}

// Credential revocation and locator minting both resolve through HIVE_HOME, so
// the whole file runs against a disposable home.
let tempRoot = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-manifest-test-"));
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await mkdir(Bun.env.HIVE_HOME, { recursive: true });
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ManifestJournal", () => {
  test("revisions are journal-assigned and strictly increasing per agent", () => {
    const db = new HiveDatabase(":memory:");
    const journal = new ManifestJournal(db);
    try {
      const first = journal.append(strandedManifest);
      const second = journal.append({
        ...strandedManifest,
        unmergedCommits: 3,
      });
      const otherAgent = journal.append({
        ...strandedManifest,
        agentId: "agent-nina",
        agentName: "nina",
      });
      expect([first.revision, second.revision, otherAgent.revision]).toEqual([
        "1",
        "2",
        "1",
      ]);
      // The caller never supplies a revision, so history cannot be rewritten
      // or skipped; the digest changes with the content it binds.
      expect(second.digest).not.toBe(first.digest);
      expect(journal.latest("agent-maya")?.manifest.unmergedCommits).toBe(3);
      expect(journal.latest("agent-nobody")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a kill mid-work leaves an entry that survives a restart with its exact revision", async () => {
    const directory = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "manifest-"));
    const path = join(directory, "hive.db");
    try {
      const first = new HiveDatabase(path);
      const written = new ManifestJournal(first).append(
        strandedManifest,
        "2026-07-31T00:00:00.000Z",
      );
      first.close();

      // The daemon died with the agent mid-work; the restarted daemon must
      // recover the exact capture — revision and digest — not a retelling.
      const second = new HiveDatabase(path);
      const recovered = new ManifestJournal(second).latest("agent-maya");
      expect(recovered).toEqual(written);
      expect(workManifestRef(required(recovered))).toEqual({
        revision: "1",
        digest: written.digest,
      });
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("listAttention keeps each agent's latest non-clean capture", () => {
    const db = new HiveDatabase(":memory:");
    const journal = new ManifestJournal(db);
    try {
      // Accounted for: stranded, then a clean capture — not attention.
      journal.append(strandedManifest);
      journal.append({
        ...strandedManifest,
        dirtyFiles: [],
        unmergedCommits: 0,
        classification: "clean",
        classificationReason: "no unmerged commits or dirty files against HEAD",
      });
      // Stranded most recently — attention.
      journal.append({
        ...strandedManifest,
        agentId: "agent-nina",
        agentName: "nina",
        dirtyFiles: [],
        unmergedCommits: 0,
        classification: "clean",
        classificationReason: "no unmerged commits or dirty files against HEAD",
      });
      journal.append({
        ...strandedManifest,
        agentId: "agent-nina",
        agentName: "nina",
      });
      // A failed measurement is not accounted work — attention.
      journal.append({
        ...strandedManifest,
        agentId: "agent-owen",
        agentName: "owen",
        dirtyFiles: [],
        unmergedCommits: 0,
        classification: "unknown",
        classificationReason: "stranded-work check failed (boom)",
      });

      const attention = journal.listAttention();
      expect(attention.map((entry) => entry.manifest.agentId).sort()).toEqual([
        "agent-nina",
        "agent-owen",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("projectStrandedManifestAttention", () => {
  test("a stranded manifest projects as the frozen attention shape", () => {
    const db = new HiveDatabase(":memory:");
    const entry = new ManifestJournal(db).append(strandedManifest);
    const attention = projectStrandedManifestAttention(entry);
    // Parsed against the real frozen schema, then compared exactly: the
    // projection names the branch, the counts, and the exact manifest
    // revision a recovery would re-open.
    expect(StrandedManifestAttentionSchema.parse(attention)).toEqual({
      nodeId: null,
      agentId: "agent-maya",
      branch: "hive/maya-server",
      workManifestRevision: { revision: "1", digest: entry.digest },
      unmergedCommits: 2,
      dirtyFileCount: 1,
      disposition: "preserve",
    });
    db.close();
  });

  test("an unknown classification projects with disposition unknown", () => {
    const db = new HiveDatabase(":memory:");
    const entry = new ManifestJournal(db).append({
      ...strandedManifest,
      dirtyFiles: [],
      unmergedCommits: 0,
      classification: "unknown",
      classificationReason: "stranded-work check failed (boom)",
    });
    expect(projectStrandedManifestAttention(entry)?.disposition).toBe(
      "unknown",
    );
    db.close();
  });

  test("clean and branchless manifests project nothing", () => {
    const db = new HiveDatabase(":memory:");
    const journal = new ManifestJournal(db);
    const clean = journal.append({
      ...strandedManifest,
      dirtyFiles: [],
      unmergedCommits: 0,
      classification: "clean",
      classificationReason: "no unmerged commits or dirty files against HEAD",
    });
    expect(projectStrandedManifestAttention(clean)).toBeNull();
    // The frozen shape names work by branch; a branchless manifest stays
    // journal-only rather than being projected under an invented name.
    const branchless = journal.append({
      ...strandedManifest,
      branch: null,
    });
    expect(projectStrandedManifestAttention(branchless)).toBeNull();
    db.close();
  });

  test("the attention item feeds the real snapshot projector", () => {
    const db = new HiveDatabase(":memory:");
    const entry = new ManifestJournal(db).append(strandedManifest);
    const attention = required(projectStrandedManifestAttention(entry));
    const entity = projectStrandedManifestEntity([attention]);
    expect(entity.kind).toBe("hierarchy-stranded-manifest");
    expect(entity.projection).toMatchObject({
      schemaVersion: 3,
      // The journal is keyed by agent, so the row belongs to no single run.
      runId: null,
      items: { availability: "present", value: [attention] },
    });
    db.close();
  });
});

describe("teardown wiring", () => {
  test("the process kill precedes the journal and an unprovable worktree stays", async () => {
    const ops: string[] = [];
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "manifest-order-"));
    const inserted = db.insertAgent(
      agent({
        status: "idle",
        lastEventAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      }),
    );
    bindCompletedHost(db, required(inserted.sessionLocator));
    const recordTermination = db.recordTerminalHostTermination.bind(db);
    jest
      .spyOn(db, "recordTerminalHostTermination")
      .mockImplementation((locator, audit) => {
        ops.push("terminate-session");
        return recordTermination(locator, audit);
      });
    const journal = new LoggingJournal(db, ops);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
      manifestJournal: journal,
    });
    try {
      // Stop processes, measure, journal, then ask settlement to prove release.
      // Reached through the private method because hive_kill is the only
      // caller that passes removeWorktree, and standing up a capability token
      // here would test the tool door rather than this ordering. No global
      // prune — removeWorktree scopes the registration cleanup itself.
      await killAgentTeardown(daemon, required(db.getAgentByName("maya")), {
        removeWorktree: true,
      });

      expect(db.getAgentByName("maya")?.status).toBe("dead");
      // I7: capture (and its journal write) only after the process is stopped.
      // Scoped remove only — no repo-wide prune that could hit a sibling instance.
      expect(ops).toEqual(["terminate-session", "journal-append"]);
      expect(ops).not.toContain("prune-worktrees");
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("post-stop capture is clean but cannot bypass an unprovable settlement", async () => {
    // Positive control for I7: a live agent mid-write looks dirty; after the
    // process is stopped the same worktree is clean. Capture must run post-stop
    // or removeWorktree=true silently keeps the tree as "stranded".
    const ops: string[] = [];
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "manifest-i7-"));
    initRepo(repo);
    const inserted = db.insertAgent(
      agent({
        status: "working",
        lastEventAt: new Date().toISOString(),
      }),
    );
    bindCompletedHost(db, required(inserted.sessionLocator));
    const recordTermination = db.recordTerminalHostTermination.bind(db);
    jest
      .spyOn(db, "recordTerminalHostTermination")
      .mockImplementation((locator, audit) => {
        ops.push("terminate-session");
        return recordTermination(locator, audit);
      });
    const journal = new LoggingJournal(db, ops);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => {
        // Dirty only before stop — the mid-write window the old order measured.
        if (!ops.includes("terminate-session")) {
          return { dirtyFiles: ["src/server.ts"], unmergedCommits: 0 };
        }
        return { dirtyFiles: [], unmergedCommits: 0 };
      },
      manifestJournal: journal,
    });
    try {
      await killAgentTeardown(daemon, required(db.getAgentByName("maya")), {
        removeWorktree: true,
      });
      expect(db.getAgentByName("maya")?.worktreePath).toBe("/tmp/hive-maya");
      expect(ops[0]).toBe("terminate-session");
      expect(ops).toContain("journal-append");
      expect(journal.latest(inserted.id)?.manifest.classification).toBe(
        "clean",
      );
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a kill mid-work journals the stranded state before anything is destroyed", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "manifest-kill-"));
    initRepo(repo);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      manageLifecycle: true,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/server.ts"],
        unmergedCommits: 2,
      }),
    });
    db.insertAgent(agent({ status: "working" }));
    try {
      await daemon.stop();
      expect(db.getAgentByName("maya")?.status).toBe("dead");

      const entry = required(new ManifestJournal(db).latest("agent-maya"));
      expect(entry.revision).toBe("1");
      expect(entry.manifest.classification).toBe("stranded");
      // Mid-work: the capture shows the work was in flight when the kill came.
      expect(entry.manifest.lastStatus).toBe("working");
      expect(entry.manifest.unmergedCommits).toBe(2);
      expect(entry.manifest.dirtyFiles).toEqual(["src/server.ts"]);
      expect(entry.digest).toBe(digestWorkManifest(entry.manifest));
      expect(
        projectStrandedManifestAttention(entry)?.workManifestRevision,
      ).toEqual({ revision: "1", digest: entry.digest });
    } finally {
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a failed stranded-work check journals unknown, never clean", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "manifest-unknown-"));
    initRepo(repo);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      manageLifecycle: true,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => {
        throw new Error("git refused");
      },
    });
    db.insertAgent(agent({ status: "working" }));
    try {
      await daemon.stop();

      const entry = required(new ManifestJournal(db).latest("agent-maya"));
      expect(entry.manifest.classification).toBe("unknown");
      expect(entry.manifest.classificationReason).toContain("git refused");
      // Unknown stays on the attention list: an unmeasured worktree is work
      // nobody accounted for, and must never read as clean.
      expect(
        new ManifestJournal(db)
          .listAttention()
          .map((row) => row.manifest.agentId),
      ).toEqual(["agent-maya"]);
      expect(projectStrandedManifestAttention(entry)?.disposition).toBe(
        "unknown",
      );
    } finally {
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("recoverSubtreeManifests", () => {
  const recRunId = "run_018f4f5e-0000-7000-8000-0000000000a1";
  const recRootNodeId = "node_018f4f5e-0000-7000-8000-0000000000a1";
  const recLostNodeId = "node_018f4f5e-0000-7000-8000-0000000000a2";
  const recCrewANodeId = "node_018f4f5e-0000-7000-8000-0000000000a3";
  const recCrewBNodeId = "node_018f4f5e-0000-7000-8000-0000000000a4";
  const recSuccessorNodeId = "node_018f4f5e-0000-7000-8000-0000000000a5";
  const recRootGrantId = "grant_018f4f5e-0000-7000-8000-0000000000a1";
  const recSuccessorGrantId = "grant_018f4f5e-0000-7000-8000-0000000000a2";
  const recTransferId = "transfer_018f4f5e-0000-7000-8000-0000000000a1";
  const recGitSha = "c".repeat(40);
  const recDigest = `sha256:${"d".repeat(64)}`;
  const recNow = new Date("2026-07-30T12:30:00.000Z");

  const recRootBinding = {
    nodeId: recRootNodeId,
    agentId: "queen-root",
    generation: 1,
  };
  const recLostBinding = {
    nodeId: recLostNodeId,
    agentId: "lost-lead",
    generation: 1,
  };
  const recSuccessorBinding = {
    nodeId: recSuccessorNodeId,
    agentId: "successor-lead",
    generation: 1,
  };

  function recNode(
    nodeId: string,
    parentNodeId: string | null,
    ownerNodeId: string | null,
  ) {
    return {
      nodeId,
      runId: recRunId,
      parentNodeId,
      ownerNodeId,
      organizationalRole:
        parentNodeId === null || ownerNodeId === recRootNodeId
          ? ("lead-worker" as const)
          : ("worker" as const),
      assignmentKind: "author" as const,
      taskScope: [],
      capacityCharge: 1,
      lifecycle: "active" as const,
      revision: "1",
    };
  }

  function recBinding(
    ref: typeof recLostBinding,
    suffix: string,
    unboundAt: string | null = null,
  ) {
    return {
      ...ref,
      provider: "codex" as const,
      model: "gpt-5",
      sessionLocator: {
        schemaVersion: 1 as const,
        instanceId: "instance-1",
        subject: { kind: "agent" as const, agentId: ref.agentId },
        generation: 1,
        sessionId: `ses_018f4f5e-0000-7000-8000-0000000000${suffix}`,
        hostKind: "sessiond" as const,
        engineBuildId: "build-1",
      },
      worktree: `/worktree-${ref.agentId}`,
      branch: `hive/${ref.agentId}`,
      baseSha: recGitSha,
      credentialId: `cred-${ref.agentId}`,
      boundAt: timestamp,
      unboundAt,
    };
  }

  function recGrant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
    return {
      grantId: recRootGrantId,
      parentGrantId: null,
      issuer: recRootBinding,
      subject: recRootBinding,
      runId: recRunId,
      taskIds: [],
      descendantNodeIds: [
        recRootNodeId,
        recLostNodeId,
        recCrewANodeId,
        recCrewBNodeId,
        recSuccessorNodeId,
      ],
      paths: ["src"],
      branches: ["hive/crew"],
      actions: ["read", "write", "test", "spawn"],
      budget: {
        sessions: 4,
        tokens: 20_000,
        costCents: 200,
        wallTimeMs: 3_600_000,
        retries: 2,
      },
      expiresAt: "2026-07-30T13:00:00.000Z",
      hierarchyRevision: "0",
      runEpoch: 0,
      capabilityEpoch: 1,
      status: "active" as const,
      ...overrides,
    };
  }

  function recManifest(
    agentId: string,
    nodeId: string,
    classification: WorkManifest["classification"],
  ): WorkManifest {
    return {
      agentId,
      agentName: agentId,
      runId: recRunId,
      nodeId,
      branch: `hive/${agentId}`,
      worktreePath: `/worktree-${agentId}`,
      dirtyFiles: classification === "clean" ? [] : ["src/work.ts"],
      unmergedCommits: classification === "clean" ? 0 : 1,
      lastStatus: "working",
      classification,
      classificationReason:
        classification === "clean"
          ? "no unmerged commits or dirty files against HEAD"
          : "1 unmerged commit(s) not on HEAD",
    };
  }

  /**
   * The flat agent row behind a binding.
   *
   * One counter for credential rotation, and it lives here rather than on the
   * binding document, so every fence that checks an epoch reads this table. A
   * binding whose agent is missing from it cannot be fenced at all.
   */
  function seedFlatAgent(
    db: HiveDatabase,
    agentId: string,
    suffix: string,
  ): void {
    db.insertAgent({
      id: agentId,
      name: agentId,
      tool: "codex",
      model: "gpt-5",
      category: "simple_coding",
      status: "working",
      taskDescription: agentId,
      worktreePath: `/worktree-${agentId}`,
      branch: `hive/${agentId}`,
      sessionLocator: {
        schemaVersion: 1 as const,
        instanceId: "instance-1",
        subject: { kind: "agent" as const, agentId },
        generation: 1,
        sessionId: `ses_018f4f5e-0000-7000-8000-0000000000${suffix}`,
        hostKind: "sessiond" as const,
        engineBuildId: "build-1",
      },
      contextPct: null,
      createdAt: timestamp,
      lastEventAt: timestamp,
      capabilityEpoch: 1,
      readOnly: false,
      writeRevoked: false,
    });
  }

  function seedTransferWorld(db: HiveDatabase) {
    const store = new HierarchyStore(db);
    const flatAgents = [recRootBinding, recLostBinding, recSuccessorBinding];
    flatAgents.forEach((ref, index) => {
      seedFlatAgent(db, ref.agentId, `b${String(index + 1)}`);
    });
    store.putRun(
      {
        runId: recRunId,
        revision: "1",
        repo: "hive",
        instanceId: "instance-1",
        spec: { revision: "1", digest: recDigest },
        currentPlan: { revision: "1", digest: recDigest },
        topology: { revision: "1", digest: recDigest },
        phase: "P2",
        g2: { state: "pending" },
        baseSha: recGitSha,
        budget: { revision: "1", digest: recDigest },
        runEpoch: 0,
        lifecycle: "active",
      },
      null,
    );
    store.putNode(recNode(recRootNodeId, null, null), null);
    // The root's binding first: it is the authority every lead-worker role
    // below it is conferred by.
    store.putAgentBinding(recBinding(recRootBinding, "a1"), recRunId);
    const rootConferral = {
      binding: recRootBinding,
      expectedCapabilityEpoch: 1,
    };
    store.putNode(
      recNode(recLostNodeId, recRootNodeId, recRootNodeId),
      null,
      undefined,
      rootConferral,
    );
    store.putNode(recNode(recCrewANodeId, recLostNodeId, recLostNodeId), null);
    store.putNode(recNode(recCrewBNodeId, recLostNodeId, recLostNodeId), null);
    store.putNode(
      recNode(recSuccessorNodeId, recRootNodeId, recRootNodeId),
      null,
      undefined,
      rootConferral,
    );
    store.putAgentBinding(recBinding(recLostBinding, "a2"), recRunId);
    store.putAgentBinding(
      recBinding(
        { nodeId: recCrewANodeId, agentId: "crew-a", generation: 1 },
        "a3",
      ),
      recRunId,
    );
    store.putAgentBinding(
      recBinding(
        { nodeId: recCrewBNodeId, agentId: "crew-b", generation: 1 },
        "a4",
      ),
      recRunId,
    );
    store.putAgentBinding(recBinding(recSuccessorBinding, "a5"), recRunId);
    const rootFences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: recRootBinding,
    };
    store.putGrant(recGrant(), rootFences);
    store.putGrant(
      recGrant({
        grantId: recSuccessorGrantId,
        parentGrantId: recRootGrantId,
        subject: recSuccessorBinding,
        descendantNodeIds: [recSuccessorNodeId],
        budget: {
          sessions: 2,
          tokens: 5_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
      }),
      rootFences,
    );
    return store;
  }

  // What recovery follows is the hierarchy: which manifests move is decided by
  // the subtree the transfer reparents, and by nothing else. The flat agent
  // table supplies the capability epoch the transfer fences check and takes no
  // part in choosing the rows — which is why work with no place in the subtree
  // is still absent below even though its agent is seeded like the rest.
  test("in-flight manifests stay readable under the successor after transfer, with the flat agent table supplying only the epoch", () => {
    const db = new HiveDatabase(":memory:");
    try {
      const store = seedTransferWorld(db);
      const journal = new ManifestJournal(db);
      const crewAEntry = journal.append(
        recManifest("crew-a", recCrewANodeId, "stranded"),
      );
      journal.append(recManifest("crew-b", recCrewBNodeId, "clean"));
      // Work with no place in the subtree is never this recovery's business.
      journal.append({
        ...recManifest("agent-nina", recCrewANodeId, "stranded"),
        nodeId: null,
        runId: null,
      });

      // Before the transfer the crew sits under the lost lead, so the
      // successor's subtree holds none of their work.
      expect(
        recoverSubtreeManifests(store, journal, recSuccessorNodeId, recRunId),
      ).toEqual([]);

      store.putAgentBinding(
        recBinding(recLostBinding, "a2", "2026-07-30T12:20:00.000Z"),
        recRunId,
      );
      store.transferOwnership(
        {
          transferId: recTransferId,
          runId: recRunId,
          lostOwnerNodeId: recLostNodeId,
          successorNodeId: recSuccessorNodeId,
          successorGrantId: recSuccessorGrantId,
          createdAt: timestamp,
        },
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: recRootBinding,
        },
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: recSuccessorBinding,
        },
        recNow,
      );

      const recovered = recoverSubtreeManifests(
        store,
        journal,
        recSuccessorNodeId,
        recRunId,
      );
      // crew-a's stranded work is the only in-flight capture: crew-b finished
      // clean, and the outside agent is no subtree member.
      expect(recovered).toEqual([crewAEntry]);
      expect(workManifestRef(required(recovered[0]))).toEqual({
        revision: crewAEntry.revision,
        digest: crewAEntry.digest,
      });

      // The poison control: flat rows exist for these agents, then the whole
      // table is wiped. The answer must not change — recovery reads the
      // journal through hierarchy records, never the agent table.
      db.upsertAgent(agent({ id: "crew-a", name: "crew-a" }));
      db.upsertAgent(agent({ id: "crew-b", name: "crew-b" }));
      db.database.exec("DELETE FROM agents");
      expect(
        recoverSubtreeManifests(store, journal, recSuccessorNodeId, recRunId),
      ).toEqual(recovered);
    } finally {
      db.close();
    }
  });
});
