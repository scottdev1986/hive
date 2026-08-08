import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyValidationError } from "../../src/daemon/hierarchy-service/records";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { hiveMailPublish } from "../../src/mail-service/service";
import { MailStore } from "../../src/mail-service/store";
import { RunControl } from "../../src/daemon/hierarchy-service/hierarchy-run-control";
import type {
  SessionInspection,
  SessionLocator,
} from "../../src/daemon/session-host/session-host-contract";
import {
  type HierarchySpawnFields,
  SpawnAdmission,
  spawnBriefDigest,
} from "../../src/daemon/spawn/admission";
import { HiveSpawner } from "../../src/daemon/spawn/spawner-impl";
import {
  StatusAssignmentMismatchError,
  StatusStore,
} from "../../src/daemon/status/status-store";
import type { AgentRecord } from "../../src/schemas/agent";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";
import type {
  AgentBindingRef,
  DelegationGrant,
  DelegationSpec,
  SpawnBrief,
} from "../../src/schemas/hierarchy-node";
import type {
  PlanRevision,
  Run,
  SpecRevision,
} from "../../src/schemas/hierarchy-run";
import type { RunControlIntent } from "../../src/schemas/run-control";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { bumpCapabilityEpoch } from "./fence-state";

/** A spawn reads the repo's agent standards before it creates anything, so a
 * temp repo root without them refuses long before it reaches what these tests
 * measure. */
const seedAgentStandards = async (root: string): Promise<void> => {
  await copyFile(
    join(import.meta.dir, "../../AGENT_STANDARDS.md"),
    join(root, "AGENT_STANDARDS.md"),
  );
};

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const ownerNodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const workerNodeId = "node_018f4f5e-0000-7000-8000-000000000002";
const childNodeId = "node_018f4f5e-0000-7000-8000-000000000003";
const rootGrantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const workerGrantId = "grant_018f4f5e-0000-7000-8000-000000000002";
const childGrantId = "grant_018f4f5e-0000-7000-8000-000000000003";
const duplicateWorkerGrantId = "grant_018f4f5e-0000-7000-8000-000000000004";
const collidingWorkerGrantId = "grant_018f4f5e-0000-7000-8000-000000000005";
const noncollidingWorkerGrantId = "grant_018f4f5e-0000-7000-8000-000000000006";
const briefId = "brief_018f4f5e-0000-7000-8000-000000000001";
const ownerAgentId = "owner-agent";
const workerAgentId = "worker-agent";
const createdAt = "2026-07-30T12:00:00.000Z";
const now = new Date("2026-07-30T12:30:00.000Z");
const baseSha = "a".repeat(40);
const specDigest = `sha256:${"b".repeat(64)}`;
const planDigest = `sha256:${"c".repeat(64)}`;
const topologyDigest = `sha256:${"d".repeat(64)}`;
const budgetDigest = `sha256:${"e".repeat(64)}`;

const ownerBinding: AgentBindingRef = {
  nodeId: ownerNodeId,
  agentId: ownerAgentId,
  generation: 1,
};
const workerBinding: AgentBindingRef = {
  nodeId: workerNodeId,
  agentId: workerAgentId,
  generation: 1,
};

const delegationSpec: DelegationSpec = {
  objective: "Implement hierarchy spawn admission",
  parentAcceptanceIds: ["A-spawn"],
  childOutcome: "The assigned checks pass",
  terminationCondition: "The task is complete",
  inputs: {
    specRevision: { revision: "1", digest: specDigest },
    planRevision: { revision: "1", digest: planDigest },
    taskRevisions: [{ taskId, revision: "1" }],
    interfaceRevisions: [],
    baseSha,
    prerequisites: [],
    sourceArtifactRefs: [],
  },
  boundaries: {
    allowedPaths: ["src/daemon"],
  },
  authority: {
    grantId: workerGrantId,
    permittedOperations: ["read", "write", "test"],
    environment: "worktree",
    worktree: "/repo/.hive/worktrees/worker",
    branch: "hive/worker",
    explicitNonAuthority: ["land"],
  },
  allowance: {
    sessions: 1,
    tokens: 8_000,
    costCents: 80,
    wallTimeMs: 3_000_000,
    retries: 1,
    blockers: [],
    owner: ownerBinding,
  },
};

function validRun(overrides: Partial<Run> = {}): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-1",
    approvedSpec: { revision: "1", digest: specDigest },
    currentPlan: { revision: "1", digest: planDigest },
    topology: { revision: "1", digest: topologyDigest },
    phase: "P1",
    g1: {
      state: "approved",
      decider: "engineer",
      decidedAt: createdAt,
      spec: { revision: "1", digest: specDigest },
      plan: { revision: "1", digest: planDigest },
      topology: { revision: "1", digest: topologyDigest },
      budget: { revision: "1", digest: budgetDigest },
    },
    g2: { state: "pending" },
    baseSha,
    budget: { revision: "1", digest: budgetDigest },
    runEpoch: 0,
    lifecycle: "active",
    ...overrides,
  };
}

function validSpecRevision(): SpecRevision {
  return {
    runId,
    revision: "1",
    digest: specDigest,
    createdAt,
    lifecycle: "proposed",
    objective: "Implement hierarchy spawn admission",
    acceptanceIds: ["A-spawn"],
    scope: "Hierarchy provider launch",
    nonGoals: [],
    constraints: {
      architecture: ["Keep the flat spawn path unchanged"],
      security: [],
      outwardEffect: [],
    },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [],
    proposer: "queen",
    engineerApproval: null,
  };
}

function validPlanRevision(): PlanRevision {
  return {
    runId,
    revision: "1",
    digest: planDigest,
    createdAt,
    lifecycle: "proposed",
    parentRevision: null,
    taskDag: [{ taskId, dependsOn: [] }],
    topologyRationale: "One isolated hierarchy launch task",
    proposer: "queen",
  };
}

function validTask(spec: DelegationSpec = delegationSpec): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: spec,
    acceptanceIds: ["A-spawn"],
    ownerNodeId,
    assigneeNodeId: workerNodeId,
    pathLeases: [{ path: "src/daemon", mode: "write" }],
    branch: "hive/worker",
    baseSha,
    state: "assigned",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

function rootGrant(): DelegationGrant {
  return {
    grantId: rootGrantId,
    parentGrantId: null,
    issuer: ownerBinding,
    subject: ownerBinding,
    runId,
    taskIds: [taskId],
    descendantNodeIds: [workerNodeId],
    paths: ["src/daemon"],
    branches: ["hive/worker"],
    actions: ["read", "write", "test", "spawn"],
    budget: {
      sessions: 2,
      tokens: 10_000,
      costCents: 100,
      wallTimeMs: 3_600_000,
      retries: 2,
    },
    expiresAt: "2026-07-30T14:00:00.000Z",
    hierarchyRevision: "0",
    runEpoch: 0,
    capabilityEpoch: 1,
    status: "active",
  };
}

function workerGrant(): DelegationGrant {
  return {
    ...rootGrant(),
    grantId: workerGrantId,
    parentGrantId: rootGrantId,
    issuer: ownerBinding,
    subject: workerBinding,
    descendantNodeIds: [],
    actions: ["read", "write", "test"],
    budget: {
      sessions: 1,
      tokens: 8_000,
      costCents: 80,
      wallTimeMs: 3_000_000,
      retries: 1,
    },
    expiresAt: "2026-07-30T13:30:00.000Z",
  };
}

function hierarchyFields(
  overrides: Partial<HierarchySpawnFields> = {},
  spec: DelegationSpec = delegationSpec,
): HierarchySpawnFields {
  return {
    runId,
    runEpoch: 0,
    nodeId: workerNodeId,
    taskId,
    delegationSpec: spec,
    grantId: workerGrantId,
    spawnBrief: {
      engineerConstraints: {
        excerpts: ["Keep the flat spawn path unchanged"],
      },
      written: {
        goal: "Admit one hierarchy worker",
        done: [],
        remaining: "provider launch",
        nextAction: "start the provider",
        decisions: [],
        failures: [],
        uncertainty: "",
      },
    },
    ...overrides,
  };
}

