import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceProfile, startSession } from "./start";
import { loadProfile } from "../adapters/profile";

// `hive start`'s single profile line (SPEC §14). Exercised directly rather than
// through the full daemon bring-up, which `runStart` owns.

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

// The session boundary shared by `hive start` and bare `hive`. The daemon
// bring-up itself is a subprocess concern (covered end-to-end in
// e2e-real.test.ts); here the seams prove the boundary's shape: order, the
// returned port, and the best-effort steps staying best-effort.
describe("startSession", () => {
  test("checks, announces the profile, then brings the daemon up — and returns the port", async () => {
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
        ensurePort: async () => {
          steps.push("port");
          return 45_017;
        },
        write: (line) => steps.push(`write:${line.slice(0, 5)}`),
      });
      expect(session).toEqual({ port: 45_017, cwd: root });
      // The update check ran first and its failure stopped nothing. The
      // profile line (a fresh repo writes one) came BEFORE the daemon: the
      // daemon bootstraps the profile too, and announcing afterwards loses
      // the first-start line to that race (the e2e suite pins this).
      expect(steps).toEqual(["check", "write:Wrote", `ensure:${root}`, "port"]);
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
        ensurePort: async () => 45_018,
        write: () => {},
      });
      expect(session.port).toEqual(45_018);
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

describe("announceProfile", () => {
  test("on an uninitialized repo, writes the profile and prints one line", async () => {
    const root = await repoWithSpec();
    const lines: string[] = [];
    try {
      await announceProfile(root, (line) => lines.push(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(".hive/profile.toml");
      expect(lines[0]).toContain("hive init");
      // The file really exists and is loadable afterwards.
      expect(await loadProfile(root)).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fresh profile proceeds in silence", async () => {
    const root = await repoWithSpec();
    const lines: string[] = [];
    try {
      await announceProfile(root, () => {}); // first call writes it
      await announceProfile(root, (line) => lines.push(line));
      expect(lines).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a drifted profile prints the refresh note but does not rewrite", async () => {
    const root = await repoWithSpec();
    const lines: string[] = [];
    try {
      await announceProfile(root, () => {});
      const before = await Bun.file(join(root, ".hive/profile.toml")).text();
      // Drift a declared input and commit.
      await writeFile(join(root, "SPEC.md"), "# Spec\n\nv2 more\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "edit", "--no-gpg-sign"]);

      await announceProfile(root, (line) => lines.push(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("hive init --refresh");
      // Stale is not a rewrite: the committed profile is left in place.
      expect(await Bun.file(join(root, ".hive/profile.toml")).text()).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
