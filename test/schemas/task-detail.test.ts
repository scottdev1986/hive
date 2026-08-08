import { describe, expect, test } from "bun:test";
import {
  ArtifactRefSchema,
  TaskDetailSchema,
  TaskSchema,
} from "../../src/schemas/task-detail";

const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const nodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const grantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const artifactId = "art_018f4f5e-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);

const delegationSpec = {
  objective: "Implement task records",
  parentAcceptanceIds: ["A1"],
  childOutcome: "Schemas and tests are green",
  terminationCondition: "Checks pass",
  inputs: {
    specRevision: { revision: "1", digest },
    planRevision: { revision: "1", digest },
    taskRevisions: [],
    interfaceRevisions: [],
    baseSha: gitSha,
    prerequisites: [],
    sourceArtifactRefs: [],
  },
  boundaries: {
    allowedPaths: ["src/schemas"],
  },
  authority: {
    grantId,
    permittedOperations: ["read", "write", "test"] as const,
    environment: "worktree",
    worktree: "/worktree",
    branch: "hive/worker",
    explicitNonAuthority: ["land"],
  },
  allowance: {
    sessions: 1,
    tokens: 10_000,
    costCents: 100,
    wallTimeMs: 3_600_000,
    retries: 2,
    blockers: [],
    owner: { nodeId, agentId: "worker", generation: 1 },
  },
};

const validTask = {
  taskId,
  revision: "2",
  parentTaskId: null,
  dependsOn: [],
  delegationSpec,
  acceptanceIds: ["A1"],
  ownerNodeId: nodeId,
  assigneeNodeId: nodeId,
  pathLeases: [{ path: "src/schemas", mode: "write" as const }],
  branch: "hive/worker",
  baseSha: gitSha,
  state: "in-progress" as const,
  blockers: [],
  evidence: [],
  artifactRefs: [artifactId],
};

const validArtifact = {
  artifactId,
  kind: "test-evidence",
  ownerNodeId: nodeId,
  taskId,
  digest,
  contentRevision: "1",
  storageLocator: "artifact-store://run/artifact",
  accessCapability: "capability-1",
  sizeBytes: 1024,
  createdAt: "2026-07-30T12:00:00.000Z",
  retention: "run" as const,
};

describe("TaskSchema and TaskDetailSchema", () => {
  test("round-trips a task record", () => {
    const task = TaskSchema.parse(validTask);
    expect(TaskSchema.parse(JSON.parse(JSON.stringify(task)))).toEqual(task);
  });

  test("TaskDetail carries one record revision, not an operation CAS token", () => {
    expect(TaskDetailSchema.safeParse(validTask).success).toBe(true);
    expect(
      TaskDetailSchema.safeParse({ ...validTask, expectedRevision: "1" })
        .success,
    ).toBe(false);
  });

  test("rejects malformed task and artifact ids and unsafe lease paths", () => {
    expect(
      TaskSchema.safeParse({ ...validTask, taskId: "task-1" }).success,
    ).toBe(false);
    expect(
      TaskSchema.safeParse({ ...validTask, artifactRefs: ["art-1"] }).success,
    ).toBe(false);
    expect(
      TaskSchema.safeParse({
        ...validTask,
        pathLeases: [{ path: "/etc/passwd", mode: "write" }],
      }).success,
    ).toBe(false);
  });
});

describe("ArtifactRefSchema", () => {
  test("round-trips a verifiable artifact reference", () => {
    const artifact = ArtifactRefSchema.parse(validArtifact);

    expect(
      ArtifactRefSchema.parse(JSON.parse(JSON.stringify(artifact))),
    ).toEqual(artifact);
  });

  test("rejects a malformed artifact id", () => {
    expect(
      ArtifactRefSchema.safeParse({
        ...validArtifact,
        artifactId: "art-1",
      }).success,
    ).toBe(false);
  });
});