function seed(
  targetDb: HiveDatabase,
  store: HierarchyStore,
  run: Run = validRun(),
  spec: DelegationSpec = delegationSpec,
  options: {
    plan?: boolean;
    rootGrant?: Partial<DelegationGrant>;
    spec?: boolean;
    task?: Partial<TaskDetail>;
    workerGrant?: Partial<DelegationGrant>;
  } = {},
): void {
  store.putRun(run, null);
  if (options.spec !== false) store.putSpecRevision(validSpecRevision());
  if (options.plan !== false) {
    store.putPlanRevision(validPlanRevision(), run.runEpoch);
  }
  store.putNode(
    {
      nodeId: ownerNodeId,
      runId,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  store.putNode(
    {
      nodeId: workerNodeId,
      runId,
      parentNodeId: ownerNodeId,
      ownerNodeId,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  const ownerLocator = {
    schemaVersion: 1 as const,
    instanceId: "instance-1",
    subject: { kind: "agent" as const, agentId: ownerAgentId },
    generation: 1,
    sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-1",
  };
  // Flat agent carries capabilityEpoch for grant/fence checks.
  if (targetDb.getAgentById(ownerAgentId) === null) {
    targetDb.insertAgent({
      id: ownerAgentId,
      name: "owner",
      tool: "codex",
      model: "gpt-5",
      category: "simple_coding",
      status: "working",
      taskDescription: "owner",
      worktreePath: "/repo/.hive/worktrees/owner",
      branch: "hive/owner",
      sessionLocator: ownerLocator,
      contextPct: null,
      createdAt,
      lastEventAt: createdAt,
      capabilityEpoch: 1,
      readOnly: false,
      writeRevoked: false,
    });
  }
  store.putAgentBinding(
    {
      ...ownerBinding,
      provider: "codex",
      model: "gpt-5",
      sessionLocator: ownerLocator,
      worktree: "/repo/.hive/worktrees/owner",
      branch: "hive/owner",
      baseSha,
      credentialId: "credential-owner",
      boundAt: createdAt,
      unboundAt: null,
    },
    runId,
  );
  store.putTask({ ...validTask(spec), ...options.task });
  store.putGrant(
    { ...rootGrant(), ...options.rootGrant },
    {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    },
  );
  store.putGrant(
    { ...workerGrant(), ...options.workerGrant },
    {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    },
  );
}

function runControlIntent(
  operation: "run-pause" | "run-resume" | "run-abort",
  revision: string,
  epoch: string,
): RunControlIntent {
  return {
    schemaVersion: 1,
    intentId: `intent-${operation}`,
    expected: { kind: "revision-and-epoch", revision, epoch },
    idempotencyKey: `key-${operation}-${revision}-${epoch}`,
    body: { operation, runId },
  };
}

function prepare(
  admission: SpawnAdmission,
  fields: HierarchySpawnFields = hierarchyFields(),
) {
  const identity = admission.preflight(fields, "author");
  admission.prepareLaunch(
    identity,
    launchFacts(identity, {
      worktree:
        fields.delegationSpec?.authority.worktree ??
        "/repo/.hive/worktrees/worker",
      branch: fields.delegationSpec?.authority.branch ?? "hive/worker",
    }),
  );
  return identity;
}

function launchFacts(
  identity: ReturnType<SpawnAdmission["preflight"]>,
  overrides: Partial<Parameters<SpawnAdmission["prepareLaunch"]>[1]> = {},
): Parameters<SpawnAdmission["prepareLaunch"]>[1] {
  return {
    provider: "codex",
    model: "gpt-5",
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "instance-1",
      subject: { kind: "agent", agentId: identity.agentId },
      generation: identity.generation,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
      hostKind: "sessiond",
      engineBuildId: "engine-1",
    },
    worktree: "/repo/.hive/worktrees/worker",
    branch: "hive/worker",
    baseSha,
    ...overrides,
  };
}

function readyInspection(locator: SessionLocator): SessionInspection {
  return {
    schemaVersion: 1,
    locator,
    presence: "present",
    complete: true,
    hostPid: 3_900,
    hostStartToken: "3900:1",
    shellRoot: {
      pid: 4_000,
      startToken: "4000:1",
      processGroupId: 4_000,
    },
    foreground: {
      state: "unmanaged",
      runId: null,
      pid: 5_000,
      startToken: "5000:1",
      foregroundProcessGroupId: 5_000,
    },
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    input: { state: "FREE", ownerViewerId: null, claimId: null },
    viewerCount: 0,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    resources: {},
    visibility: {
      state: "visible",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2026-07-30T13:00:00.000Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: createdAt,
    diagnosticIds: [],
  };
}

function failedWorkerRecord(): AgentRecord {
  return {
    id: workerAgentId,
    name: "worker",
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "stuck",
    taskDescription: "Hierarchy worker",
    worktreePath: "/repo/.hive/worktrees/worker",
    branch: "hive/worker",
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "instance-1",
      subject: { kind: "agent", agentId: workerAgentId },
      generation: 1,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
      hostKind: "sessiond",
      engineBuildId: "engine-1",
    },
    contextPct: null,
    createdAt,
    lastEventAt: createdAt,
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  };
}

function flatAgentRecord(id = "flat-agent"): AgentRecord {
  const record = failedWorkerRecord();
  if (record.sessionLocator === undefined) {
    throw new Error("agent locator fixture is missing");
  }
  return {
    ...record,
    id,
    name: id,
    status: "working",
    sessionLocator: {
      ...record.sessionLocator,
      subject: { kind: "agent", agentId: id },
    },
    capabilityEpoch: 0,
  };
}

let db: HiveDatabase;
let store: HierarchyStore;
let admission: SpawnAdmission;

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new HierarchyStore(db);
  seed(db, store);
  admission = new SpawnAdmission(
    store,
    () => now,
    () => briefId,
  );
});

afterEach(() => {
  db.close();
});

describe("hierarchy spawn admission guards", () => {
  test("spawn without Task is rejected independently", () => {
    expect(() =>
      admission.preflight(hierarchyFields({ taskId: undefined }), "author"),
    ).toThrow("requires an assigned Task");
  });

  test("spawn without DelegationSpec is rejected independently", () => {
    expect(() =>
      admission.preflight(
        hierarchyFields({ delegationSpec: undefined }),
        "author",
      ),
    ).toThrow("requires a DelegationSpec");
  });

  test("spawn without grant is rejected independently", () => {
    expect(() =>
      admission.preflight(hierarchyFields({ grantId: undefined }), "author"),
    ).toThrow("requires a grant");
  });

  test("spawn without approved G1 is rejected independently", () => {
    const pendingDb = new HiveDatabase(":memory:");
    const pendingStore = new HierarchyStore(pendingDb);
    try {
      seed(
        pendingDb,
        pendingStore,
        validRun({ approvedSpec: null, g1: { state: "pending" } }),
      );
      const pending = new SpawnAdmission(
        pendingStore,
        () => now,
        () => briefId,
      );
      expect(() => pending.preflight(hierarchyFields(), "author")).toThrow(
        "has no approved G1",
      );
    } finally {
      pendingDb.close();
    }
  });

  test.each([
    ["SpecRevision", { spec: false }],
    ["PlanRevision", { plan: false }],
  ] as const)(
    "spawn without stored approved %s is rejected",
    (name, records) => {
      const missingDb = new HiveDatabase(":memory:");
      const missingStore = new HierarchyStore(missingDb);
      try {
        seed(missingDb, missingStore, validRun(), delegationSpec, records);
        const candidate = new SpawnAdmission(
          missingStore,
          () => now,
          () => briefId,
        );
        expect(() => candidate.preflight(hierarchyFields(), "author")).toThrow(
          name,
        );
      } finally {
        missingDb.close();
      }
    },
  );

  const coveredAuthorityCases: Array<
    [string, Parameters<typeof seed>[4], string]
  > = [
    [
      "Task state must still be assigned",
      { task: { state: "in-progress" } },
      "is not assigned",
    ],
    [
      "Task assignee must be the requested node",
      { task: { assigneeNodeId: ownerNodeId } },
      "is not assigned",
    ],
    [
      "grant must cover the Task",
      { workerGrant: { taskIds: [] } },
      "does not cover",
    ],
    [
      "grant must cover the branch",
      { workerGrant: { branches: [] } },
      "does not cover",
    ],
    [
      "grant must cover every delegated action",
      { workerGrant: { actions: ["read", "test"] } },
      "does not cover",
    ],
    [
      "grant must cover the delegated budget",
      {
        workerGrant: {
          budget: { ...workerGrant().budget, tokens: 7_999 },
        },
      },
      "does not cover",
    ],
    [
      "grant must cover every path lease",
      { workerGrant: { paths: ["src/daemon/other"] } },
      "does not cover",
    ],
    [
      "grant must be unexpired",
      { workerGrant: { expiresAt: "2026-07-30T12:15:00.000Z" } },
      "not live",
    ],
    [
      "grant must remain active",
      { workerGrant: { status: "revoked" } },
      "not live",
    ],
    [
      "parent grant must carry spawn authority",
      { rootGrant: { actions: ["read", "write", "test"] } },
      "spawn authority",
    ],
  ];

  test.each(coveredAuthorityCases)("%s", (_name, options, expected) => {
    const candidateDb = new HiveDatabase(":memory:");
    const candidateStore = new HierarchyStore(candidateDb);
    try {
      seed(candidateDb, candidateStore, validRun(), delegationSpec, options);
      const candidate = new SpawnAdmission(
        candidateStore,
        () => now,
        () => briefId,
      );
      expect(() => candidate.preflight(hierarchyFields(), "author")).toThrow(
        expected,
      );
    } finally {
      candidateDb.close();
    }
  });

  test("Task node must be active and match the assignment kind", () => {
    expect(() =>
      admission.preflight(hierarchyFields({ nodeId: ownerNodeId }), "author"),
    ).toThrow("active author node");
  });

  test("DelegationSpec stored pointers must match the approved Run", () => {
    const forgedSpec: DelegationSpec = {
      ...delegationSpec,
      inputs: {
        ...delegationSpec.inputs,
        specRevision: {
          revision: "1",
          digest: `sha256:${"0".repeat(64)}`,
        },
      },
    };
    const candidateDb = new HiveDatabase(":memory:");
    const candidateStore = new HierarchyStore(candidateDb);
    try {
      seed(candidateDb, candidateStore, validRun(), forgedSpec);
      const candidate = new SpawnAdmission(
        candidateStore,
        () => now,
        () => briefId,
      );
      expect(() =>
        candidate.preflight(hierarchyFields({}, forgedSpec), "author"),
      ).toThrow("pointers");
    } finally {
      candidateDb.close();
    }
  });

  test("grant issuer capability epoch is live at admission", () => {
    bumpCapabilityEpoch(db, ownerBinding);
    expect(() => admission.preflight(hierarchyFields(), "author")).toThrow(
      "issuer binding",
    );
  });

  test("prior-epoch spawn is rejected after pause", () => {
    const control = new RunControl(store);
    expect(
      control.apply(runControlIntent("run-pause", "1", "0"), "engineer").outcome
        .status,
    ).toBe("accepted");
    expect(
      control.apply(runControlIntent("run-resume", "2", "1"), "engineer")
        .outcome.status,
    ).toBe("accepted");
    expect(store.getRun(runId)?.lifecycle).toBe("active");

    expect(() => admission.preflight(hierarchyFields(), "author")).toThrow(
      "runEpoch",
    );
  });

  test.each(["run-pause", "run-abort"] as const)(
    "%s refuses admission through the run-control seam",
    (operation) => {
      const controlledDb = new HiveDatabase(":memory:");
      const controlledStore = new HierarchyStore(controlledDb);
      try {
        seed(controlledDb, controlledStore);
        const control = new RunControl(controlledStore);
        expect(
          control.apply(runControlIntent(operation, "1", "0"), "engineer")
            .outcome.status,
        ).toBe("accepted");
        const controlledAdmission = new SpawnAdmission(
          controlledStore,
          () => now,
          () => briefId,
        );
        expect(() =>
          controlledAdmission.preflight(
            hierarchyFields({ runEpoch: 1 }),
            "author",
          ),
        ).toThrow("not active");
      } finally {
        controlledDb.close();
      }
    },
  );

  test("a revoked parent grant invalidates the stored chain at admission", () => {
    store.putGrant(
      { ...rootGrant(), status: "revoked" },
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: ownerBinding,
      },
    );

    expect(() => admission.preflight(hierarchyFields(), "author")).toThrow(
      rootGrantId,
    );
  });
});

