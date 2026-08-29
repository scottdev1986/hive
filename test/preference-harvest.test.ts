/**
 * Preference learning tests: harvest → proposals → apply → pack floor → spawn/queen
 *
 * Proves:
 * 1. Harvest counts events (2 events → emit)
 * 2. Closed-loop: harvest → proposals → parse/apply → spawn sees it
 * 3. Real queen launch sees preferences
 * 4. Empty prefs fail-closed
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
import {
  appendProposal,
  readProposals,
  type Proposal,
} from "../src/memory-service/proposals";
import { loadProfile } from "../src/memory-service/pack-floor";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveSpawner } from "../src/daemon/spawn/spawner-impl";
import { getHiveHome } from "../src/hive-home/home";
import type { RoutingPolicy } from "../src/schemas/routing-policy";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../src/schemas/capability";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalHiveHome = process.env.HIVE_HOME;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );

  if (originalHome) process.env.HOME = originalHome;
  if (originalHiveHome) process.env.HIVE_HOME = originalHiveHome;
  else delete process.env.HIVE_HOME;
  if (originalCodexHome) process.env.CODEX_HOME = originalCodexHome;
  else delete process.env.CODEX_HOME;
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeTempHome(): Promise<string> {
  const home = await makeTempDir("hive-home-");
  process.env.HIVE_HOME = home;
  return home;
}

function applyProposalToProfile(
  proposal: Proposal,
  existingProfile: string,
): string {
  const change = proposal.proposedChange;
  const lines = change.split("\n");
  const prefLines: string[] = [];

  let inContent = false;
  for (const line of lines) {
    if (line.startsWith("- ") && !line.startsWith("**")) {
      prefLines.push(line);
      inContent = true;
    } else if (inContent && line.trim() === "") {
      break;
    }
  }

  if (prefLines.length === 0) return existingProfile;

  const category =
    lines.find((l) => l.startsWith("## "))?.replace("## ", "") ?? "Preferences";

  const profileLines = existingProfile.split("\n");
  let categoryIndex = profileLines.findIndex((l) => l === `## ${category}`);

  if (categoryIndex === -1) {
    return `${existingProfile}\n\n## ${category}\n${prefLines.join("\n")}`;
  }

  const insertIndex = categoryIndex + 1;
  profileLines.splice(insertIndex, 0, ...prefLines);
  return profileLines.join("\n");
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
  test("harvest_counts_events: 2 events with minRecurrence 2 emits signal", async () => {
    const episodic = new EpisodicStore(":memory:");

    const preference = "Always use TypeScript strict mode";

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "style" } },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "style" } },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(1);
    const signal = harvestReport.signals[0];
    if (!signal) throw new Error("Expected signal");

    expect(signal.preference).toContain("TypeScript strict mode");
    expect(signal.eventIds.length).toBe(2);
    expect(signal.rationale).toContain("Observed 2 times");

    episodic.close();
  });

  test("harvest_to_proposal: harvest → proposal append (file-backed)", async () => {
    const root = await makeTempDir("pref-harvest-");
    const episodic = new EpisodicStore(":memory:");

    await mkdir(join(root, "docs"), { recursive: true });

    const preference = "Use ESLint for linting";

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "tool" } },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "tool" } },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(1);
    const signal = harvestReport.signals[0];
    if (!signal) throw new Error("Expected signal");

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
    expect(firstProposal.proposedChange).toContain("ESLint");

    episodic.close();
  });

  test("recurrence_across_passes: eventIds accumulate across harvest passes", async () => {
    const root = await makeTempDir("pref-multi-pass-");
    const dbPath = join(root, "episodic.db");
    const store = new EpisodicStore(dbPath);

    // Pass 1: Insert event 1, harvest (should NOT emit - count=1)
    store.appendEvent({
      type: "user.preference",
      summary: "CROSS_PASS_PREF: Use strict types",
      provenance: {
        data: {
          preference: "CROSS_PASS_PREF: Use strict types",
          category: "style",
        },
      },
    });

    const harvestReport1 = await harvestPreferences({
      store,
      minRecurrence: 2,
    });
    expect(harvestReport1.signals.length).toBe(0);

    // Pass 2: Insert event 2 (same pref, SAME type and category)
    store.appendEvent({
      type: "user.preference",
      summary: "CROSS_PASS_PREF: Use strict types",
      provenance: {
        data: {
          preference: "CROSS_PASS_PREF: Use strict types",
          category: "style",
        },
      },
    });

    const harvestReport2 = await harvestPreferences({
      store,
      minRecurrence: 2,
    });
    expect(harvestReport2.signals.length).toBe(1);

    const signal = harvestReport2.signals[0];
    if (!signal) throw new Error("Expected signal");
    expect(signal.preference).toContain("CROSS_PASS_PREF");
    expect(signal.eventIds.length).toBe(2);
    expect(signal.eventIds).toEqual([1, 2]);

    // Pass 3: Same pref again, should NOT emit again (already proposed)
    store.appendEvent({
      type: "user.preference",
      summary: "CROSS_PASS_PREF: Use strict types",
      provenance: {
        data: {
          preference: "CROSS_PASS_PREF: Use strict types",
          category: "style",
        },
      },
    });

    const harvestReport3 = await harvestPreferences({
      store,
      minRecurrence: 2,
    });
    expect(harvestReport3.signals.length).toBe(0);

    store.close();
  });

  test("closed_loop_apply: harvest → proposals → apply → spawn sees it", async () => {
    const root = await makeTempDir("pref-closed-loop-");
    const home = await makeTempHome();
    const worktree = join(root, "test-agent");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });

    await copyFile(
      join(import.meta.dir, "../AGENT_STANDARDS.md"),
      join(root, "AGENT_STANDARDS.md"),
    );

    const episodic = new EpisodicStore(":memory:");

    const preference = "CLOSED_LOOP_MARKER: Use bun for testing";

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "tool" } },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: { data: { preference, category: "tool" } },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(1);
    const signal = harvestReport.signals[0];
    if (!signal) throw new Error("Expected signal");

    const proposal: Proposal = {
      id: "profile-closed-1",
      createdAt: new Date().toISOString(),
      category: "profile",
      title: `User preference: ${signal.preference.slice(0, 60)}`,
      rationale: signal.rationale,
      proposedChange: formatPreferenceProposal(signal),
      source: "consolidator",
    };

    await appendProposal(root, proposal);

    const inbox = await readProposals(root);
    expect(inbox.proposals.length).toBe(1);

    const profilePath = join(getHiveHome(), "profile.md");
    const baseProfile = "# User Profile\n";
    const updatedProfile = applyProposalToProfile(
      inbox.proposals[0]!,
      baseProfile,
    );
    await writeFile(profilePath, updatedProfile, "utf-8");

    const profileContent = await readFile(profilePath, "utf-8");
    expect(profileContent).toContain("CLOSED_LOOP_MARKER");

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
        task: "Test closed loop",
        category: "simple_coding",
      });

      expect(admitted.status).toBe("spawning");

      const promptDirectory = join(getHiveHome(), "runtime", "prompts");
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

      // Extract profile section: from Profile heading until next top-level pack section
      // Must survive nested ## headings inside profile (e.g. ## Tool Preferences)
      const profileMatch = prompt.match(
        /(?:^|\n)(?:## )?Profile(?:[^\n]*)\n([\s\S]*?)(?=\n## (?!Tool|Workflow|Code|Patterns|Style|Preferences)|\n*$)/i,
      );
      expect(profileMatch).toBeDefined();
      const profileSection = profileMatch?.[1] ?? "";
      expect(profileSection).toContain("CLOSED_LOOP_MARKER");
      expect(profileSection).toContain("Use bun for testing");
    } finally {
      db.close();
      episodic.close();
    }
  });

  test("queen_has_preferences: profile appears in buildQueenLaunchContext", async () => {
    const root = await makeTempDir("pref-queen-");
    await makeTempHome();

    const profilePath = join(getHiveHome(), "profile.md");
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

    // Extract profile section: from Profile heading until next top-level pack section
    // Must survive nested ## headings inside profile (e.g. ## Workflow Preferences)
    const profileMatch = context.match(
      /(?:^|\n)(?:## )?Profile(?:[^\n]*)\n([\s\S]*?)(?=\n## (?!Tool|Workflow|Code|Patterns|Style|Preferences)|\n*$)/i,
    );
    expect(profileMatch).toBeDefined();
    const profileSection = profileMatch?.[1] ?? "";
    expect(profileSection).toContain("QUEEN_MARKER");
    expect(profileSection).toContain("write tests before implementation");
  });

  test("empty_profile_fail_closed: empty profile returns stub", async () => {
    await makeTempHome();

    const profile = await loadProfile();

    expect(profile).toContain("Profile slot reserved but empty");
    expect(() => profile.length).not.toThrow();
    expect(profile.length).toBeGreaterThan(0);
  });

  test("recurrence_rejects_single_event", async () => {
    const episodic = new EpisodicStore(":memory:");

    episodic.appendEvent({
      type: "user.preference",
      summary: "Use Prettier",
      provenance: { data: { preference: "Use Prettier", category: "tool" } },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(0);
    episodic.close();
  });
});
