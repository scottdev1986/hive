import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultInitDeps,
  initStampPath,
  isRepoInitialized,
  readSeedFactsFile,
  runInit,
  runInitProfile,
  scaffoldAgentsMd,
  seedInitFacts,
} from "./init";
import {
  discoverMemoryFacts,
  parseMemoryFile,
} from "../adapters/memory";
import { bootstrapProfile } from "../adapters/profile";
import { shippedSkillsFor } from "../skills/shipped";

// `hive init` profiles the repo like any other start, and the profile lands in
// Hive's own home — a throwaway one here, never the developer's.
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

/** Init's real dependencies, minus the one that would talk to a daemon. */
const testDeps = (): typeof defaultInitDeps => ({
  ...defaultInitDeps,
  reindexMemory: async () => {},
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

async function tsRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-init-"));
  git(root, ["init"]);
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: { test: "bun test", typecheck: "tsc --noEmit", dev: "bun run src/cli.ts" },
  }));
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(join(root, "tsconfig.json"), "{}");
  await writeFile(join(root, "SPEC.md"), "# Spec\n\nRead SPEC.md.\n");
  await writeFile(join(root, "src/cli.ts"), "console.log(1)\n").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/cli.ts"), "console.log(1)\n");
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init", "--no-gpg-sign"]);
  return root;
}