test.each([
  ["digest", { digest: `sha256:${"0".repeat(64)}` }],
  [
    "contract pointer",
    {
      computedPointers: {
        contractRevisions: [
          { revision: "forged", digest: `sha256:${"0".repeat(64)}` },
        ],
      },
    },
  ],
] as const)("caller-supplied SpawnBrief %s is rejected", (_name, forged) => {
  const request = hierarchyFields();
  if (request.spawnBrief === undefined) {
    throw new Error("SpawnBrief prose fixture is missing");
  }
  expect(() =>
    admission.preflight(
      {
        ...request,
        spawnBrief: { ...request.spawnBrief, ...forged },
      } as unknown as HierarchySpawnFields,
      "author",
    ),
  ).toThrow();
});

test("forged engineer excerpt is rejected when SpawnBrief is created", () => {
  const request = hierarchyFields();
  if (request.spawnBrief === undefined) {
    throw new Error("SpawnBrief prose fixture is missing");
  }
  const spawnBrief = request.spawnBrief;
  expect(() =>
    prepare(admission, {
      ...request,
      spawnBrief: {
        ...spawnBrief,
        engineerConstraints: { excerpts: ["forged constraint"] },
      },
    }),
  ).toThrow("SpawnBrief facts");
});

test("measured worktree HEAD mismatch rejects SpawnBrief creation", () => {
  const identity = admission.preflight(hierarchyFields(), "author");
  expect(() =>
    admission.prepareLaunch(
      identity,
      launchFacts(identity, {
        baseSha: "9".repeat(40),
      }),
    ),
  ).toThrow("launch worktree, branch, or base");
});

test.each([
  ["worktree", { worktree: "/repo/.hive/worktrees/forged" }],
  ["branch", { branch: "hive/forged" }],
] as const)("launch %s must match reserved provenance", (_name, overrides) => {
  const identity = admission.preflight(hierarchyFields(), "author");
  expect(() =>
    admission.prepareLaunch(identity, launchFacts(identity, overrides)),
  ).toThrow("delegated provenance");
});

test("reserved identity capabilityEpoch must still match the grant", () => {
  const identity = admission.preflight(hierarchyFields(), "author");
  // Identity pins the grant's epoch at reservation; a forged pin is refused.
  expect(() =>
    admission.prepareLaunch(
      { ...identity, capabilityEpoch: identity.capabilityEpoch + 1 },
      launchFacts(identity),
    ),
  ).toThrow("reserved hierarchy identity");
});

test("competing binding after reservation refuses launch and delivery", async () => {
  const identity = prepare(admission);
  admission.takeLaunchContext(identity);
  store.putAgentBinding(
    {
      ...workerBinding,
      provider: "codex",
      model: "gpt-5",
      sessionLocator: {
        schemaVersion: 1,
        instanceId: "instance-1",
        subject: { kind: "agent", agentId: workerAgentId },
        generation: 1,
        sessionId: "ses_018f4f5e-0000-7000-8000-000000000003",
        hostKind: "sessiond",
        engineBuildId: "engine-1",
      },
      worktree: "/repo/.hive/worktrees/worker",
      branch: "hive/worker",
      baseSha,
      credentialId: "competing-credential",
      boundAt: createdAt,
      unboundAt: null,
    },
    runId,
  );

  expect(() => admission.revalidateLaunch(identity)).toThrow("already bound");
  admission.failLaunch(identity);
  admission.failLaunch(identity);
  expect(store.getAgentBinding(identity)?.credentialId).toBe(
    "competing-credential",
  );
  expect(store.getAgentBinding(identity)?.unboundAt).toBeNull();
  expect(() => admission.revalidateLaunch(identity)).toThrow("failed launch");
  expect(admission.recipientBindingState(failedWorkerRecord())).toBe("unbound");

  db.insertAgent(failedWorkerRecord());
  for (const candidate of [
    admission,
    new SpawnAdmission(new HierarchyStore(db), () => now),
  ]) {
    expect(() =>
      publishToWorker(
        db,
        () => candidate.recipientBindingState(failedWorkerRecord()),
        `foreign-binding:${candidate === admission ? "a" : "b"}`,
      ),
    ).toThrow("unbound");
  }
});

