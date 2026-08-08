// The artifact store as an agent reaches it: through the two registered tools,
// against the real capability layer, with real files on a real disk under a
// throwaway HIVE_HOME. What has to hold is the whole chain — an agent stores an
// analysis, gets an id the board accepts as evidence, and someone else reads
// the body back — plus the two refusals that keep the store honest: an unknown
// id, and a reader trying to write.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactMetadata,
  artifactReadRoots,
  artifactsRoot,
  getArtifact,
  legacyArtifactsRoot,
  putArtifact,
  sweepArtifacts,
} from "../../src/daemon/artifact-store/artifact-store";
import {
  type ArtifactGetResult,
  registerArtifactTools,
} from "../../src/daemon/artifact-store/artifact-store-tool";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { applyTaskUpdate } from "../../src/daemon/hierarchy-service/task-update";
import { MemoryRetentionService } from "../../src/daemon/memory-retention-service/memory-retention-service";
import type { Role } from "../../src/schemas/authority";
import { ArtifactRefIdSchema } from "../../src/schemas/hierarchy-ids";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { required } from "../required";
import {
  captureTools,
  realCaller,
  type ToolHandler,
} from "./hierarchy-tool-fixture";

const home = mkdtempSync(join(tmpdir(), "hive-artifact-home-"));
process.env.HIVE_HOME = home;
// A repo root only has to be a directory the project registry can key on; the
// store never reads what is in it.
const REPO_ROOT = mkdtempSync(join(tmpdir(), "hive-artifact-repo-"));

const TASK_ID = "task_019fec14-1005-7000-8000-0000000000a1";
const RUN_ID = "run_019fec14-1005-7000-8000-0000000000a2";
const GIT_SHA = "c".repeat(40);
const NOW = new Date("2026-08-10T12:00:00.000Z");

let db: HiveDatabase;

