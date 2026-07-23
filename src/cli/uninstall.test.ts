import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPHIFY_IGNORE_MARKER,
  runCommand,
} from "../adapters/graphify";
import { getHiveHome } from "../daemon/db";
import { projectStateDir } from "../daemon/project-state";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { MachineMutationCoordinator } from "../daemon/mutation-lease";
import { shippedSkillsFor } from "../skills/shipped";
import { runUninstallMachine, runUninstallRepo, type UninstallDeps } from "./uninstall";

let hiveHome: string;
const originalHiveHome = process.env.HIVE_HOME;

beforeAll(async () => {
  hiveHome = await mkdtemp(join(tmpdir(), "hive-home-"));
  process.env.HIVE_HOME = hiveHome;
});

afterAll(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-uninstall-"));
  git(root, ["init"]);
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init", "--no-gpg-sign"]);
  return root;
}

interface Probe {
  deps: UninstallDeps;
  lines: string[];
  stops: number[];
  leaseEvents: string[];
}

function probe(confirm: boolean | null, overrides: Partial<UninstallDeps> = {}): Probe {
  const lines: string[] = [];
  const stops: number[] = [];
  const leaseEvents: string[] = [];
  const deps: UninstallDeps = {
    run: runCommand,
    confirm: async () => confirm,
    log: (line) => lines.push(line),
    stopCurrentInstance: async () => {
      stops.push(1);
    },
    currentInstanceOwnsProject: async () => true,
    liveTeams: async () => [],
    stopInstances: async () => {},
    acquireLease: async (purpose) => {
      leaseEvents.push(`acquire:${purpose}`);
      return { release: () => leaseEvents.push(`release:${purpose}`) };
    },
    ...overrides,
  };
  return { deps, lines, stops, leaseEvents };
}

