/**
 * Preference learning tests: harvest → proposals → pack floor → spawn/queen
 *
 * Proves:
 * 1. Preferences appear in real HiveSpawner.spawn prompt (file-backed)
 * 2. Preferences appear in real buildQueenLaunchContext (file-backed)
 * 3. Harvest → proposal append path (file-backed)
 * 4. Empty prefs fail-closed (no TypeError)
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  copyFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../src/memory-service/episodic";
import {
  harvestPreferences,
  formatPreferenceProposal,
} from "../src/memory-service/preference-harvest";
import { appendProposal, readProposals } from "../src/memory-service/proposals";
import { loadProfile } from "../src/memory-service/pack-floor";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveSpawner } from "../src/daemon/spawn/spawner-impl";
import type { RoutingPolicy } from "../src/schemas/routing-policy";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../src/schemas/capability";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );

  if (originalHome) process.env.HOME = originalHome;
  if (originalCodexHome) process.env.CODEX_HOME = originalCodexHome;
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeTempHome(): Promise<string> {
  const home = await makeTempDir("hive-home-");
  process.env.HOME = home;
  await mkdir(join(home, ".hive"), { recursive: true });
  return home;
}

const AT = "2026-08-24T00:00:00.000Z";

const testCodexRecord: CapabilityRecord = {
  provider: "codex",
  accountFingerprint: "codex:pref-test",
  cliVersion: "test",
  canonicalId: "gpt-test",
  variant: null,
  launchToken: "gpt-test",
  displayName: "gpt-test",
  aliases: [],
  entitled: known(true, "codex.model/list", AT),
  hidden: known(false, "codex.model/list", AT),
  supportsEffort: unknown("surface-silent", "codex.model/list", AT),
  supportedEffortLevels: unknown("surface-silent", "codex.model/list", AT),
  defaultEffort: unknown("surface-silent", "codex.model/list", AT),
  observedAt: AT,
};

describe("Preference learning", () => {
  test("harvest_to_proposal: harvest → proposal append (file-backed)", async () => {
    const root = await makeTempDir("pref-harvest-");
    const episodic = new EpisodicStore(":memory:");

    await mkdir(join(root, "docs"), { recursive: true });

    const preference = "Always use TypeScript strict mode";

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: {
        data: {
          preference,
          category: "style",
        },
      },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: {
        data: {
          preference,
          category: "style",
        },
      },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBeGreaterThan(0);
    const signal = harvestReport.signals[0];
    if (!signal) throw new Error("Expected signal");

    expect(signal.preference).toContain("TypeScript strict mode");

    const proposal = {
      id: "profile-test-1",
      createdAt: new Date().toISOString(),
      category: "profile" as const,
      title: `User preference: ${signal.preference.slice(0, 60)}`,
      rationale: signal.rationale,
      proposedChange: formatPreferenceProposal(signal),
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(1);
    const firstProposal = inbox.proposals[0];
    if (!firstProposal) throw new Error("Expected proposal");
    expect(firstProposal.category).toBe("profile");
    expect(firstProposal.title).toContain("TypeScript strict mode");

    episodic.close();
  });

  test("real_spawn_has_preferences: profile appears in HiveSpawner.spawn prompt (file-backed)", async () => {
    const root = await makeTempDir("pref-spawn-");
    const home = await makeTempHome();
    const worktree = join(root, "test-agent");
    await mkdir(worktree, { recursive: true });

    await copyFile(
      join(import.meta.dir, "../AGENT_STANDARDS.md"),
      join(root, "AGENT_STANDARDS.md"),
    );

    const profilePath = join(home, ".hive", "profile.md");
    await writeFile(
      profilePath,
      [
        "# User Profile",
        "",
        "## Code Style",
        "- PREFERENCE_MARKER: Always use TypeScript strict mode",
        "- Prefer functional programming patterns",
      ].join("\n"),
      "utf-8",
    );

    process.env.CODEX_HOME = join(home, "codex");

    const db = new HiveDatabase(":memory:");

    const policy: RoutingPolicy = {
      schemaVersion: 3,
      revision: 1,
      updatedAt: AT,
      provisional: false,
      providers: {},
      models: [],
      global: null,
      categories: {
        simple_coding: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "codex",
              model: "gpt-test",
              effort: { mode: "provider-controlled" },
              weight: 1,
            },
          ],
        },
      },
    };

    const admission = {
      engineBuildId: "engine-test",
      visibility: {
        workspaceSessionId: "workspace-test",
        workspacePid: 123,
        workspaceStartToken: "123:1",
        openTerminalRevision: "1",
      },
    };

    const spawner = new HiveSpawner({
      db,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policy,
      isModelEnabled: async () => true,
      discoverCapabilities: async (provider) =>
        provider === "codex"
          ? {
              status: "ok",
              records: [testCodexRecord],
              effectiveDefault: {
                provider: "codex",
                model: unknown("field-absent", "codex.config/read", AT),
                effort: unknown("field-absent", "codex.config/read", AT),
              },
            }
          : { status: "unavailable", reason: "not in fixture" },
      readBilling: async () => null,
      createWorktree: async () => ({
        path: worktree,
        branch: "hive/test-pref",
      }),
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      listCodexMcpServers: async () => [],
      claudeExecutable: "claude",
      codexExecutable: "codex",
      grokExecutable: "grok",
      kimiExecutable: "kimi",
      opencodeExecutable: "opencode",
      sessiond: {
        prepareAgentCreation: async () => admission,
        admit: async () => null,
        terminalHost: {
          create: async () => {
            throw new Error("terminal creation stopped after prompt assembly");
          },
          inspect: async () => {
            throw new Error("not reached");
          },
          terminate: async () => {
            throw new Error("not reached");
          },
        },
      },
    });

    try {
      const admitted = await spawner.spawn({
        task: "Test with preferences",
        category: "simple_coding",
      });

      expect(admitted.status).toBe("spawning");

      const promptDirectory = join(home, "runtime", "prompts");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await readdir(promptDirectory).catch(() => [])).some((name) =>
            name.endsWith(".txt"),
          )
        ) {
          break;
        }
        await Bun.sleep(5);
      }

      const promptName = (await readdir(promptDirectory)).find((name) =>
        name.endsWith(".txt"),
      );
      expect(promptName).toBeDefined();
      if (promptName === undefined)
        throw new Error("launch prompt was not written");

      const prompt = await readFile(join(promptDirectory, promptName), "utf8");

      expect(prompt).toContain("PREFERENCE_MARKER");
      expect(prompt).toContain("TypeScript strict mode");
      expect(prompt).toContain("functional programming patterns");
    } finally {
      db.close();
    }
  });

  test("queen_has_preferences: profile appears in buildQueenLaunchContext (file-backed)", async () => {
    const root = await makeTempDir("pref-queen-");
    const home = await makeTempHome();

    const profilePath = join(home, ".hive", "profile.md");
    await writeFile(
      profilePath,
      [
        "# User Profile",
        "",
        "## Workflow Preferences",
        "- QUEEN_MARKER: Always write tests before implementation",
      ].join("\n"),
      "utf-8",
    );

    const { buildQueenLaunchContext } = await import("../src/cli/orchestrator");

    const context = await buildQueenLaunchContext({ repoRoot: root });

    expect(context).toContain("QUEEN_MARKER");
    expect(context).toContain("write tests before implementation");
  });

  test("empty_profile_fail_closed: empty profile returns stub (no TypeError)", async () => {
    const home = await makeTempHome();

    const profile = await loadProfile();

    expect(profile).toContain("Profile slot reserved but empty");
    expect(() => profile.length).not.toThrow();
    expect(profile.length).toBeGreaterThan(0);
  });

  test("recurrence_threshold: recurrence=1 does not emit", async () => {
    const episodic = new EpisodicStore(":memory:");

    episodic.appendEvent({
      type: "user.preference",
      summary: "Use Prettier",
      provenance: {
        data: {
          preference: "Use Prettier",
          category: "tool",
        },
      },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(0);
    episodic.close();
  });
});