test("grant capability epoch cannot change after identity reservation", () => {
  const identity = admission.preflight(hierarchyFields(), "author");
  bumpCapabilityEpoch(db, ownerBinding);
  const fences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 2,
    binding: ownerBinding,
  };
  store.putGrant({ ...rootGrant(), capabilityEpoch: 2 }, fences);
  store.putGrant({ ...workerGrant(), capabilityEpoch: 2 }, fences);

  expect(() =>
    admission.prepareLaunch(identity, launchFacts(identity)),
  ).toThrow("reserved hierarchy identity");
});

test("SpawnBrief is immutable and launch context can be taken exactly once", () => {
  const identity = prepare(admission);
  const brief = admission.takeLaunchContext(identity);
  const { digest, ...content } = brief;

  expect(Object.isFrozen(brief)).toBeTrue();
  expect(Object.isFrozen(brief.written)).toBeTrue();
  expect(digest).toBe(spawnBriefDigest(content));
  expect(brief.computedPointers).toMatchObject({
    planRevision: { revision: "1", digest: planDigest },
    taskRevisions: [{ taskId, revision: "1" }],
    contractRevisions: [],
    branch: "hive/worker",
    worktree: "/repo/.hive/worktrees/worker",
    baseSha,
    sourceProvenance: [],
    graphProvenance: [],
  });
  expect(() => {
    (brief as { agentId: string }).agentId = "mutated";
  }).toThrow();
  expect(() => {
    (brief.written as { goal: string }).goal = "mutated";
  }).toThrow();
  expect(brief.agentId).toBe(workerAgentId);
  expect(() => admission.takeLaunchContext(identity)).toThrow("already taken");
});

test("failed-launch cleanup unbinds only its own binding and is idempotent", () => {
  const identity = prepare(admission);
  admission.takeLaunchContext(identity);
  admission.bindAfterReadiness(identity, "credential-worker");

  const firstCleanup = admission.failLaunch(identity);
  const secondCleanup = admission.failLaunch(identity);

  expect(firstCleanup?.unboundAt).toBe(now.toISOString());
  expect(secondCleanup).toEqual(firstCleanup);
  expect(store.getAgentBinding(identity)).toEqual(firstCleanup);
  expect(admission.recipientBindingState(failedWorkerRecord())).toBe("unbound");
  expect(() =>
    admission.bindAfterReadiness(identity, "replacement-credential"),
  ).toThrow("failed launch");
});

test("restart delivery requires every AgentBinding fact to match the AgentRecord", () => {
  const identity = prepare(admission);
  admission.takeLaunchContext(identity);
  admission.bindAfterReadiness(identity, "credential-worker");
  const restarted = new SpawnAdmission(new HierarchyStore(db), () => now);
  const matching = failedWorkerRecord();
  if (matching.sessionLocator === undefined) {
    throw new Error("hierarchy locator fixture is missing");
  }

  expect(restarted.recipientBindingState(matching)).toBe("bound");
  for (const mismatch of [
    { ...matching, sessionLocator: undefined },
    {
      ...matching,
      sessionLocator: {
        ...matching.sessionLocator,
        sessionId: "ses_018f4f5e-0000-7000-8000-000000000009",
      },
    },
    { ...matching, tool: "kimi" as const },
    { ...matching, model: "other-model" },
    { ...matching, worktreePath: "/repo/.hive/worktrees/other" },
    { ...matching, branch: "hive/other" },
  ]) {
    expect(restarted.recipientBindingState(mismatch)).toBe("unbound");
  }
});

/**
 * Publishing to a worker, with its hierarchy binding as the only thing that can
 * refuse it. The mailbox asks the daemon whether a name can receive; an
 * agent whose binding was taken by a competing launch cannot.
 */
function publishToWorker(
  database: HiveDatabase,
  bindingState: () => "bound" | "unbound" | "legacy",
  idempotencyKey: string,
) {
  return hiveMailPublish(
    {
      store: new MailStore(database),
      recipients: (named) =>
        bindingState() === "unbound"
          ? { kind: "unbound" }
          : { kind: "live", canonical: named },
    },
    { subject: "queen", agentGeneration: 0 },
    {
      from: "queen",
      to: "worker",
      lane: "control",
      topic: "handoff",
      body: "Do not deliver through a foreign binding",
      idempotencyKey,
    },
    new Date(),
  );
}

test("failed launch leaves no live binding; successful launch binds", async () => {
  const failedIdentity = prepare(admission);
  admission.takeLaunchContext(failedIdentity);
  expect(store.getAgentBinding(failedIdentity)).toBeNull();
  expect(admission.recipientBindingState(failedWorkerRecord())).toBe("unbound");

  db.insertAgent(failedWorkerRecord());
  expect(() =>
    publishToWorker(
      db,
      () => admission.recipientBindingState(failedWorkerRecord()),
      "failed-launch-binding",
    ),
  ).toThrow("unbound");

  const successDb = new HiveDatabase(":memory:");
  const successStore = new HierarchyStore(successDb);
  try {
    seed(successDb, successStore);
    const successful = new SpawnAdmission(
      successStore,
      () => now,
      () => briefId,
    );
    const successIdentity = prepare(successful);
    const brief: SpawnBrief = successful.takeLaunchContext(successIdentity);
    expect(brief.agentId).toBe(workerAgentId);
    successful.bindAfterReadiness(successIdentity, "credential-worker");

    const { capabilityEpoch: _identityEpoch, ...bindingIdentity } =
      successIdentity;
    expect(successStore.getAgentBinding(successIdentity)).toMatchObject({
      ...bindingIdentity,
      credentialId: "credential-worker",
      unboundAt: null,
    });
    expect(() =>
      successful.bindAfterReadiness(successIdentity, "replacement-credential"),
    ).toThrow("already bound");
    expect(successStore.getAgentBinding(successIdentity)?.credentialId).toBe(
      "credential-worker",
    );
    expect(successful.recipientBindingState(failedWorkerRecord())).toBe(
      "bound",
    );
    const ownerFences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    };
    // Multi-hop issuance: mid-tier must be lead-worker, and the grandchild
    // subject must sit under that lead in the real parentNodeId tree.
    successStore.putNode(
      {
        nodeId: workerNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "2",
      },
      "1",
      undefined,
      { binding: ownerBinding, expectedCapabilityEpoch: 1 },
    );
    successStore.putNode(
      {
        nodeId: childNodeId,
        runId,
        parentNodeId: workerNodeId,
        ownerNodeId: workerNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const workerLocator = {
      schemaVersion: 1 as const,
      instanceId: "instance-1",
      subject: { kind: "agent" as const, agentId: workerAgentId },
      generation: 1,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-1",
    };
    if (successDb.getAgentById(workerAgentId) === null) {
      successDb.insertAgent({
        id: workerAgentId,
        name: "worker",
        tool: "codex",
        model: "gpt-5",
        category: "simple_coding",
        status: "working",
        taskDescription: "worker",
        worktreePath: "/repo/.hive/worktrees/worker",
        branch: "hive/worker",
        sessionLocator: workerLocator,
        contextPct: null,
        createdAt,
        lastEventAt: createdAt,
        capabilityEpoch: 1,
        readOnly: false,
        writeRevoked: false,
      });
    }
    successStore.putAgentBinding(
      {
        ...workerBinding,
        provider: "codex",
        model: "gpt-5",
        sessionLocator: workerLocator,
        worktree: "/repo/.hive/worktrees/worker",
        branch: "hive/worker",
        baseSha,
        credentialId: "credential-worker",
        boundAt: createdAt,
        unboundAt: null,
      },
      runId,
    );
    successStore.putGrant(
      {
        ...rootGrant(),
        descendantNodeIds: [workerNodeId, childNodeId],
      },
      ownerFences,
    );
    successStore.putGrant(
      {
        ...workerGrant(),
        descendantNodeIds: [childNodeId],
        actions: ["read", "write", "test", "spawn"],
      },
      ownerFences,
    );
    const childGrant = successStore.putGrant(
      {
        ...workerGrant(),
        grantId: childGrantId,
        parentGrantId: workerGrantId,
        issuer: workerBinding,
        subject: {
          nodeId: childNodeId,
          agentId: "child-agent",
          generation: 1,
        },
        descendantNodeIds: [],
        actions: ["read"],
        budget: {
          sessions: 1,
          tokens: 4_000,
          costCents: 40,
          wallTimeMs: 1_000_000,
          retries: 0,
        },
        expiresAt: "2026-07-30T13:00:00.000Z",
      },
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: workerBinding,
      },
    );
    expect(childGrant.issuer).toEqual(workerBinding);
  } finally {
    successDb.close();
  }
});