describe("hive uninstall --repo", () => {
  test("without a terminal and without --yes it refuses and removes nothing", async () => {
    const root = await gitRepo();
    try {
      await mkdir(join(root, "graphify-out"), { recursive: true });
      const { deps, lines, stops } = probe(null);
      expect(await runUninstallRepo(root, {}, deps)).toBe(1);
      expect(stops).toEqual([]);
      expect(existsSync(join(root, "graphify-out"))).toBe(true);
      expect(lines.join("\n")).toContain("--yes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a declined confirmation removes nothing", async () => {
    const root = await gitRepo();
    try {
      await mkdir(join(root, "graphify-out"), { recursive: true });
      const { deps } = probe(false);
      expect(await runUninstallRepo(root, {}, deps)).toBe(1);
      expect(existsSync(join(root, "graphify-out"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stop failure is reported and nothing is removed", async () => {
    const root = await gitRepo();
    try {
      await mkdir(join(root, "graphify-out"), { recursive: true });
      const { deps, lines } = probe(true, {
        stopCurrentInstance: async () => {
          throw new Error("tmux refused the stop");
        },
      });
      expect(await runUninstallRepo(root, {}, deps)).toBe(1);
      expect(existsSync(join(root, "graphify-out"))).toBe(true);
      expect(lines.join("\n")).toContain("tmux refused the stop");
      expect(lines.join("\n")).toContain("rerun `hive uninstall --repo`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a daemon serving another repo is never stopped", async () => {
    const root = await gitRepo();
    try {
      await mkdir(join(root, "graphify-out"), { recursive: true });
      const { deps, stops } = probe(true, {
        currentInstanceOwnsProject: async () => false,
      });
      expect(await runUninstallRepo(root, {}, deps)).toBe(0);
      expect(stops).toEqual([]);
      expect(existsSync(join(root, "graphify-out"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("confirmed: removes everything Hive put in, keeps everything the human owns", async () => {
    const root = await gitRepo();
    try {
      // Hive's full repo footprint, laid down the way Hive lays it down.
      const shipped = shippedSkillsFor("claude");
      expect(shipped.length).toBeGreaterThan(1);
      const [ours, theirs] = [shipped[0]!, shipped[1]!];
      await mkdir(join(root, ".claude", "skills", ours.name), { recursive: true });
      await writeFile(join(root, ".claude", "skills", ours.name, "SKILL.md"), ours.content);
      await mkdir(join(root, ".claude", "skills", theirs.name), { recursive: true });
      await writeFile(
        join(root, ".claude", "skills", theirs.name, "SKILL.md"),
        `${theirs.content}\n# my edits\n`,
      );
      git(root, ["worktree", "add", join(root, ".hive", "worktrees", "wt"), "-b", "hive/wt-task"]);
      git(root, [
        "update-ref",
        `refs/hive-owner/${hiveInstanceSuffix()}/hive/wt-task`,
        "hive/wt-task",
      ]);
      await mkdir(join(root, ".hive", "skills", "mine"), { recursive: true });
      await writeFile(join(root, ".hive", "skills", "mine", "SKILL.md"), "# mine\n");
      await mkdir(join(root, "graphify-out"), { recursive: true });
      await writeFile(join(root, "graphify-out", "graph.json"), "{}");
      await writeFile(
        join(root, ".graphifyignore"),
        `${GRAPHIFY_IGNORE_MARKER}\nnode_modules/\n`,
      );
      await writeFile(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            hive: {
              url: "http://127.0.0.1:4483/mcp",
              headersHelper: "hive credential --agent orchestrator",
            },
            keepers: { url: "https://example.com/mcp" },
          },
        }),
      );
      await writeFile(join(hiveHome, "daemon.port"), "4483\n");
      await mkdir(projectStateDir(root), { recursive: true });
      await writeFile(join(projectStateDir(root), "initialized"), "stamp\n");

      const { deps, lines, stops, leaseEvents } = probe(true);
      expect(await runUninstallRepo(root, {}, deps)).toBe(0);
      expect(stops).toEqual([1]);
      expect(leaseEvents).toEqual([]);

      // Hive's footprint is gone…
      expect(existsSync(join(root, ".claude", "skills", ours.name))).toBe(false);
      expect(existsSync(join(root, ".hive", "worktrees"))).toBe(false);
      expect(existsSync(join(root, "graphify-out"))).toBe(false);
      expect(existsSync(projectStateDir(root))).toBe(false);
      const branches = Bun.spawnSync(["git", "-C", root, "branch", "--list", "hive/*"]);
      expect(branches.stdout.toString().trim()).toBe("");
      const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8")
        .catch(() => "");
      expect(exclude).not.toContain("graphify-out/");
      expect(exclude).not.toContain(".graphifyignore");
      expect(existsSync(join(root, ".graphifyignore"))).toBe(false);
      const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcp.mcpServers.hive).toBeUndefined();

      // …and the human's is not.
      expect(mcp.mcpServers.keepers).toBeDefined();
      expect(existsSync(join(root, ".hive", "skills", "mine"))).toBe(true);
      expect(
        await readFile(join(root, ".claude", "skills", theirs.name, "SKILL.md"), "utf8"),
      ).toContain("# my edits");
      expect(lines.join("\n")).toContain("differs from what Hive ships");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes only this instance's same-repo worktree and branch", async () => {
    const root = await gitRepo();
    try {
      const ownPath = join(root, ".hive", "worktrees", "maya");
      const siblingPath = join(root, ".hive", "worktrees", "david");
      git(root, ["worktree", "add", ownPath, "-b", "hive/maya-own"]);
      git(root, ["worktree", "add", siblingPath, "-b", "hive/david-sibling"]);
      git(root, [
        "update-ref",
        `refs/hive-owner/${hiveInstanceSuffix()}/hive/maya-own`,
        "hive/maya-own",
      ]);
      git(root, [
        "update-ref",
        "refs/hive-owner/sibling-instance/hive/david-sibling",
        "hive/david-sibling",
      ]);
      const { deps, lines } = probe(true);
      expect(await runUninstallRepo(root, {}, deps)).toBe(0);
      expect(existsSync(ownPath)).toBe(false);
      expect(existsSync(siblingPath)).toBe(true);
      expect(Bun.spawnSync([
        "git", "-C", root, "show-ref", "--verify", "refs/heads/hive/maya-own",
      ]).exitCode).not.toBe(0);
      expect(Bun.spawnSync([
        "git", "-C", root, "show-ref", "--verify", "refs/heads/hive/david-sibling",
      ]).exitCode).toBe(0);
      expect(lines.join("\n")).toContain("Left sibling-owned worktree");
      expect(lines.join("\n")).toContain("Left sibling-owned branch hive/david-sibling");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports an owned branch that Git refuses to delete", async () => {
    const root = await gitRepo();
    try {
      const worktree = join(root, ".hive", "worktrees", "maya");
      git(root, ["worktree", "add", worktree, "-b", "hive/maya-owned"]);
      git(root, [
        "update-ref",
        `refs/hive-owner/${hiveInstanceSuffix()}/hive/maya-owned`,
        "hive/maya-owned",
      ]);
      const { deps, lines } = probe(true, {
        run: async (argv, options) =>
          argv[0] === "git" && argv[1] === "branch" && argv[2] === "-D"
            ? { exitCode: 1, stdout: "", stderr: "branch is locked", timedOut: false }
            : runCommand(argv, options),
      });
      expect(await runUninstallRepo(root, {}, deps)).toBe(1);
      expect(Bun.spawnSync([
        "git", "-C", root, "show-ref", "--verify", "refs/heads/hive/maya-owned",
      ]).exitCode).toBe(0);
      expect(lines.join("\n")).toContain("branch is locked");
      expect(lines.join("\n")).not.toContain("Hive is removed from this repo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("hive uninstall", () => {
  test("holds the machine mutation lease from the final team check through removal", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-machine-lease-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    const order: string[] = [];
    try {
      await writeFile(join(home, "hive.db"), "");
      const { deps } = probe(true, {
        confirm: async () => {
          order.push("confirm");
          return true;
        },
        acquireLease: async (purpose) => {
          order.push(`acquire:${purpose}`);
          return {
            release: () => {
              order.push(`release:${existsSync(home) ? "present" : "removed"}`);
            },
          };
        },
        liveTeams: async () => {
          order.push("teams");
          return [];
        },
        stopInstances: async () => {
          order.push("daemons");
        },
        stopCurrentInstance: async () => {
          order.push("sessions");
        },
      });

      expect(await runUninstallMachine({}, deps)).toBe(0);
      expect(order).toEqual([
        "teams",
        "confirm",
        "acquire:machine-uninstall",
        "teams",
        "daemons",
        "sessions",
        "release:removed",
      ]);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("refuses machine removal while a sibling has a positively visible live team", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-sibling-live-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const { deps, lines, stops } = probe(true, {
        liveTeams: async () => [{
          instance: {
            name: "review",
            home: join(home, "instances", "review"),
            instanceId: "instance-review",
            port: 4318,
            pid: 1234,
            running: true,
          },
          liveAgents: ["maya"],
        }],
      });
      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(stops).toEqual([]);
      expect(lines.join("\n")).toContain("review (maya)");
      expect(existsSync(home)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("preserves machine state when a real agent spawn operation wins the race", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-spawn-operation-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    const mutationPath = join(`${home}-runtime`, "mutation.db");
    const operationCoordinator = new MachineMutationCoordinator({
      path: mutationPath,
      instanceId: "review",
      instanceHome: home,
    });
    const uninstallCoordinator = new MachineMutationCoordinator({
      path: mutationPath,
      instanceId: "default",
      instanceHome: home,
      instanceLiveness: async () => "live",
    });
    const operation = await operationCoordinator.beginOperation("spawn");
    try {
      await writeFile(join(home, "hive.db"), "");
      const { deps, lines, stops } = probe(true, {
        acquireLease: (purpose) => uninstallCoordinator.acquireLease(purpose),
      });

      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(stops).toEqual([]);
      expect(existsSync(home)).toBe(true);
      expect(lines.join("\n")).toContain(
        "spawn in Hive instance review is in progress",
      );
    } finally {
      operation.release();
      uninstallCoordinator.close();
      operationCoordinator.close();
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
      await rm(`${home}-runtime`, { recursive: true, force: true });
    }
  });

  test("confirmed: removes ~/.hive; a source build's binary is not Hive's to touch", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-gone-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      await writeFile(join(home, "hive.db"), "");
      const { deps, lines } = probe(true);
      expect(await runUninstallMachine({}, deps)).toBe(0);
      expect(existsSync(home)).toBe(false);
      expect(lines.join("\n")).toContain(getHiveHome());
      expect(lines.join("\n")).toContain("source");
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a real lease releases cleanly after Hive home is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-home-real-lease-"));
    const home = join(root, "home");
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    const coordinator = new MachineMutationCoordinator({
      path: join(root, "runtime", "mutation.db"),
      instanceId: "default",
      instanceHome: home,
    });
    try {
      await mkdir(home);
      await writeFile(join(home, "hive.db"), "");
      const { deps } = probe(true, {
        acquireLease: (purpose) => coordinator.acquireLease(purpose),
      });

      expect(await runUninstallMachine({}, deps)).toBe(0);
      expect(existsSync(home)).toBe(false);
    } finally {
      coordinator.close();
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rechecks every team after confirmation before stopping anything", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-spawn-race-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      let checks = 0;
      const { deps, lines, stops, leaseEvents } = probe(true, {
        liveTeams: async () => {
          checks += 1;
          return checks === 1 ? [] : [{
            instance: {
              name: "review",
              home: join(home, "instances", "review"),
              instanceId: "instance-review",
              port: 4318,
              pid: 1234,
              running: true,
            },
            liveAgents: ["new-agent"],
          }];
        },
      });
      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(checks).toBe(2);
      expect(stops).toEqual([]);
      expect(leaseEvents).toEqual([
        "acquire:machine-uninstall",
        "release:machine-uninstall",
      ]);
      expect(lines.join("\n")).toContain("review (new-agent)");
      expect(existsSync(home)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("proves every daemon stopped before cleaning this instance's sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-stop-order-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const order: string[] = [];
      const { deps } = probe(true, {
        stopInstances: async () => {
          order.push("daemons");
        },
        stopCurrentInstance: async () => {
          order.push("sessions");
        },
      });
      expect(await runUninstallMachine({}, deps)).toBe(0);
      expect(order).toEqual(["daemons", "sessions"]);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("retains machine state when a daemon will not stop", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-daemon-stuck-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      await writeFile(join(home, "hive.db"), "");
      const { deps, lines, stops } = probe(true, {
        stopInstances: async () => {
          throw new Error("review instance is still alive");
        },
      });
      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(stops).toEqual([]);
      expect(existsSync(home)).toBe(true);
      expect(lines.join("\n")).toContain("review instance is still alive");
      expect(lines.join("\n")).toContain("rerun `hive uninstall`");
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a session stop failure is reported and machine state is retained", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-stop-failed-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      await writeFile(join(home, "hive.db"), "");
      const { deps, lines } = probe(true, {
        stopCurrentInstance: async () => {
          throw new Error("tmux is unavailable");
        },
      });
      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(existsSync(home)).toBe(true);
      expect(lines.join("\n")).toContain("tmux is unavailable");
      expect(lines.join("\n")).toContain("rerun `hive uninstall`");
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a declined confirmation removes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-home-kept-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const { deps, stops } = probe(false);
      expect(await runUninstallMachine({}, deps)).toBe(1);
      expect(stops).toEqual([]);
      expect(existsSync(home)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});
