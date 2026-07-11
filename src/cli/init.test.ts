import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultInitDeps,
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
