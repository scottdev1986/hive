import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSession } from "./start";

// Hive's own state goes to a throwaway HIVE_HOME here, never into the repo.
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

async function repoWithSpec(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-start-"));
  git(root, ["init"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(join(root, "SPEC.md"), "# Spec\n\nv1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init", "--no-gpg-sign"]);
  return root;
}

// The Workspace session boundary. The daemon
// bring-up itself is a subprocess concern (covered end-to-end in
// e2e-real.test.ts); here the seams prove the boundary's shape: order, the
// returned port, and the best-effort steps staying best-effort.
describe("startSession", () => {
  test("checks for updates before selecting an instance and bringing its daemon up", async () => {
    const root = await repoWithSpec();
    const steps: string[] = [];
    try {
      const session = await startSession({
        cwd: root,
        checkUpdate: async () => {
          steps.push("check");
          throw new Error("offline");
        },
        ensureDaemon: async (cwd) => {
          steps.push(`ensure:${cwd}`);
        },
        prepareInstance: () => {
          steps.push("instance");
        },
        ensurePort: async () => {
          steps.push("port");
          return 45_017;
        },
        write: (line) => steps.push(`write:${line.slice(0, 5)}`),
      });
      expect(session).toEqual({ port: 45_017, cwd: root });
      // The update check ran first and its failure stopped nothing; the daemon
      // came up after instance selection, and the returned port is the gate's.
      expect(steps).toEqual(["check", "instance", `ensure:${root}`, "port"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale-daemon refusal stops the session before any daemon starts", async () => {
    const root = await repoWithSpec();
    let started = false;
    try {
      const promise = startSession({
        cwd: root,
        checkUpdate: async () => {
          throw new Error("offline");
        },
        ensureDaemon: async () => {
          throw new Error("live agents still running");
        },
        prepareInstance: () => {},
        ensurePort: async () => {
          started = true;
          return 45_019;
        },
        write: () => {},
      });
      await expect(promise).rejects.toThrow("live agents still running");
      expect(started).toEqual(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