test("failed hierarchy identity remains rejected after admission restart", async () => {
  const identity = prepare(admission);
  admission.takeLaunchContext(identity);
  expect(store.getAgentBinding(identity)).toBeNull();

  const restarted = new SpawnAdmission(
    new HierarchyStore(db),
    () => now,
    () => briefId,
  );
  expect(restarted.recipientBindingState(failedWorkerRecord())).toBe("unbound");
  const wrongGenerationRecord = failedWorkerRecord();
  if (wrongGenerationRecord.sessionLocator === undefined) {
    throw new Error("hierarchy locator fixture is missing");
  }
  expect(
    restarted.recipientBindingState({
      ...wrongGenerationRecord,
      sessionLocator: {
        ...wrongGenerationRecord.sessionLocator,
        generation: 2,
      },
    }),
  ).toBe("unbound");
  expect(restarted.recipientBindingState(flatAgentRecord())).toBe("legacy");
  const { sessionLocator: _missingAfterRestart, ...recordWithoutLocator } =
    failedWorkerRecord();
  db.insertAgent(recordWithoutLocator);
  expect(() =>
    publishToWorker(
      db,
      () => restarted.recipientBindingState(recordWithoutLocator),
      "restart-no-locator",
    ),
  ).toThrow("unbound");

  const wrongGeneration = failedWorkerRecord();
  if (wrongGeneration.sessionLocator === undefined) {
    throw new Error("hierarchy locator fixture is missing");
  }
  db.insertAgent({
    ...wrongGeneration,
    sessionLocator: {
      ...wrongGeneration.sessionLocator,
      generation: 2,
    },
  });
  expect(() =>
    publishToWorker(
      db,
      () => restarted.recipientBindingState(wrongGeneration),
      "restart-wrong-generation",
    ),
  ).toThrow("unbound");
});

test("ambiguous durable grant subjects fail closed after restart", () => {
  const identity = prepare(admission);
  admission.takeLaunchContext(identity);
  admission.bindAfterReadiness(identity, "credential-worker");
  store.putGrant(
    { ...workerGrant(), grantId: duplicateWorkerGrantId },
    {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    },
  );

  const restarted = new SpawnAdmission(new HierarchyStore(db), () => now);
  expect(restarted.recipientBindingState(failedWorkerRecord())).toBe("unbound");
});

