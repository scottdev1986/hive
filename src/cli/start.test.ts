import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSession } from "./start";
import { loadDerivedProfile, profilePath } from "../adapters/profile";

// The session boundary profiles the repo silently when profiling succeeds.
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
  test("checks and profiles before selecting an instance and bringing its daemon up", async () => {
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
      // The update check ran first and its failure stopped nothing. A repo that
      // has never been profiled gets profiled here — before the daemon, and
      // without a word: the profile is Hive's business, not the user's.
      expect(steps).toEqual(["check", "instance", `ensure:${root}`, "port"]);
      expect(await loadDerivedProfile(root)).not.toBeNull();
      expect(profilePath(root).startsWith(hiveHome)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a profile that cannot be evaluated still starts the session", async () => {
    // Not a git repo and no manifest: evaluateProfile has nothing to read.
    const root = await mkdtemp(join(tmpdir(), "hive-start-bare-"));
    try {
      const session = await startSession({
        cwd: root,
        checkUpdate: async () => {
          throw new Error("offline");
        },
        ensureDaemon: async () => {},
        prepareInstance: () => {},
        ensurePort: async () => 45_018,
        write: () => {},
      });
      expect(session.port).toEqual(45_018);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a profile failure is actionable without blocking the session", async () => {
    const lines: string[] = [];
    const session = await startSession({
      cwd: "/repo",
      checkUpdate: async () => {
        throw new Error("offline");
      },
      ensureProfile: async () => {
        throw new Error("profile directory is read-only");
      },
      ensureDaemon: async () => {},
      prepareInstance: () => {},
      ensurePort: async () => 45_020,
      warn: (line) => lines.push(line),
      write: () => {},
    });

    expect(session.port).toEqual(45_020);
    expect(lines).toEqual([
      "Repository profiling failed: profile directory is read-only\n" +
        "Fix: resolve the error, then run `hive init --refresh`.",
    ]);
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

describe("successful profiling stays silent", () => {
  test("a drifted repo starts silently, on a profile that has already been fixed", async () => {
    const root = await repoWithSpec();
    const lines: string[] = [];
    const start = (): Promise<unknown> =>
      startSession({
        cwd: root,
        checkUpdate: async () => {
          throw new Error("offline");
        },
        ensureDaemon: async () => {},
        prepareInstance: () => {},
        ensurePort: async () => 45_021,
        write: (line) => lines.push(line),
      });

    try {
      await start();

      // Drift the profile for real: a new doc changes the briefable allowlist.
      await writeFile(join(root, "DESIGN.md"), "# Design\n\nsee SPEC.md\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "add design doc", "--no-gpg-sign"]);

      lines.length = 0;
      await start();

      // The old behavior was to print "the profile is N commits stale... run
      // `hive init --refresh`" and then start anyway on the stale profile. It
      // now regenerates and says nothing: there was never a decision for the
      // user to make here, so there was never anything to tell them.
      expect(lines).toEqual([]);
      expect((await loadDerivedProfile(root))?.docs.briefable)
        .toContain("DESIGN.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