describe("seedInitFacts — the memory seam (SPEC §14 ↔ §5)", () => {
  test("writes source:init + verified, scope repo, and upserts idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-init-seed-"));
    try {
      const ids = await seedInitFacts(
        root,
        [{ title: "The e2e suite needs Docker running first", body: "Otherwise it hangs at setup." }],
        "2026-07-10",
      );
      expect(ids).toEqual(["the-e2e-suite-needs-docker-running-first"]);

      const facts = await discoverMemoryFacts(root, "repo");
      expect(facts).toHaveLength(1);
      // Re-read the raw file: provenance is persisted per david's contract.
      const raw = await readFile(facts[0]!.path, "utf8");
      const parsed = parseMemoryFile(facts[0]!.id, "repo", facts[0]!.path, raw);
      expect(parsed.source).toBe("init");
      expect(parsed.verified).toBe("2026-07-10");
      expect(parsed.scope).toBe("repo");

      // A --refresh re-run with the same title upserts in place (id is stable),
      // bumping verified rather than accumulating a duplicate.
      await seedInitFacts(
        root,
        [{ title: "The e2e suite needs Docker running first", body: "Updated note." }],
        "2026-08-01",
      );
      const after = await discoverMemoryFacts(root, "repo");
      expect(after).toHaveLength(1);
      const reRaw = await readFile(after[0]!.path, "utf8");
      expect(parseMemoryFile(after[0]!.id, "repo", after[0]!.path, reRaw).verified)
        .toBe("2026-08-01");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scaffoldAgentsMd", () => {
  test("derives a starter from the profile, not a hive-specific template", async () => {
    const root = await tsRepo();
    try {
      const profile = await bootstrapProfile(root);
      const md = scaffoldAgentsMd(profile);
      expect(md).toContain("Test: `bun test`");
      expect(md).toContain("Typecheck: `bun run typecheck`");
      expect(md).toContain("Language: typescript");
      expect(md).toContain("`SPEC.md`");
      // A starting point, explicitly framed as such (every vendor's /init does).
      expect(md).toContain("Review and refine");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runInit", () => {
  test("writes the profile, scaffolds AGENTS.md on opt-in, and seeds facts", async () => {
    const root = await tsRepo();
    try {
      const result = await runInit(root, {
        scaffoldAgents: true,
        facts: [{ title: "Flaky login test", body: "Races on the token clock." }],
        today: "2026-07-10",
      });
      expect(result.profileWritten).toBe(true);
      expect(result.agentsScaffolded).toBe(true);
      expect(result.factsSeeded).toEqual(["flaky-login-test"]);
      // AGENTS.md really written, from the profile.
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("bun test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never overwrites an existing AGENTS.md (Codex 32KiB silent-truncation hazard)", async () => {
    const root = await tsRepo();
    try {
      await writeFile(join(root, "AGENTS.md"), "# human instructions\nkeep me\n");
      const result = await runInit(root, { scaffoldAgents: true });
      expect(result.agentsScaffolded).toBe(false);
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
        "# human instructions\nkeep me\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a correct profile is left alone, and nothing is asked of anyone", async () => {
    const root = await tsRepo();
    try {
      await runInit(root, {}); // profiles it once
      const result = await runInit(root, {});
      expect(result.profileWritten).toBe(false);
      // The old init ended with "pass --refresh to re-scan". There is nothing to
      // re-scan and no flag to reach for: init never names a next command.
      expect(result.messages.some((m) => m.includes("--refresh"))).toBe(false);
      expect(result.messages.every((m) => !m.includes("Run `"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a drifted profile is rebuilt without --refresh, because --refresh is not a chore", async () => {
    const root = await tsRepo();
    try {
      await runInit(root, {});
      await writeFile(join(root, "DESIGN.md"), "# Design\n\na new doc\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "drift", "--no-gpg-sign"]);

      const result = await runInitProfile(root, {});
      expect(result.profileWritten).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--refresh forces a re-scan, for a detection you want to watch rerun", async () => {
    const root = await tsRepo();
    try {
      await runInit(root, {});
      const result = await runInit(root, { refresh: true });
      expect(result.profileWritten).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("seeded facts are indexed on the way out, not left as a chore", async () => {
    const root = await tsRepo();
    let reindexed = 0;
    try {
      const result = await runInit(
        root,
        { facts: [{ title: "A gotcha", body: "x" }], today: "2026-07-11" },
        { ...testDeps(), reindexMemory: async () => { reindexed += 1; } },
      );
      expect(result.factsSeeded).toEqual(["a-gotcha"]);
      expect(reindexed).toBe(1);
      // The old init printed "Run `hive memory reindex` ... to index the seeded
      // facts", which is Hive asking to be finished by hand.
      expect(result.messages.every((m) => !m.includes("hive memory reindex"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runInit — installing the shipped skills", () => {
  /** A machine with exactly these CLIs on it. Nothing shells out: the test says
   * what the machine has. */
  const machineWith = (...clis: string[]): typeof defaultInitDeps => ({
    ...testDeps(),
    hasCli: (command) => clis.includes(command),
  });

  const skillFile = (root: string, native: string, name: string): string =>
    join(root, native, "skills", name, "SKILL.md");

  test("installs each vendor's skills where that vendor actually reads them", async () => {
    const root = await tsRepo();
    try {
      const result = await runInit(root, {}, machineWith("claude", "codex"));

      // Vendor-verified paths: Claude Code reads .claude/skills, Codex .agents/skills.
      expect(await readFile(skillFile(root, ".claude", "hive-claude"), "utf8"))
        .toEqual(shippedSkillsFor("claude")[0]!.content);
      expect(await readFile(skillFile(root, ".agents", "hive-codex"), "utf8"))
        .toEqual(shippedSkillsFor("codex")[0]!.content);
      // The shared skill goes to both; the vendor-specific ones do not cross over.
      expect(await Bun.file(skillFile(root, ".claude", "karpathy-guidelines")).exists())
        .toBe(true);
      expect(await Bun.file(skillFile(root, ".agents", "karpathy-guidelines")).exists())
        .toBe(true);
      expect(await Bun.file(skillFile(root, ".claude", "hive-codex")).exists())
        .toBe(false);
      expect(await Bun.file(skillFile(root, ".agents", "hive-claude")).exists())
        .toBe(false);

      expect(result.skills.map((report) => report.tool)).toEqual(["claude", "codex"]);
      expect(result.skills.every((report) => report.createdDirectory)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a vendor whose CLI is absent gets no directory at all", async () => {
    const root = await tsRepo();
    try {
      const result = await runInit(root, {}, machineWith("claude"));

      // Someone with no Codex does not get a .agents/ directory in their repo.
      expect(await Bun.file(join(root, ".agents")).exists()).toBe(false);
      expect(await Bun.file(skillFile(root, ".claude", "hive-claude")).exists())
        .toBe(true);
      expect(result.skills.map((report) => report.tool)).toEqual(["claude"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with neither CLI installed, init touches no vendor directory and says so", async () => {
    const root = await tsRepo();
    try {
      const result = await runInit(root, {}, machineWith());

      expect(await Bun.file(join(root, ".claude")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".agents")).exists()).toBe(false);
      expect(result.skills).toEqual([]);
      expect(result.messages.some((m) => m.includes("No Claude Code or Codex CLI")))
        .toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges into a .claude the user already has, touching nothing of theirs", async () => {
    const root = await tsRepo();
    try {
      // A repo that already uses Claude Code, with settings and a skill of their own.
      await mkdir(join(root, ".claude", "skills", "their-skill"), { recursive: true });
      await writeFile(join(root, ".claude", "settings.json"), '{"theirs":true}\n');
      await writeFile(
        join(root, ".claude", "skills", "their-skill", "SKILL.md"),
        "# their skill\n",
      );

      const result = await runInit(root, {}, machineWith("claude"));

      expect(await readFile(join(root, ".claude", "settings.json"), "utf8"))
        .toEqual('{"theirs":true}\n');
      expect(await readFile(skillFile(root, ".claude", "their-skill"), "utf8"))
        .toEqual("# their skill\n");
      expect(await Bun.file(skillFile(root, ".claude", "hive-claude")).exists())
        .toBe(true);
      expect(result.skills[0]!.createdDirectory).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an edited skill survives init, is reported, and yields only to --force", async () => {
    const root = await tsRepo();
    try {
      await runInit(root, {}, machineWith("claude"));
      const edited = skillFile(root, ".claude", "karpathy-guidelines");
      await writeFile(edited, "# my own rules\n");

      const second = await runInit(root, {}, machineWith("claude"));
      expect(second.skills[0]!.drifted).toEqual(["karpathy-guidelines"]);
      expect(await readFile(edited, "utf8")).toEqual("# my own rules\n");
      expect(second.messages.some((m) => m.includes("--force"))).toBe(true);

      const forced = await runInit(root, { force: true }, machineWith("claude"));
      expect(forced.skills[0]!.installed).toContain("karpathy-guidelines");
      expect(await readFile(edited, "utf8")).not.toEqual("# my own rules\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("seeds no memory of its own: only facts derived from the user's repo", async () => {
    const root = await tsRepo();
    try {
      // Bare `hive init` supplies no facts, so it seeds none. Hive's own
      // development memories live in Hive's repo and are never a source here.
      const result = await runInitProfile(root, {});
      expect(result.factsSeeded).toEqual([]);
      expect(await discoverMemoryFacts(root, "repo")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("readSeedFactsFile", () => {
  test("parses a JSON array of facts and rejects malformed entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-init-facts-"));
    try {
      const path = join(root, "facts.json");
      await writeFile(path, JSON.stringify([
        { title: "A", body: "b", tags: ["x"], id: "a" },
      ]));
      expect(await readSeedFactsFile(path)).toEqual([
        { title: "A", body: "b", tags: ["x"], id: "a" },
      ]);

      await writeFile(path, JSON.stringify([{ title: "no body" }]));
      await expect(readSeedFactsFile(path)).rejects.toThrow("string title and body");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the graphify decision in init", () => {
  interface Probe {
    deps: typeof defaultInitDeps;
    enabled: string[];
    declined: boolean[];
  }

  function probe(overrides: Partial<typeof defaultInitDeps> = {}): Probe {
    const enabled: string[] = [];
    const declined: boolean[] = [];
    const deps: typeof defaultInitDeps = {
      ...testDeps(),
      graphifyAvailable: () => true,
      graphifyDecisionRecorded: () => false,
      confirm: async () => null,
      enableGraphify: async (root) => (enabled.push(root), 0),
      writeGraphifyState: async (_root, state) => {
        declined.push(!state.enabled);
      },
      ...overrides,
    };
    return { deps, enabled, declined };
  }

  const lastLine = async (
    root: string,
    options: Parameters<typeof runInit>[1],
    deps: typeof defaultInitDeps,
  ): Promise<string> => {
    const result = await runInit(root, options, deps);
    return result.messages[result.messages.length - 1] as string;
  };

  test("--graphify enables without asking, even without a TTY", async () => {
    const root = await tsRepo();
    try {
      const { deps, enabled } = probe({
        confirm: async () => {
          throw new Error("flags never prompt");
        },
      });
      const line = await lastLine(root, { graphify: true }, deps);
      expect(enabled).toEqual([root]);
      expect(line).toContain("Graphify: enabled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--no-graphify declines without asking and persists the answer", async () => {
    const root = await tsRepo();
    try {
      const { deps, enabled, declined } = probe({
        confirm: async () => {
          throw new Error("flags never prompt");
        },
      });
      const line = await lastLine(root, { graphify: false }, deps);
      expect(enabled).toEqual([]);
      expect(declined).toEqual([true]);
      expect(line).toContain("Graphify: declined");
      expect(line).toContain("hive graphify enable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no flag, no terminal: declines for the run, installs nothing, persists nothing", async () => {
    const root = await tsRepo();
    try {
      const { deps, enabled, declined } = probe({ confirm: async () => null });
      const line = await lastLine(root, {}, deps);
      expect(enabled).toEqual([]);
      expect(declined).toEqual([]);
      expect(line).toContain("non-interactive");
      expect(line).toContain("hive graphify enable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a TTY yes enables; a TTY no persists the decline", async () => {
    const root = await tsRepo();
    try {
      const yes = probe({ confirm: async () => true });
      expect(await lastLine(root, {}, yes.deps)).toContain("Graphify: enabled");
      expect(yes.enabled).toEqual([root]);

      const no = probe({ confirm: async () => false });
      expect(await lastLine(root, {}, no.deps)).toContain("Graphify: declined");
      expect(no.declined).toEqual([true]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recorded decision is respected: no re-asking", async () => {
    const root = await tsRepo();
    try {
      const { deps, enabled } = probe({
        graphifyDecisionRecorded: () => true,
        confirm: async () => {
          throw new Error("a recorded decision never re-prompts");
        },
      });
      const line = await lastLine(root, {}, deps);
      expect(enabled).toEqual([]);
      expect(line).toContain("declined earlier");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("already enabled: reported, never re-asked", async () => {
    const root = await tsRepo();
    try {
      const { deps } = probe({
        readGraphifyState: async () => ({ enabled: true, pin: "0.0.0" }),
        confirm: async () => {
          throw new Error("enabled repos are never re-prompted");
        },
      });
      expect(await lastLine(root, {}, deps)).toContain("Graphify: enabled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no bundle for this platform: one honest line, no question", async () => {
    const root = await tsRepo();
    try {
      const { deps, enabled } = probe({
        graphifyAvailable: () => false,
        confirm: async () => {
          throw new Error("nothing installable is never offered");
        },
      });
      const line = await lastLine(root, {}, deps);
      expect(enabled).toEqual([]);
      expect(line).toContain("no bundle is published for this platform");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an enable failure is reported and init still completes", async () => {
    const root = await tsRepo();
    try {
      const { deps } = probe({ enableGraphify: async () => 1 });
      const result = await runInit(root, { graphify: true }, deps);
      const line = result.messages[result.messages.length - 1] as string;
      expect(line).toContain("could not be enabled");
      expect(result.profileWritten).toBe(true);
      expect(isRepoInitialized(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("init leaves the stamp bare `hive` checks", async () => {
    const root = await tsRepo();
    try {
      expect(isRepoInitialized(root)).toBe(false);
      const { deps } = probe();
      await runInit(root, {}, deps);
      expect(isRepoInitialized(root)).toBe(true);
      expect(await readFile(initStampPath(root), "utf8")).toContain("hive init");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