test("two-level lead chain admits a grandchild spawn end to end (root → lead → worker)", () => {
  const chainDb = new HiveDatabase(":memory:");
  const chainStore = new HierarchyStore(chainDb);
  try {
    const leadNodeId = workerNodeId;
    const workerLeafNodeId = childNodeId;
    const leadGrantId = workerGrantId;
    const leafGrantId = childGrantId;
    const leadBinding = workerBinding;
    const leafAgentId = "leaf-worker";
    const leafBinding = {
      nodeId: workerLeafNodeId,
      agentId: leafAgentId,
      generation: 1 as const,
    };

    const leafSpec: DelegationSpec = {
      ...delegationSpec,
      authority: {
        ...delegationSpec.authority,
        grantId: leafGrantId,
        worktree: "/repo/.hive/worktrees/leaf",
        branch: "hive/leaf",
      },
      allowance: {
        ...delegationSpec.allowance,
        owner: leadBinding,
        sessions: 1,
        tokens: 4_000,
        costCents: 40,
        wallTimeMs: 1_000_000,
        retries: 0,
      },
    };

    // Fresh world: root lead → mid lead → leaf worker. seed() would plant a
    // flat worker grant and a task already assigned to the mid node.
    chainStore.putRun(validRun(), null);
    chainStore.putSpecRevision(validSpecRevision());
    chainStore.putPlanRevision(validPlanRevision(), 0);
    chainStore.putNode(
      {
        nodeId: ownerNodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const ownerLocator = {
      schemaVersion: 1 as const,
      instanceId: "instance-1",
      subject: { kind: "agent" as const, agentId: ownerAgentId },
      generation: 1,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-1",
    };
    chainDb.insertAgent({
      id: ownerAgentId,
      name: "owner",
      tool: "codex",
      model: "gpt-5",
      category: "simple_coding",
      status: "working",
      taskDescription: "owner",
      worktreePath: "/repo/.hive/worktrees/owner",
      branch: "hive/owner",
      sessionLocator: ownerLocator,
      contextPct: null,
      createdAt,
      lastEventAt: createdAt,
      capabilityEpoch: 1,
      readOnly: false,
      writeRevoked: false,
    });
    chainStore.putAgentBinding(
      {
        ...ownerBinding,
        provider: "codex",
        model: "gpt-5",
        sessionLocator: ownerLocator,
        worktree: "/repo/.hive/worktrees/owner",
        branch: "hive/owner",
        baseSha,
        credentialId: "credential-owner",
        boundAt: createdAt,
        unboundAt: null,
      },
      runId,
    );
    chainStore.putNode(
      {
        nodeId: leadNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
      undefined,
      { binding: ownerBinding, expectedCapabilityEpoch: 1 },
    );
    chainStore.putNode(
      {
        nodeId: workerLeafNodeId,
        runId,
        parentNodeId: leadNodeId,
        ownerNodeId: leadNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const leadLocator = {
      schemaVersion: 1 as const,
      instanceId: "instance-1",
      subject: { kind: "agent" as const, agentId: workerAgentId },
      generation: 1,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-1",
    };
    if (chainDb.getAgentById(workerAgentId) === null) {
      chainDb.insertAgent({
        id: workerAgentId,
        name: "lead",
        tool: "codex",
        model: "gpt-5",
        category: "simple_coding",
        status: "working",
        taskDescription: "lead",
        worktreePath: "/repo/.hive/worktrees/lead",
        branch: "hive/lead",
        sessionLocator: leadLocator,
        contextPct: null,
        createdAt,
        lastEventAt: createdAt,
        capabilityEpoch: 1,
        readOnly: false,
        writeRevoked: false,
      });
    }
    chainStore.putAgentBinding(
      {
        ...leadBinding,
        provider: "codex",
        model: "gpt-5",
        sessionLocator: leadLocator,
        worktree: "/repo/.hive/worktrees/lead",
        branch: "hive/lead",
        baseSha,
        credentialId: "credential-lead",
        boundAt: createdAt,
        unboundAt: null,
      },
      runId,
    );
    chainStore.putTask({
      ...validTask(leafSpec),
      assigneeNodeId: workerLeafNodeId,
      ownerNodeId: leadNodeId,
      branch: "hive/leaf",
    });

    const ownerFences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    };
    chainStore.putGrant(
      {
        ...rootGrant(),
        descendantNodeIds: [leadNodeId, workerLeafNodeId],
        branches: ["hive/worker", "hive/leaf"],
        budget: {
          sessions: 3,
          tokens: 20_000,
          costCents: 200,
          wallTimeMs: 3_600_000,
          retries: 2,
        },
      },
      ownerFences,
    );
    chainStore.putGrant(
      {
        ...workerGrant(),
        grantId: leadGrantId,
        subject: leadBinding,
        descendantNodeIds: [workerLeafNodeId],
        branches: ["hive/leaf"],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 3_000_000,
          retries: 1,
        },
      },
      ownerFences,
    );
    chainStore.putGrant(
      {
        ...workerGrant(),
        grantId: leafGrantId,
        parentGrantId: leadGrantId,
        issuer: leadBinding,
        subject: leafBinding,
        descendantNodeIds: [],
        branches: ["hive/leaf"],
        actions: ["read", "write", "test"],
        budget: {
          sessions: 1,
          tokens: 4_000,
          costCents: 40,
          wallTimeMs: 1_000_000,
          retries: 0,
        },
        expiresAt: "2026-07-30T13:00:00.000Z",
      },
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: leadBinding,
      },
    );

    const chainAdmission = new SpawnAdmission(
      chainStore,
      () => now,
      () => briefId,
    );
    const identity = chainAdmission.preflight(
      hierarchyFields(
        {
          nodeId: workerLeafNodeId,
          grantId: leafGrantId,
        },
        leafSpec,
      ),
      "author",
    );
    expect(identity).toMatchObject({
      nodeId: workerLeafNodeId,
      agentId: leafAgentId,
      generation: 1,
    });
    chainAdmission.prepareLaunch(
      identity,
      launchFacts(identity, {
        worktree: "/repo/.hive/worktrees/leaf",
        branch: "hive/leaf",
      }),
    );
    const brief = chainAdmission.takeLaunchContext(identity);
    expect(brief.grant.grantId).toBe(leafGrantId);
    expect(brief.grant.issuer).toEqual(leadBinding);
    chainAdmission.bindAfterReadiness(identity, "credential-leaf");
    expect(chainStore.getAgentBinding(identity)?.credentialId).toBe(
      "credential-leaf",
    );
  } finally {
    chainDb.close();
  }
});

test("new grant refuses a flat AgentRecord identity collision", () => {
  db.insertAgent(flatAgentRecord());
  const fences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 1,
    binding: ownerBinding,
  };

  expect(() =>
    store.putGrant(
      {
        ...workerGrant(),
        grantId: collidingWorkerGrantId,
        subject: {
          nodeId: workerNodeId,
          agentId: "flat-agent",
          generation: 1,
        },
      },
      fences,
    ),
  ).toThrow(HierarchyValidationError);
  expect(store.getGrant(collidingWorkerGrantId)).toBeNull();

  const created = store.putGrant(
    {
      ...workerGrant(),
      grantId: noncollidingWorkerGrantId,
      subject: {
        nodeId: workerNodeId,
        agentId: "future-hierarchy-agent",
        generation: 1,
      },
    },
    fences,
  );
  expect(created.grantId).toBe(noncollidingWorkerGrantId);

  db.insertAgent(flatAgentRecord("future-hierarchy-agent"));
  expect(store.putGrant({ ...created, status: "revoked" }, fences).status).toBe(
    "revoked",
  );
});

test("flat AgentRecord creation can still collide with an existing grant subject", () => {
  const record = flatAgentRecord("future-flat-agent");
  store.putGrant(
    {
      ...workerGrant(),
      grantId: noncollidingWorkerGrantId,
      subject: {
        nodeId: workerNodeId,
        agentId: record.id,
        generation: 1,
      },
    },
    {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    },
  );

  expect(() => db.insertAgent(record)).not.toThrow();
  const restarted = new SpawnAdmission(new HierarchyStore(db), () => now);
  expect(restarted.recipientBindingState(record)).toBe("unbound");
});

test("spawner binds after readiness and preserves identities when terminal death is unknown", async () => {
  const policy: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: createdAt,
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {
      simple_coding: {
        mode: "user-weighted",
        candidates: [
          {
            provider: "kimi",
            model: "kimi-code/k3",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    },
  };

  for (const scenario of [
    "provider-fails",
    "succeeds",
    "working-before-bind",
    "bind-then-throws",
    "paused-before-launch",
    "wrong-head",
  ] as const) {
    const launchFails = scenario === "provider-fails";
    const workingBeforeBind = scenario === "working-before-bind";
    const bindThenThrows = scenario === "bind-then-throws";
    const pauseBeforeLaunch = scenario === "paused-before-launch";
    const wrongHead = scenario === "wrong-head";
    const succeeds = scenario === "succeeds" || workingBeforeBind;
    const root = await mkdtemp(join(tmpdir(), "hive-spawn-admission-root-"));
    const home = await mkdtemp(join(tmpdir(), "hive-spawn-admission-home-"));
    const worktree = join(root, "worker");
    await mkdir(worktree, { recursive: true });
    await seedAgentStandards(root);
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    const launchedDb = new HiveDatabase(":memory:");
    const launchedStore = new HierarchyStore(launchedDb);
    const spec: DelegationSpec = {
      ...delegationSpec,
      authority: {
        ...delegationSpec.authority,
        worktree,
      },
    };
    seed(launchedDb, launchedStore, validRun(), spec);
    const launchedAdmission = bindThenThrows
      ? new (class extends SpawnAdmission {
          override bindAfterReadiness(
            identity: Parameters<SpawnAdmission["bindAfterReadiness"]>[0],
            credentialId: string,
          ): ReturnType<SpawnAdmission["bindAfterReadiness"]> {
            super.bindAfterReadiness(identity, credentialId);
            throw new Error("finalization failed after binding");
          }
        })(
          launchedStore,
          () => now,
          () => briefId,
        )
      : new SpawnAdmission(
          launchedStore,
          () => now,
          () => briefId,
        );
    let launchCalls = 0;
    let locator: SessionLocator | null = null;
    const launchState: {
      issuedCapabilityEpoch: number | null;
      pauseOutcome: string | null;
    } = {
      issuedCapabilityEpoch: null,
      pauseOutcome: null,
    };
    const spawner = new HiveSpawner({
      db: launchedDb,
      repoRoot: root,
      hierarchyAdmission: () => launchedAdmission,
      port: 4_317,
      config: {},
      readRoutingPolicy: () => policy,
      isModelEnabled: async () => true,
      readBilling: async () => null,
      createWorktree: async () => ({
        path: worktree,
        branch: "hive/worker",
      }),
      measureWorktreeHead: async () => (wrongHead ? "9".repeat(40) : baseSha),
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      sleep: async () => {},
      mcpClientSeen: () => true,
      ps: async () =>
        [
          " 4000     1  1024 /bin/zsh",
          ` 5000  4000  2048 ${process.execPath} src/cli.ts agent-ui --provider kimi`,
        ].join("\n"),
      issueCredential: (_name, _role, capabilityEpoch) => {
        launchState.issuedCapabilityEpoch = capabilityEpoch;
        if (pauseBeforeLaunch) {
          launchState.pauseOutcome = new RunControl(launchedStore).apply(
            runControlIntent("run-pause", "1", "0"),
            "engineer",
          ).outcome.status;
        }
        return "hv1.credential-worker.secret";
      },
      claudeExecutable: "claude",
      codexExecutable: "codex",
      grokExecutable: "grok",
      kimiExecutable: "kimi",
      opencodeExecutable: "opencode",
      sessiond: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-1",
          geometry: readyInspection({
            schemaVersion: 1,
            instanceId: "instance-1",
            subject: { kind: "agent", agentId: workerAgentId },
            generation: 1,
            sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
            hostKind: "sessiond",
            engineBuildId: "engine-1",
          }).geometry,
          visibility: {
            workspaceSessionId: "workspace-fixture",
            workspacePid: 3_800,
            workspaceStartToken: "3800:1",
            openTerminalRevision: "1",
          },
        }),
        admit: async () => null,
        terminalHost: {
          create: async (specification) => {
            launchCalls += 1;
            if (launchFails) throw new Error("provider launch failed");
            locator = specification.locator;
            return {
              locator,
              inspection: readyInspection(locator),
              created: true,
            };
          },
          inspect: async () => {
            if (locator === null) throw new Error("terminal was not created");
            return readyInspection(locator);
          },
          terminate: async (terminal) => ({
            locator: terminal,
            state: "terminated",
            exit: null,
            survivors: [],
            errors: [],
          }),
        },
      },
    });

    try {
      const request = {
        task: "Implement hierarchy spawn admission",
        category: "simple_coding",
        ...hierarchyFields({}, spec),
      } as const;
      if (wrongHead) {
        await expect(spawner.spawn(request)).rejects.toThrow(
          "launch worktree, branch, or base",
        );
        expect(launchCalls).toBe(0);
        expect(launchedStore.getAgentBinding(workerBinding)).toBeNull();
        expect(launchedDb.listRunOutcomes()).toHaveLength(1);
        expect(launchedDb.listRunOutcomes()[0]?.outcome).toBe("launch-failed");
        continue;
      }
      const record = await spawner.spawn(request);
      expect(record.id).toBe(workerAgentId);
      expect(record.capabilityEpoch).toBe(1);
      expect(launchedStore.getAgentBinding(workerBinding)).toBeNull();

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const binding = launchedStore.getAgentBinding(workerBinding);
        const terminal = launchedDb.getAgentById(record.id);
        if (
          (succeeds && binding?.unboundAt === null) ||
          (!succeeds &&
            terminal?.status === (bindThenThrows ? "working" : "unknown"))
        ) {
          break;
        }
        await Bun.sleep(5);
      }

      expect(launchCalls).toBe(pauseBeforeLaunch ? 0 : 1);
      expect(launchState.issuedCapabilityEpoch).toBe(1);
      if (!succeeds) {
        const retained = launchedDb.getAgentById(record.id);
        expect(retained).toMatchObject({
          status: bindThenThrows ? "working" : "unknown",
          worktreePath: worktree,
          branch: "hive/worker",
        });
        if (retained === null) throw new Error("live holder disappeared");
        const binding = launchedStore.getAgentBinding(workerBinding);
        expect(binding?.unboundAt ?? null).toBeNull();
        expect(launchedAdmission.recipientBindingState(retained)).toBe(
          bindThenThrows ? "bound" : "unbound",
        );
        if (pauseBeforeLaunch) {
          expect(launchState.pauseOutcome).toBe("accepted");
        }
        if (bindThenThrows) {
          expect(binding).toMatchObject({
            credentialId: "credential-worker",
            unboundAt: null,
          });
        }
        expect(launchedDb.listRunOutcomes()).toEqual([]);
        const activeRun = launchedDb.getActiveProviderRunForAgent(record.id);
        if (bindThenThrows) {
          expect(activeRun).toMatchObject({
            state: "running",
            endedAt: null,
          });
        } else {
          expect(activeRun).toBeNull();
        }
      } else {
        expect(launchedDb.listRunOutcomes()).toHaveLength(0);
        expect(launchedStore.getAgentBinding(workerBinding)).toMatchObject({
          agentId: workerAgentId,
          generation: 1,
          credentialId: "credential-worker",
          unboundAt: null,
        });
        const launchedRecord = launchedDb.getAgentById(record.id);
        if (launchedRecord === null) {
          throw new Error("successful hierarchy agent row is missing");
        }
        expect(launchedAdmission.recipientBindingState(launchedRecord)).toBe(
          "bound",
        );
      }

      const promptDirectory = join(home, "runtime", "prompts");
      const promptName = (await readdir(promptDirectory)).find((entry) =>
        entry.endsWith(".txt"),
      );
      expect(promptName).toBeDefined();
      if (promptName === undefined) throw new Error("launch prompt is missing");
      const prompt = await readFile(join(promptDirectory, promptName), "utf8");
      expect(prompt.split(briefId)).toHaveLength(2);
    } finally {
      launchedDb.close();
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(home, { recursive: true, force: true }),
      ]);
    }
  }
}, 10_000);

