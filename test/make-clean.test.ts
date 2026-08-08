import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HierarchyStore } from "../src/daemon/hierarchy-store";
import { serializeMemoryFile } from "../src/memory-service/memory-store";
import { TaskDetailSchema } from "../src/schemas/task-detail";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const root = join(import.meta.dir, "..");
const agentId = "agent-make-clean-proof";
const taskId = "task_018f4f5e-0000-7000-8000-000000000122";
const memoryId = "make-clean-preserves-state";
const createdAt = "2026-08-10T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const baseSha = "b".repeat(40);
const owner = {
  nodeId: "node_018f4f5e-0000-7000-8000-000000000122",
  agentId,
  generation: 1,
};
const taskDocument = TaskDetailSchema.parse({
  taskId,
  revision: "1",
  parentTaskId: null,
  dependsOn: [],
  delegationSpec: {
    objective: "Recognizable task survives make clean",
    parentAcceptanceIds: ["acc-make-clean-proof"],
    childOutcome: "State remains readable",
    terminationCondition: "Fresh process reads the state",
    inputs: {
      specRevision: { revision: "1", digest },
      planRevision: { revision: "1", digest },
      taskRevisions: [],
      interfaceRevisions: [],
      baseSha,
      prerequisites: [],
      sourceArtifactRefs: [],
    },
    boundaries: { allowedPaths: [] },
    authority: {
      grantId: "grant_018f4f5e-0000-7000-8000-000000000122",
      permittedOperations: ["read"],
      environment: "worktree",
      worktree: "/tmp/make-clean-proof",
      branch: "hive/make-clean-proof",
      explicitNonAuthority: [],
    },
    allowance: {
      sessions: 1,
      tokens: 1,
      costCents: 1,
      wallTimeMs: 1,
      retries: 0,
      blockers: [],
      owner,
    },
  },
  acceptanceIds: ["acc-make-clean-proof"],
  ownerNodeId: owner.nodeId,
  assigneeNodeId: null,
  pathLeases: [],
  branch: "hive/make-clean-proof",
  baseSha,
  state: "planned",
  blockers: [],
  evidence: [],
  artifactRefs: [],
});

function seedRecognizableState(devHome: string): HiveDatabase {
  const database = new HiveDatabase(join(devHome, "hive.db"));
  new HierarchyStore(database);
  database.database.exec("PRAGMA wal_autocheckpoint = 0");
  database.insertAgent({
    id: agentId,
    name: "make-clean-proof",
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "working",
    taskDescription: "Prove developer state survives clean",
    worktreePath: "/tmp/make-clean-proof",
    branch: "hive/make-clean-proof",
    contextPct: 12,
    createdAt,
    lastEventAt: createdAt,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  });
  database.database
    .query(
      `INSERT INTO hierarchy_records
         (kind, id, runId, revision, capabilityEpoch, document)
       VALUES ('task', ?, 'run-make-clean-proof', '1', NULL, ?)`,
    )
    .run(taskId, JSON.stringify(taskDocument));

  const memoryDirectory = join(devHome, "memory", "wiki", "testing");
  mkdirSync(memoryDirectory, { recursive: true });
  writeFileSync(
    join(memoryDirectory, `${memoryId}.md`),
    serializeMemoryFile({
      title: "Make clean preserves state",
      date: "2026-08-10",
      topic: "testing",
      source: "agent",
      evidence: "Seeded by the make-clean regression test.",
      status: "verified",
      kind: "article",
      verified: "2026-08-10",
      tags: ["clean"],
      supersedes: [],
      raw: [],
      body: "Recognizable memory survives make clean.",
    }),
  );
  mkdirSync(join(devHome, "artifacts", "proof"), { recursive: true });
  writeFileSync(
    join(devHome, "artifacts", "proof", "evidence.md"),
    "recognizable artifact\n",
  );
  mkdirSync(join(devHome, "runtime", "checkpoints"), { recursive: true });
  writeFileSync(
    join(devHome, "runtime", "checkpoints", "proof.json"),
    '{"checkpoint":"recognizable"}\n',
  );
  return database;
}

