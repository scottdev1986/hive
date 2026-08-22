import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginOwnership,
  captureOwnership,
  readOwnershipRegistry,
  stopOwnedProcesses,
} from "./process-ownership";

interface FakeProcess {
  command: string;
  executablePath: string;
  startToken: string;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-qa-ownership-"));
  const qaRoot = join(root, "qa");
  const registryPath = join(qaRoot, "state", "processes.json");
  const processes = new Map<number, FakeProcess>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  mkdirSync(qaRoot, { recursive: true });
  return {
    root,
    qaRoot,
    registryPath,
    processes,
    signals,
    system: {
      list: () =>
        [...processes].map(([pid, process]) => ({
          pid,
          command: process.command,
        })),
      identity: (pid: number) => processes.get(pid) ?? null,
      signal: (pid: number, signal: NodeJS.Signals) => {
        signals.push({ pid, signal });
        processes.delete(pid);
      },
      sleep: async () => {},
    },
  };
}

function addProcess(
  setup: ReturnType<typeof fixture>,
  pid: number,
  executableName: string,
  command: string,
  location: "qa" | "user" = "qa",
): void {
  const directory = join(setup.root, location);
  mkdirSync(directory, { recursive: true });
  const executablePath = join(directory, executableName);
  writeFileSync(executablePath, "fixture\n");
  setup.processes.set(pid, {
    command: `${executablePath} ${command}`,
    executablePath,
    startToken: `${pid}:1`,
  });
}

test("a second bring-up refuses while the first rig's one Workspace remains", () => {
  const setup = fixture();
  try {
    beginOwnership(setup.qaRoot, setup.registryPath, setup.system);
    addProcess(
      setup,
      101,
      "HiveWorkspace",
      "HiveWorkspace --instance-home /tmp/qa/home",
    );
    captureOwnership(setup.registryPath, setup.system);

    expect(() =>
      beginOwnership(setup.qaRoot, setup.registryPath, setup.system),
    ).toThrow("another QA rig owns");
    expect(
      [...setup.processes.values()].filter((process) =>
        process.command.includes("HiveWorkspace"),
      ),
    ).toHaveLength(1);
    expect(setup.signals).toEqual([]);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("begin refuses an unowned QA-root process without touching the user's fleet", () => {
  const setup = fixture();
  try {
    addProcess(setup, 201, "hive", "hive daemon");
    addProcess(setup, 202, "hive", "hive daemon", "user");

    expect(() =>
      beginOwnership(setup.qaRoot, setup.registryPath, setup.system),
    ).toThrow("unowned process");
    expect(setup.processes.has(201)).toBe(true);
    expect(setup.processes.has(202)).toBe(true);
    expect(setup.signals).toEqual([]);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("one registry tears down daemon, Workspace, orchestrator, and Graphify by exact identity", async () => {
  const setup = fixture();
  try {
    beginOwnership(setup.qaRoot, setup.registryPath, setup.system);
    addProcess(setup, 301, "hive", "hive daemon");
    addProcess(setup, 302, "HiveWorkspace", "HiveWorkspace --project /repo");
    addProcess(
      setup,
      303,
      "hive",
      "hive workspace-orchestrator --instance-id qa",
    );
    addProcess(setup, 304, "graphify-mcp", "graphify-mcp --transport http");
    addProcess(setup, 305, "hive", "hive daemon", "user");
    captureOwnership(setup.registryPath, setup.system);

    expect(
      readOwnershipRegistry(setup.registryPath).processes.map(
        (process) => process.role,
      ),
    ).toEqual(["daemon", "workspace", "orchestrator", "graphify"]);

    await stopOwnedProcesses(setup.registryPath, setup.system);

    expect(setup.signals).toEqual(
      [301, 302, 303, 304].map((pid) => ({ pid, signal: "SIGTERM" })),
    );
    expect(setup.processes.has(305)).toBe(true);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("teardown refuses a reused pid and never signals it", async () => {
  const setup = fixture();
  try {
    beginOwnership(setup.qaRoot, setup.registryPath, setup.system);
    addProcess(setup, 401, "hive", "hive daemon");
    captureOwnership(setup.registryPath, setup.system);
    const original = setup.processes.get(401);
    if (original === undefined) throw new Error("fixture process missing");
    setup.processes.set(401, { ...original, startToken: "401:2" });

    await expect(
      stopOwnedProcesses(setup.registryPath, setup.system),
    ).rejects.toThrow("identity changed");
    expect(setup.signals).toEqual([]);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("the QA recipe uses the registry for every active-run teardown", () => {
  const makefile = readFileSync(
    join(import.meta.dir, "..", "..", "Makefile"),
    "utf8",
  );
  const qaStart = makefile.indexOf("\nqa:\n");
  const qaEnd = makefile.indexOf("\n# The QA runner", qaStart);
  const qaCleanStart = makefile.indexOf("\nqa-clean:\n");
  expect(qaStart).toBeGreaterThan(-1);
  expect(qaEnd).toBeGreaterThan(qaStart);
  expect(qaCleanStart).toBeGreaterThan(-1);

  const qa = makefile.slice(qaStart, qaEnd);
  const qaClean = makefile.slice(qaCleanStart);
  expect(qa).toContain('process-ownership.ts" begin');
  expect(qa).toContain(
    'process-ownership.ts" capture "$(QA_PROCESS_REGISTRY)" daemon',
  );
  expect(qa).toContain(
    'process-ownership.ts" capture "$(QA_PROCESS_REGISTRY)" workspace orchestrator',
  );
  expect(qa).toContain('process-ownership.ts" stop');
  expect(qa).not.toMatch(/\bkill\b/);
  expect(qaClean).toContain('if [ -f "$(QA_PROCESS_REGISTRY)" ]');
  expect(qaClean).toContain('process-ownership.ts" stop');
});