test("a hierarchy-spawned agent's launch prompt carries its open assignment pair, and the report validates", async () => {
  const policy: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: createdAt,
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {
      simple_coding: {
        mode: "user-weighted",
        candidates: [
          {
            provider: "kimi",
            model: "kimi-code/k3",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    },
  };
  const root = await mkdtemp(join(tmpdir(), "hive-spawn-assignment-root-"));
  const home = await mkdtemp(join(tmpdir(), "hive-spawn-assignment-home-"));
  const worktree = join(root, "worker");
  await mkdir(worktree, { recursive: true });
  await seedAgentStandards(root);
  const previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  const launchedDb = new HiveDatabase(":memory:");
  const launchedStore = new HierarchyStore(launchedDb);
  const statusStore = new StatusStore(launchedDb, "instance-1");
  const spec: DelegationSpec = {
    ...delegationSpec,
    authority: {
      ...delegationSpec.authority,
      worktree,
    },
  };
  seed(launchedDb, launchedStore, validRun(), spec);
  const launchedAdmission = new SpawnAdmission(
    launchedStore,
    () => now,
    () => briefId,
  );
  let locator: SessionLocator | null = null;
  const spawner = new HiveSpawner({
    db: launchedDb,
    repoRoot: root,
    hierarchyAdmission: () => launchedAdmission,
    port: 4_317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: async () => ({
      path: worktree,
      branch: "hive/worker",
    }),
    measureWorktreeHead: async () => baseSha,
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => ({ killed: [], survivors: [] }),
    sleep: async () => {},
    mcpClientSeen: () => true,
    ps: async () =>
      [
        " 4000     1  1024 /bin/zsh",
        ` 5000  4000  2048 ${process.execPath} src/cli.ts agent-ui --provider kimi`,
      ].join("\n"),
    issueCredential: () => "hv1.credential-worker.secret",
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-1",
        geometry: readyInspection({
          schemaVersion: 1,
          instanceId: "instance-1",
          subject: { kind: "agent", agentId: workerAgentId },
          generation: 1,
          sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
          hostKind: "sessiond",
          engineBuildId: "engine-1",
        }).geometry,
        visibility: {
          workspaceSessionId: "workspace-fixture",
          workspacePid: 3_800,
          workspaceStartToken: "3800:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async (specification) => {
          locator = specification.locator;
          return {
            locator,
            inspection: readyInspection(locator),
            created: true,
          };
        },
        inspect: async () => {
          if (locator === null) throw new Error("terminal was not created");
          return readyInspection(locator);
        },
        terminate: async (terminal) => ({
          locator: terminal,
          state: "terminated",
          exit: null,
          survivors: [],
          errors: [],
        }),
      },
    },
    assignments: {
      open: (agentId, openedAt) =>
        statusStore.openAssignment(agentId, openedAt),
      close: (agentId, closedAt) =>
        statusStore.closeAssignment(agentId, closedAt),
    },
  });

  try {
    const record = await spawner.spawn({
      task: "Implement hierarchy spawn admission",
      category: "simple_coding",
      ...hierarchyFields({}, spec),
    });
    expect(record.id).toBe(workerAgentId);
    // server.ts's spawnAgent wrapper opens an assignment row after every
    // spawn, hierarchy spawns included — reproduce that call here.
    statusStore.openAssignment(record.id, record.createdAt);

    const promptDirectory = join(home, "runtime", "prompts");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        (await readdir(promptDirectory).catch(() => [])).some((name) =>
          name.endsWith(".txt"),
        )
      ) {
        break;
      }
      await Bun.sleep(5);
    }
    const promptName = (await readdir(promptDirectory)).find((name) =>
      name.endsWith(".txt"),
    );
    expect(promptName).toBeDefined();
    if (promptName === undefined) throw new Error("launch prompt is missing");
    const prompt = await readFile(join(promptDirectory, promptName), "utf8");

    const open = statusStore.currentAssignment(record.id);
    if (open === null) throw new Error("no open assignment row for the spawn");
    expect(prompt).toContain(
      `Your assignment: ${open.assignmentId} generation ${open.assignmentGeneration}.`,
    );

    const actor = {
      subject: record.name,
      agentId: record.id,
      role: "writer" as const,
      incarnationGeneration: 1,
      capabilityEpoch: record.capabilityEpoch,
      toolSessionId: null,
    };
    const report = statusStore.appendAgentReport(
      actor,
      {
        requestId: "req_018f4f5e-0000-7000-8000-0000000000aa",
        assignmentId: open.assignmentId,
        assignmentGeneration: open.assignmentGeneration,
        phase: "implementing",
        summary: "hierarchy agent reporting with the pair from its prompt",
        evidenceRefs: [],
        freshForSeconds: 120,
      },
      now,
    );
    expect(report.eventId).toStartWith("evt_");

    // A report naming any other assignment is still rejected: the validation
    // is the defence, not the defect.
    expect(() =>
      statusStore.appendAgentReport(
        actor,
        {
          requestId: "req_018f4f5e-0000-7000-8000-0000000000bb",
          assignmentId: "asg_018f4f5e-0000-7000-8000-0000000000cc",
          assignmentGeneration: open.assignmentGeneration,
          phase: "implementing",
          summary: "a fabricated pair must not validate",
          evidenceRefs: [],
          freshForSeconds: 120,
        },
        now,
      ),
    ).toThrow(StatusAssignmentMismatchError);
  } finally {
    launchedDb.close();
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}, 10_000);