function runMake(
  target: "clean" | "clean-all",
  dev: string,
  devHome: string,
  stageBinary = true,
) {
  if (stageBinary) {
    const installed = join(dev, "root", "current", "hive");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(
      installed,
      `#!/bin/sh
[ "$1" = uninstall ] || exit 91
[ "$2" = --yes ] || exit 92
touch ${JSON.stringify(join(devHome, ".shared-uninstaller-called"))}
printf '%s\n' "$*" > ${JSON.stringify(join(devHome, ".shared-uninstaller-argv"))}
`,
      { mode: 0o755 },
    );
  }
  return Bun.spawnSync(
    [
      "make",
      "-f",
      join(root, "Makefile"),
      target,
      `DEV=${dev}`,
      `DEV_HOME=${devHome}`,
    ],
    {
      cwd: dirname(dev),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function readStateInFreshProcess(devHome: string) {
  const databaseModule = pathToFileURL(
    join(root, "src", "daemon", "database", "hive-database.ts"),
  ).href;
  const memoryModule = pathToFileURL(
    join(root, "src", "memory-service", "memory-store.ts"),
  ).href;
  const hierarchyModule = pathToFileURL(
    join(root, "src", "daemon", "hierarchy-store.ts"),
  ).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { HiveDatabase } from ${JSON.stringify(databaseModule)};
    import { HierarchyStore } from ${JSON.stringify(hierarchyModule)};
    import { readMemoryFact } from ${JSON.stringify(memoryModule)};
    const home = process.env.HIVE_HOME;
    if (!home) throw new Error("missing throwaway HIVE_HOME");
    const database = HiveDatabase.openReadonly(join(home, "hive.db"));
    try {
      if (database.getAgentById(${JSON.stringify(agentId)})?.name !== "make-clean-proof") {
        throw new Error("seeded agent is not readable");
      }
      const task = new HierarchyStore(database).getTask(${JSON.stringify(taskId)});
      if (task?.delegationSpec.objective !== "Recognizable task survives make clean") {
        throw new Error("seeded task is not readable");
      }
      const memory = await readMemoryFact(${JSON.stringify(root)}, "global", ${JSON.stringify(memoryId)});
      if (memory?.body !== "Recognizable memory survives make clean.") {
        throw new Error("seeded memory is not readable");
      }
      if (readFileSync(join(home, "artifacts", "proof", "evidence.md"), "utf8") !== "recognizable artifact\\n") {
        throw new Error("seeded artifact is not readable");
      }
      if (JSON.parse(readFileSync(join(home, "runtime", "checkpoints", "proof.json"), "utf8")).checkpoint !== "recognizable") {
        throw new Error("seeded checkpoint is not readable");
      }
    } finally {
      database.close();
    }
  `;
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, HIVE_HOME: devHome },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("make clean removes build output and scratch while preserving readable dev state", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-make-clean-"));
  const dev = join(fixture, "dev");
  const devHome = join(fixture, "home");
  const scratch = join(fixture, `.${crypto.randomUUID()}.bun-build`);
  let database: HiveDatabase | null = null;
  try {
    mkdirSync(join(dev, "tmp"), { recursive: true });
    writeFileSync(join(dev, "tmp", "build-scratch"), "scratch\n");
    writeFileSync(scratch, "interrupted bun build\n");
    database = seedRecognizableState(devHome);
    expect(existsSync(join(devHome, "hive.db-wal"))).toBe(true);

    const result = runMake("clean", dev, devHome);
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(0);
    expect(existsSync(dev)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(devHome, ".shared-uninstaller-called"))).toBe(true);
    // A retaining clean passes no purge flag: the override is clean-all's alone.
    expect(
      readFileSync(join(devHome, ".shared-uninstaller-argv"), "utf8"),
    ).toBe("uninstall --yes\n");

    const read = readStateInFreshProcess(devHome);
    expect(read.exitCode, read.stdout.toString() + read.stderr.toString()).toBe(
      0,
    );
  } finally {
    database?.close();
    rmSync(scratch, { force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);

test("make clean-all delegates a purge to the shared uninstaller", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-make-clean-all-"),
  );
  const dev = join(fixture, "dev");
  const devHome = join(fixture, "home");
  const sharedMemory = join(fixture, "shared-memory");
  try {
    mkdirSync(dev, { recursive: true });
    seedRecognizableState(devHome).close();
    mkdirSync(sharedMemory);
    writeFileSync(join(sharedMemory, "article.md"), "shared memory\n");
    symlinkSync(sharedMemory, join(devHome, "models"));

    const before = readStateInFreshProcess(devHome);
    expect(
      before.exitCode,
      before.stdout.toString() + before.stderr.toString(),
    ).toBe(0);

    const result = runMake("clean-all", dev, devHome);
    const output = result.stdout.toString() + result.stderr.toString();

    // The Makefile's whole contract here is delegation: clean-all is the shared uninstaller with
    // its retention overridden by --purge, never a second sweep. What the purge then destroys —
    // and what it provably does not — is asserted against the real uninstaller on scratch homes
    // in test/hive-home/purge.test.ts.
    expect(result.exitCode, output).toBe(0);
    expect(existsSync(join(devHome, ".shared-uninstaller-called"))).toBe(true);
    expect(
      readFileSync(join(devHome, ".shared-uninstaller-argv"), "utf8"),
    ).toBe("uninstall --yes --purge\n");
    expect(existsSync(dev)).toBe(false);
    expect(existsSync(join(sharedMemory, "article.md"))).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);

test("make clean removes build output when no installed binary exists", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-make-clean-empty-"),
  );
  const dev = join(fixture, "dev");
  const devHome = join(fixture, "home");
  try {
    mkdirSync(join(dev, "tmp"), { recursive: true });
    writeFileSync(join(dev, "tmp", "build-scratch"), "scratch\n");

    const result = runMake("clean", dev, devHome, false);
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("removing build output only");
    expect(existsSync(dev)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);