beforeEach(() => {
  db = new HiveDatabase(":memory:");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function handlerFor(name: string, role: Role, tool: string): ToolHandler {
  const { server, handlers } = captureTools();
  const caller = realCaller(db, name, role);
  registerArtifactTools(server, caller.capability, {
    artifactsRoot: () => artifactsRoot(REPO_ROOT),
    artifactReadRoots: () => artifactReadRoots(REPO_ROOT),
    authorizeTool: caller.authorizeTool,
  });
  return required(handlers.get(tool), `${tool} not registered`);
}

async function put(
  name: string,
  role: Role,
  input: Record<string, unknown>,
): Promise<ArtifactMetadata> {
  const result = (await handlerFor(
    name,
    role,
    "hive_artifact_put",
  )(input as never)) as { structuredContent: { artifact: ArtifactMetadata } };
  return result.structuredContent.artifact;
}

async function get(
  name: string,
  role: Role,
  artifactId: string,
): Promise<ArtifactGetResult> {
  const result = (await handlerFor(
    name,
    role,
    "hive_artifact_get",
  )({
    artifactId,
  } as never)) as { structuredContent: { artifact: ArtifactGetResult } };
  return result.structuredContent.artifact;
}

/** A task in flight, so the only thing an update changes is its evidence. */
function task(): TaskDetail {
  return {
    taskId: TASK_ID,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: {
      objective: "Build the artifact store",
      parentAcceptanceIds: ["board"],
      childOutcome: "Work products survive the mailbox",
      terminationCondition: "The store lands",
      inputs: {
        specRevision: { revision: "1", digest: `sha256:${"d".repeat(64)}` },
        planRevision: { revision: "1", digest: `sha256:${"d".repeat(64)}` },
        taskRevisions: [],
        interfaceRevisions: [],
        baseSha: GIT_SHA,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: { allowedPaths: ["src"] },
      authority: {
        grantId: "grant_019fec14-1005-7000-8000-0000000000a3",
        permittedOperations: ["message"],
        environment: "worktree",
        worktree: "/worktrees/damian",
        branch: "hive/damian",
        explicitNonAuthority: ["promote"],
      },
      allowance: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 60_000,
        retries: 0,
        blockers: [],
        owner: {
          nodeId: "node_019fec14-1005-7000-8000-0000000000a4",
          agentId: "agent-damian",
          generation: 1,
        },
      },
    },
    acceptanceIds: ["stored"],
    ownerNodeId: "node_019fec14-1005-7000-8000-0000000000a4",
    assigneeNodeId: "node_019fec14-1005-7000-8000-0000000000a5",
    pathLeases: [],
    branch: "hive/damian",
    baseSha: GIT_SHA,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

describe("hive_artifact_put / hive_artifact_get", () => {
  test("a stored work product is a file on disk and reads back byte for byte", async () => {
    const body = "# Findings\n\n- one\n- two\n\n```\nliteral --- fence\n```\n";
    const stored = await put("damian", "writer", {
      taskOrRunId: TASK_ID,
      body,
      title: "Artifact store findings",
    });

    expect(stored.storagePath).toBe(
      join(artifactsRoot(REPO_ROOT), TASK_ID, `${stored.artifactId}.md`),
    );
    expect(existsSync(stored.storagePath)).toBe(true);
    // The file a user opens carries the metadata the path cannot.
    const contents = readFileSync(stored.storagePath, "utf8");
    expect(contents).toContain(`artifact: ${stored.artifactId}`);
    expect(contents).toContain("author: damian");
    expect(contents.endsWith(body)).toBe(true);

    const read = await get("nova", "reader", stored.artifactId);
    expect(read).toEqual({
      kind: "artifact",
      artifactId: stored.artifactId,
      taskOrRunId: TASK_ID,
      title: "Artifact store findings",
      author: "damian",
      createdAt: stored.createdAt,
      storagePath: stored.storagePath,
      body,
    });
  });

  test("a run id is an owner too, and a title is optional", async () => {
    const stored = await put("damian", "writer", {
      taskOrRunId: RUN_ID,
      body: "no title on this one",
    });
    expect(stored.taskOrRunId).toBe(RUN_ID);
    expect(stored.title).toBeNull();
    const read = await get("damian", "writer", stored.artifactId);
    expect(read).toMatchObject({ kind: "artifact", title: null });
  });

  test("the minted id is one the board's ArtifactRef schema accepts", async () => {
    const stored = await put("damian", "writer", {
      taskOrRunId: TASK_ID,
      body: "an analysis worth citing",
    });
    expect(ArtifactRefIdSchema.safeParse(stored.artifactId).success).toBe(true);
    // Positive control on the check itself: the schema does refuse other shapes.
    expect(ArtifactRefIdSchema.safeParse("art_not-a-uuid").success).toBe(false);
  });

  test("a task carries the minted id as evidence, and still refuses free text", async () => {
    const stored = await put("damian", "writer", {
      taskOrRunId: TASK_ID,
      body: "the analysis behind this task",
    });
    const actorNodeId = task().assigneeNodeId as string;

    const updated = applyTaskUpdate(task(), {
      taskId: TASK_ID,
      expectedRevision: "1",
      actorNodeId,
      evidence: [stored.artifactId],
    });
    expect(updated.evidence).toEqual([stored.artifactId]);

    expect(() =>
      applyTaskUpdate(task(), {
        taskId: TASK_ID,
        expectedRevision: "1",
        actorNodeId,
        evidence: ["see my mail about the analysis"],
      }),
    ).toThrow();
  });

  test("an unknown id refuses with a Fix: line rather than an empty body", async () => {
    const unknown = "art_019fec14-1005-7000-8000-0000000000ff";
    const refusal = await get("damian", "writer", unknown);
    expect(refusal).toEqual({
      kind: "refusal",
      artifactId: unknown,
      fix: expect.stringContaining("Fix: "),
    });
  });
});

describe("artifact store role matrix", () => {
  test("a reader may read what a writer stored and may not store its own", async () => {
    const stored = await put("damian", "writer", {
      taskOrRunId: TASK_ID,
      body: "writer work product",
    });
    expect(await get("nova", "reader", stored.artifactId)).toMatchObject({
      kind: "artifact",
    });

    await expect(
      put("nova", "reader", { taskOrRunId: TASK_ID, body: "reader work" }),
    ).rejects.toThrow(/Role reader may not artifact:write/);
  });

  test("the orchestrator holds both halves", async () => {
    const stored = await put("queen", "orchestrator", {
      taskOrRunId: RUN_ID,
      body: "the queen's own note",
    });
    expect(await get("queen", "orchestrator", stored.artifactId)).toMatchObject(
      {
        kind: "artifact",
        author: "queen",
      },
    );
  });
});

describe("artifact retention", () => {
  const sweepRoot = () => join(home, "sweep-root");

  const store = (createdAt: Date, taskOrRunId = TASK_ID): ArtifactMetadata =>
    putArtifact({
      root: sweepRoot(),
      taskOrRunId,
      title: null,
      author: "damian",
      body: "aging work product",
      now: createdAt,
    });

  test("the configured window decides what goes and what stays", () => {
    const aged = store(new Date(NOW.getTime() - 91 * 24 * 3_600_000));
    const fresh = store(new Date(NOW.getTime() - 89 * 24 * 3_600_000));

    expect(sweepArtifacts(sweepRoot(), 90, NOW)).toBe(1);
    expect(getArtifact(sweepRoot(), aged.artifactId)).toBeNull();
    expect(getArtifact(sweepRoot(), fresh.artifactId)).not.toBeNull();

    // Same files, a shorter window: the survivor goes too, so the number is
    // the policy and not the age alone.
    expect(sweepArtifacts(sweepRoot(), 30, NOW)).toBe(1);
    expect(getArtifact(sweepRoot(), fresh.artifactId)).toBeNull();
  });

  test("the retention pass that ages memory out is the one that sweeps artifacts", async () => {
    let swept = 0;
    const logged: string[] = [];
    const service = new MemoryRetentionService({
      repoRoot: REPO_ROOT,
      config: null,
      episodic: null,
      serializeMemory: async (operation) => operation(),
      rebuildMemoryIndex: async () => undefined,
      runSweep: async () => null,
      sweepArtifacts: () => {
        swept += 1;
        return 2;
      },
      artifactRetentionDays: 90,
      log: (line) => logged.push(line),
    });

    // Memory retention is off in this service, which is exactly why it proves
    // the artifact leg is its own: the pass still runs and still reports.
    expect(await service.runMemoryRetentionSweep()).toBeNull();
    expect(swept).toBe(1);
    expect(logged).toEqual([
      "Hive artifact retention sweep: deleted 2 aged work product(s)",
    ]);
  });
});

describe("artifact durability across homes", () => {
  // An installed session runs out of a fresh per-run instance home, so board
  // evidence cannot live under the instance. A rig is the machine home plus an
  // instance under it — HIVE_DEFAULT_HOME and HIVE_HOME exactly as an
  // installed session sets them — and the registry is copied between instances
  // the way prepareFreshWorkspaceInstance copies it, so the project key holds.
  async function withInstanceRig(
    run: (rig: { machineHome: string; instanceHome: string }) => Promise<void>,
  ): Promise<void> {
    const machineHome = mkdtempSync(join(tmpdir(), "hive-artifact-machine-"));
    const instanceHome = join(machineHome, "instances", "run-a");
    mkdirSync(instanceHome, { recursive: true });
    const previousHome = process.env.HIVE_HOME;
    const previousDefault = process.env.HIVE_DEFAULT_HOME;
    process.env.HIVE_DEFAULT_HOME = machineHome;
    process.env.HIVE_HOME = instanceHome;
    try {
      await run({ machineHome, instanceHome });
    } finally {
      process.env.HIVE_HOME = previousHome;
      if (previousDefault === undefined) {
        delete process.env.HIVE_DEFAULT_HOME;
      } else {
        process.env.HIVE_DEFAULT_HOME = previousDefault;
      }
      rmSync(machineHome, { recursive: true, force: true });
    }
  }

  test("a write from a per-run instance home lands at the machine-level root and survives that instance's removal", async () => {
    await withInstanceRig(async ({ machineHome, instanceHome: instanceA }) => {
      const stored = putArtifact({
        root: artifactsRoot(REPO_ROOT),
        taskOrRunId: TASK_ID,
        title: null,
        author: "damian",
        body: "evidence that must outlive its session",
        now: NOW,
      });
      const rootA = artifactsRoot(REPO_ROOT);
      expect(rootA.startsWith(join(machineHome, "artifacts"))).toBe(true);
      expect(existsSync(stored.storagePath)).toBe(true);
      // Positive control: nothing was written under the instance's own home.
      expect(existsSync(join(instanceA, "artifacts"))).toBe(false);

      // The next session is a fresh instance home with the registry carried
      // forward, and the old instance home is gone entirely.
      const instanceB = join(machineHome, "instances", "run-b");
      mkdirSync(instanceB, { recursive: true });
      copyFileSync(
        join(instanceA, "project-registry.json"),
        join(instanceB, "project-registry.json"),
      );
      rmSync(instanceA, { recursive: true, force: true });
      process.env.HIVE_HOME = instanceB;

      expect(artifactsRoot(REPO_ROOT)).toBe(rootA);
      expect(getArtifact(rootA, stored.artifactId)).toMatchObject({
        body: "evidence that must outlive its session",
      });
    });
  });

  test("an artifact only in the pre-move per-instance root still resolves through the read roots", async () => {
    await withInstanceRig(async ({ instanceHome }) => {
      // As the pre-move store wrote it: under the instance's own home.
      const stored = putArtifact({
        root: legacyArtifactsRoot(REPO_ROOT),
        taskOrRunId: TASK_ID,
        title: null,
        author: "damian",
        body: "minted before the move",
        now: NOW,
      });
      expect(
        stored.storagePath.startsWith(join(instanceHome, "artifacts")),
      ).toBe(true);

      expect(artifactReadRoots(REPO_ROOT)).toEqual([
        artifactsRoot(REPO_ROOT),
        legacyArtifactsRoot(REPO_ROOT),
      ]);
      // Positive control: the durable root alone does not have it.
      expect(
        getArtifact(artifactsRoot(REPO_ROOT), stored.artifactId),
      ).toBeNull();

      const read = await get("nova", "reader", stored.artifactId);
      expect(read).toMatchObject({
        kind: "artifact",
        body: "minted before the move",
      });
    });
  });

  test("a live home that already is the machine-level one yields a single read root", () => {
    // The suite's own throwaway home is a plain directory, not an instance.
    expect(artifactReadRoots(REPO_ROOT)).toEqual([artifactsRoot(REPO_ROOT)]);
  });
});
