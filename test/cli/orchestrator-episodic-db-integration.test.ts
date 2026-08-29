import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQueenLaunchContext,
  launchOrchestrator,
} from "../../src/cli/orchestrator";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { launchPromptPath } from "../../src/daemon/spawn/launch-prompt";
import {
  hiveInstanceSuffix,
  orchestratorSessionKey,
} from "../../src/hive-home/home";
import { rootSessionIdForLaunchRequest } from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import { readFile } from "node:fs/promises";

let hiveHome: string;
let previousHiveHome: string | undefined;

beforeEach(async () => {
  previousHiveHome = process.env.HIVE_HOME;
  hiveHome = await mkdtemp(join(tmpdir(), "hive-episodic-test-"));
  process.env.HIVE_HOME = hiveHome;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

async function initGitRepo(root: string): Promise<void> {
  const result = Bun.spawnSync(["git", "init", "--quiet", root]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to initialize test repository: ${result.stderr.toString()}`,
    );
  }
}

describe("launchOrchestrator opens on-disk episodic.db", () => {
  test("launchOrchestrator opens real on-disk episodic.db and feeds mistakes into queen wake pack", async () => {
    const project = await mkdtemp(join(tmpdir(), "hive-episodic-ondisk-"));
    const executable = join(project, "codex");
    let capturedLaunchContext = "";

    try {
      // Initialize as a git repo so forProjectRoot can resolve the project identity
      await initGitRepo(project);

      // Open the episodic store using the real production path
      const episodic = EpisodicStore.forProjectRoot(project);

      // Seed real pitfall/mistake events on disk
      episodic.appendEvent({
        type: "mistake",
        summary: "Failed to handle null pointer in worker thread",
        provenance: { source: "test-seeded" },
      });

      episodic.appendEvent({
        type: "pitfall",
        summary: "Mutex deadlock when spawning concurrent tasks",
        provenance: { source: "test-seeded" },
      });

      episodic.appendEvent({
        type: "other",
        summary: "This is not a mistake and should not appear",
        provenance: { source: "test-seeded" },
      });

      episodic.close();

      // Create a fake codex executable
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);

      // Run the real launchOrchestrator path
      const exit = await launchOrchestrator("codex", 4317, project, "", {
        resolveCodexExecutable: () => ({
          path: executable,
          version: "fixture",
        }),
        listCodexMcpServers: async () => [],
        provisionCodexToken: async () => {
          const tokenPath = join(project, "token");
          await writeFile(tokenPath, "queen-token\n");
          return tokenPath;
        },
        sessiondControl: {
          start: async (launch) => {
            // Capture the launch context that was written
            capturedLaunchContext = await readFile(
              launchPromptPath(orchestratorSessionKey()),
              "utf8",
            );
            return {
              requestId: launch.requestId,
              locator: {
                schemaVersion: 1,
                instanceId: hiveInstanceSuffix(),
                subject: { kind: "root" },
                sessionId: rootSessionIdForLaunchRequest(launch.requestId),
                generation: 1,
                hostKind: "sessiond",
                engineBuildId: "fixture",
              },
              state: "exited",
              exitCode: 0,
              diagnostic: null,
            };
          },
          waitForTerminal: async () => ({ kind: "missing" }),
        },
      });

      expect(exit).toBe(0);

      // Assert the mistake text is in the delivered queen pack
      expect(capturedLaunchContext).toContain(
        "Failed to handle null pointer in worker thread",
      );
      expect(capturedLaunchContext).toContain(
        "Mutex deadlock when spawning concurrent tasks",
      );
      expect(capturedLaunchContext).not.toContain(
        "This is not a mistake and should not appear",
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("launchOrchestrator fails closed when episodic store cannot be opened", async () => {
    const project = await mkdtemp(join(tmpdir(), "hive-episodic-fail-"));
    const executable = join(project, "codex");

    try {
      // Do NOT initialize as a git repo - this will cause forProjectRoot to fail
      // when it tries to resolve the project identity and open the store

      // Create a fake codex executable
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);

      // Expect launchOrchestrator to throw when it cannot open the store
      await expect(
        launchOrchestrator("codex", 4317, project, "", {
          resolveCodexExecutable: () => ({
            path: executable,
            version: "fixture",
          }),
          listCodexMcpServers: async () => [],
          provisionCodexToken: async () => {
            const tokenPath = join(project, "token");
            await writeFile(tokenPath, "queen-token\n");
            return tokenPath;
          },
          sessiondControl: {
            start: async () => {
              throw new Error("Should not reach session start");
            },
            waitForTerminal: async () => ({ kind: "missing" }),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("buildQueenLaunchContext with on-disk store produces pack with mistakes", async () => {
    const project = await mkdtemp(join(tmpdir(), "hive-context-ondisk-"));

    try {
      // Initialize as a git repo
      await initGitRepo(project);

      // Open the episodic store using the real production path
      const episodic = EpisodicStore.forProjectRoot(project);

      // Seed mistakes
      episodic.appendEvent({
        type: "mistake",
        summary: "Race condition in file descriptor cleanup",
        provenance: {},
      });

      episodic.appendEvent({
        type: "pitfall",
        summary: "Buffer overflow in string concatenation",
        provenance: {},
      });

      // Pass the open store to buildQueenLaunchContext
      const context = await buildQueenLaunchContext({
        repoRoot: project,
        episodic,
      });

      episodic.close();

      // Verify mistakes appear in the context
      expect(context).toContain("Race condition in file descriptor cleanup");
      expect(context).toContain("Buffer overflow in string concatenation");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
