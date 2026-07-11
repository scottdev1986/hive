import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildGitTopology, git, tempRoot } from "../harness/fixtures";
import { runScenarios } from "../harness/scenarios";
import {
  foldIdentityKey,
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  probeGit,
  sanitizedGitEnv,
  UnauthenticatedLedgerAccess,
} from "../../../src/daemon/project-identity-core/index";
import type { VolumeBehavior } from "../../../src/daemon/project-identity-core/index";

/**
 * The motion scenarios are the real specification. Running them here means `bun test`
 * fails if any invariant regresses, and prints which one.
 *
 * A scenario that cannot run (no swiftc, no hdiutil) reports `skipped`. Skips are
 * surfaced, never silently treated as passes.
 */
describe("identity under motion", () => {
  const results = runScenarios();

  for (const result of results) {
    test(`${result.id}: ${result.title}`, () => {
      if (result.status === "skipped") {
        console.warn(`SKIPPED ${result.id}: ${result.detail}`);
        return;
      }
      expect(result.status === "fail" ? result.detail : "pass").toBe("pass");
    });
  }

  test("at least the decisive scenarios actually ran", () => {
    const decisive = ["move-then-impostor", "delete-recreate", "rename", "bookmark-path-first"];
    const ran = results.filter((r) => decisive.includes(r.id) && r.status === "pass");
    expect(ran.map((r) => r.id).sort()).toEqual([...decisive].sort());
  });
});

describe("git discovery", () => {
  test("--git-common-dir is relative without --path-format=absolute, and probeGit compensates", () => {
    const root = tempRoot();
    try {
      const t = buildGitTopology(root);

      // The trap: Git answers relative to the invocation cwd unless told otherwise.
      const relative = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: t.nestedPath,
        encoding: "utf8",
      }).trim();
      expect(relative.startsWith("/")).toBe(false);

      const probe = probeGit(t.nestedPath);
      expect(probe.gitCommonDir).toBe(join(t.main, ".git"));
      expect(probe.topLevel).toBe(t.main);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a linked worktree shares git-common-dir but not git-dir", () => {
    const root = tempRoot();
    try {
      const t = buildGitTopology(root);
      const main = probeGit(t.main);
      const linked = probeGit(t.linkedWorktree);
      expect(linked.gitCommonDir).toBe(main.gitCommonDir);
      expect(linked.gitDir).not.toBe(main.gitDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a submodule reports its superproject and its own common dir", () => {
    const root = tempRoot();
    try {
      const t = buildGitTopology(root);
      const sub = probeGit(t.submodule);
      const main = probeGit(t.main);
      expect(sub.superprojectRoot).toBe(t.main);
      expect(sub.gitCommonDir).not.toBe(main.gitCommonDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare repository reports bareness and no top level", () => {
    const root = tempRoot();
    try {
      const bare = join(root, "bare.git");
      mkdirSync(bare);
      git(bare, "init", "-q", "--bare");
      const probe = probeGit(bare);
      expect(probe.isBare).toBe(true);
      expect(probe.topLevel).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sanitizedGitEnv strips every discovery-redirecting variable", () => {
    const env = sanitizedGitEnv({
      GIT_DIR: "/hostile",
      GIT_WORK_TREE: "/hostile",
      GIT_COMMON_DIR: "/hostile",
      GIT_CEILING_DIRECTORIES: "/hostile",
      PATH: "/usr/bin",
    });
    expect(env["GIT_DIR"]).toBeUndefined();
    expect(env["GIT_WORK_TREE"]).toBeUndefined();
    expect(env["GIT_COMMON_DIR"]).toBeUndefined();
    expect(env["GIT_CEILING_DIRECTORIES"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });
});

describe("identity key folding", () => {
  const volume = (over: Partial<VolumeBehavior>): VolumeBehavior => ({
    dev: 1,
    caseSensitive: true,
    caseProvenance: "probed",
    normalizationSensitive: true,
    normalizationProvenance: "probed",
    isLocal: true,
    ...over,
  });

  test("a case-sensitive volume keeps Foo and foo apart", () => {
    const v = volume({ caseSensitive: true });
    expect(foldIdentityKey("/x/Foo", v)).not.toBe(foldIdentityKey("/x/foo", v));
  });

  test("a case-insensitive volume folds Foo and foo together", () => {
    const v = volume({ caseSensitive: false });
    expect(foldIdentityKey("/x/Foo", v)).toBe(foldIdentityKey("/x/foo", v));
  });

  // Spelled with explicit escapes: an editor or formatter would otherwise silently
  // normalize these two literals into one string and the tests below would prove nothing.
  const NFC = "/x/café";
  const NFD = "/x/café";

  test("the fixtures really are two spellings of one name", () => {
    expect(NFC).not.toBe(NFD);
    expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"));
  });

  test("a normalization-insensitive volume folds NFC and NFD together", () => {
    const v = volume({ normalizationSensitive: false });
    expect(foldIdentityKey(NFC, v)).toBe(foldIdentityKey(NFD, v));
  });

  test("a normalization-sensitive volume keeps NFC and NFD apart", () => {
    const v = volume({ normalizationSensitive: true });
    expect(foldIdentityKey(NFC, v)).not.toBe(foldIdentityKey(NFD, v));
  });
});

describe("managed-worktree ledger", () => {
  test("a forged capability cannot read the ledger", () => {
    const ledger = new InMemoryManagedWorktreeLedger();
    expect(() => ledger.lookup("/x", { subject: "forged" } as unknown as LedgerCapability)).toThrow(
      UnauthenticatedLedgerAccess,
    );
  });

  test("a file inside the repository grants nothing", () => {
    const root = tempRoot();
    try {
      const project = join(root, "project");
      mkdirSync(join(project, ".hive"), { recursive: true });
      writeFileSync(join(project, ".hive", "owner.json"), JSON.stringify({ owningHiveUuid: "stolen" }));

      const ledger = new InMemoryManagedWorktreeLedger();
      expect(ledger.lookup(project, LedgerCapability.issue("supervisor"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