test("a sessiond-alive terminal keeps its hierarchy binding and is never stopped", async () => {
  const policy: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: createdAt,
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {
      simple_coding: {
        mode: "user-weighted",
        candidates: [
          {
            provider: "kimi",
            model: "kimi-code/k3",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    },
  };
  const root = await mkdtemp(join(tmpdir(), "hive-hierarchy-kickoff-root-"));
  const home = await mkdtemp(join(tmpdir(), "hive-hierarchy-kickoff-home-"));
  const worktree = join(root, "worker");
  await mkdir(worktree, { recursive: true });
  await seedAgentStandards(root);
  const previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  const db = new HiveDatabase(":memory:");
  const store = new HierarchyStore(db);
  const spec: DelegationSpec = {
    ...delegationSpec,
    authority: { ...delegationSpec.authority, worktree },
  };
  seed(db, store, validRun(), spec);
  const admission = new SpawnAdmission(
    store,
    () => now,
    () => briefId,
  );
  let stopCalls = 0;
  let locator: SessionLocator | null = null;
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    hierarchyAdmission: () => admission,
    port: 4_317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: async () => ({ path: worktree, branch: "hive/worker" }),
    measureWorktreeHead: async () => baseSha,
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => {
      stopCalls += 1;
      return { killed: [], survivors: [] };
    },
    sleep: async () => {},
    mcpClientSeen: () => true,
    ps: async () =>
      [
        " 4000     1  1024 /bin/zsh",
        ` 5000  4000  2048 ${process.execPath} src/cli.ts agent-ui --provider kimi`,
      ].join("\n"),
    issueCredential: () => "hv1.credential-worker.secret",
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-1",
        geometry: readyInspection({
          schemaVersion: 1,
          instanceId: "instance-1",
          subject: { kind: "agent", agentId: workerAgentId },
          generation: 1,
          sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
          hostKind: "sessiond",
          engineBuildId: "engine-1",
        }).geometry,
        visibility: {
          workspaceSessionId: "workspace-fixture",
          workspacePid: 3_800,
          workspaceStartToken: "3800:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async (specification) => {
          locator = specification.locator;
          return {
            locator,
            inspection: readyInspection(locator),
            created: true,
          };
        },
        inspect: async () => {
          if (locator === null) throw new Error("terminal was not created");
          return readyInspection(locator);
        },
        terminate: async (terminal) => ({
          locator: terminal,
          state: "terminated",
          exit: null,
          survivors: [],
          errors: [],
        }),
      },
    },
  });

  try {
    const record = await spawner.spawn({
      task: "Implement hierarchy spawn admission",
      category: "simple_coding",
      ...hierarchyFields({}, spec),
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (db.getAgentById(record.id)?.status === "working") break;
      await Bun.sleep(5);
    }

    expect(db.getAgentById(record.id)).toMatchObject({
      status: "working",
      worktreePath: worktree,
    });
    expect(store.getAgentBinding(workerBinding)).toMatchObject({
      agentId: workerAgentId,
      unboundAt: null,
    });
    expect(stopCalls).toBe(0);
    expect((await stat(worktree)).isDirectory()).toBeTrue();
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}, 10_000);

test("a launch that aborts before the AgentRecord releases the identity for a corrected retry", async () => {
  const routed: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: createdAt,
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {
      simple_coding: {
        mode: "user-weighted",
        candidates: [
          {
            provider: "kimi",
            model: "kimi-code/k3",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    },
  };
  const unrouted: RoutingPolicy = { ...routed, categories: {} };

  // Every throw point between the identity reservation and the AgentRecord
  // insertion, in the order the spawn reaches them.
  for (const scenario of [
    { fault: "routing-refusal", rejects: "has no route and no global route" },
    { fault: "worktree-failure", rejects: "worktree creation failed" },
    { fault: "wrong-head", rejects: "launch worktree, branch, or base" },
    { fault: "record-insert", rejects: "agent row insert failed" },
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "hive-spawn-release-root-"));
    const home = await mkdtemp(join(tmpdir(), "hive-spawn-release-home-"));
    const worktree = join(root, "worker");
    await mkdir(worktree, { recursive: true });
    await seedAgentStandards(root);
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    const launchedDb = new HiveDatabase(":memory:");
    const launchedStore = new HierarchyStore(launchedDb);
    const spec: DelegationSpec = {
      ...delegationSpec,
      authority: { ...delegationSpec.authority, worktree },
    };
    seed(launchedDb, launchedStore, validRun(), spec);
    const launchedAdmission = new SpawnAdmission(
      launchedStore,
      () => now,
      () => briefId,
    );
    // Armed for the first spawn only. Disarming it is the correction whose
    // retry has to be admitted.
    let faulted = true;
    let locator: SessionLocator | null = null;
    // The one fault that lands past prepareLaunch: the brief is already minted
    // when the row fails, so the retry has to be able to mint its own.
    const faultyDb = new Proxy(launchedDb, {
      get: (target, property) => {
        if (property === "insertAgent" && faulted) {
          return () => {
            throw new Error("agent row insert failed");
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const spawner = new HiveSpawner({
      db: scenario.fault === "record-insert" ? faultyDb : launchedDb,
      repoRoot: root,
      hierarchyAdmission: () => launchedAdmission,
      port: 4_317,
      config: {},
      readRoutingPolicy: () =>
        faulted && scenario.fault === "routing-refusal" ? unrouted : routed,
      isModelEnabled: async () => true,
      readBilling: async () => null,
      createWorktree: async () => {
        if (faulted && scenario.fault === "worktree-failure") {
          throw new Error("worktree creation failed");
        }
        return { path: worktree, branch: "hive/worker" };
      },
      measureWorktreeHead: async () =>
        faulted && scenario.fault === "wrong-head" ? "9".repeat(40) : baseSha,
      settlement: {
        open: async () => {},
        settleFailed: async (_agent, failedWorktree) => ({
          preserved: null,
          removed: failedWorktree !== null,
          cleanupErrors: [],
        }),
      },
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      sleep: async () => {},
      mcpClientSeen: () => true,
      ps: async () =>
        [
          " 4000     1  1024 /bin/zsh",
          ` 5000  4000  2048 ${process.execPath} src/cli.ts agent-ui --provider kimi`,
        ].join("\n"),
      issueCredential: () => "hv1.credential-worker.secret",
      claudeExecutable: "claude",
      codexExecutable: "codex",
      grokExecutable: "grok",
      kimiExecutable: "kimi",
      opencodeExecutable: "opencode",
      sessiond: {
        prepareAgentCreation: async () => ({
          engineBuildId: "engine-1",
          geometry: readyInspection({
            schemaVersion: 1,
            instanceId: "instance-1",
            subject: { kind: "agent", agentId: workerAgentId },
            generation: 1,
            sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
            hostKind: "sessiond",
            engineBuildId: "engine-1",
          }).geometry,
          visibility: {
            workspaceSessionId: "workspace-fixture",
            workspacePid: 3_800,
            workspaceStartToken: "3800:1",
            openTerminalRevision: "1",
          },
        }),
        admit: async () => null,
        terminalHost: {
          create: async (specification) => {
            locator = specification.locator;
            return {
              locator,
              inspection: readyInspection(locator),
              created: true,
            };
          },
          inspect: async () => {
            if (locator === null) throw new Error("terminal was not created");
            return readyInspection(locator);
          },
          terminate: async (terminal) => ({
            locator: terminal,
            state: "terminated",
            exit: null,
            survivors: [],
            errors: [],
          }),
        },
      },
    });

    try {
      const request = {
        task: "Implement hierarchy spawn admission",
        category: "simple_coding",
        ...hierarchyFields({}, spec),
      } as const;

      await expect(spawner.spawn(request)).rejects.toThrow(scenario.rejects);
      // The abort is pre-record, so the reservation is the only thing the
      // failed attempt could still be holding.
      expect(launchedDb.getAgentById(workerAgentId)).toBeNull();
      expect(launchedStore.getAgentBinding(workerBinding)).toBeNull();

      faulted = false;
      const record = await spawner.spawn(request);
      expect(record.id).toBe(workerAgentId);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (launchedStore.getAgentBinding(workerBinding)?.unboundAt === null) {
          break;
        }
        await Bun.sleep(5);
      }
      expect(launchedStore.getAgentBinding(workerBinding)).toMatchObject({
        agentId: workerAgentId,
        generation: 1,
        credentialId: "credential-worker",
        unboundAt: null,
      });
      // Positive control: releasing a dead reservation must not release a live
      // one. The retry now holds the identity, so the next one is refused.
      expect(() =>
        launchedAdmission.preflight(hierarchyFields({}, spec), "author"),
      ).toThrow("is already reserved");
    } finally {
      launchedDb.close();
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(home, { recursive: true, force: true }),
      ]);
    }
  }
}, 20_000);
