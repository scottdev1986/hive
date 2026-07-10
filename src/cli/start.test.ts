import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceProfile } from "./start";
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
