/**
 * P1 Item #8: Preference learning tests
 *
 * Proves:
 * 1. Stored user preferences appear in spawn wake pack (file-backed)
 * 2. Stored user preferences appear in queen launch context (file-backed)
 * 3. Harvest → proposal append path works (file-backed fixture)
 * 4. Pack-off / empty prefs fail-closed (no TypeError on .length)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../src/memory-service/episodic";
import {
  harvestPreferences,
  formatPreferenceProposal,
} from "../src/memory-service/preference-harvest";
import { appendProposal, readProposals } from "../src/memory-service/proposals";
import {
  loadProfile,
  loadConstitution,
} from "../src/memory-service/pack-floor";
import { loadAndValidateWakePack } from "../src/daemon/spawn/pack-assembly";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { getHiveHome } from "../src/hive-home/home";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );

  if (originalHome) {
    process.env.HOME = originalHome;
  }
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

describe("P1 Item #8: Preference learning", () => {
  test("preference_harvest_to_proposal: harvest → proposal append (file-backed)", async () => {
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
    expect(signal.category).toBe("style");

    const proposal = {
      id: "profile-20260824-1",
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

  test("preference_in_spawn_pack: stored profile appears in spawn wake pack (file-backed)", async () => {
    const root = await makeTempDir("pref-spawn-");
    const home = await makeTempHome();

    const profilePath = join(home, ".hive", "profile.md");
    await writeFile(
      profilePath,
      [
        "# User Profile",
        "",
        "## Code Style",
        "- Always use TypeScript strict mode",
        "- Prefer functional programming patterns",
        "",
        "## Tool Preferences",
        "- Use bun for package management",
      ].join("\n"),
      "utf-8",
    );

    const db = new HiveDatabase(":memory:");
    const episodic = new EpisodicStore(":memory:");

    try {
      const wakePack = await loadAndValidateWakePack({
        db,
        episodic,
        repoRoot: root,
        handoffId: undefined,
        agentName: "test-agent",
        task: "Test task with preferences",
      });

      expect(wakePack.profile).toContain("TypeScript strict mode");
      expect(wakePack.profile).toContain("functional programming patterns");
      expect(wakePack.profile).toContain("bun for package management");
      expect(wakePack.profile).not.toContain("Profile slot reserved but empty");
    } finally {
      db.close();
      episodic.close();
    }
  });

  test("preference_in_queen_context: stored profile appears in queen launch (file-backed)", async () => {
    const root = await makeTempDir("pref-queen-");
    const home = await makeTempHome();

    const profilePath = join(home, ".hive", "profile.md");
    await writeFile(
      profilePath,
      [
        "# User Profile",
        "",
        "## Workflow Preferences",
        "- Always write tests before implementation",
        "- Prefer small, focused commits",
      ].join("\n"),
      "utf-8",
    );

    const { buildQueenLaunchContext } = await import("../src/cli/orchestrator");

    const context = await buildQueenLaunchContext({ repoRoot: root });

    expect(context).toContain("write tests before implementation");
    expect(context).toContain("small, focused commits");
    expect(context).not.toContain("Profile slot reserved but empty");
  });

  test("empty_profile_fail_closed: empty profile returns explicit stub (no TypeError)", async () => {
    const home = await makeTempHome();

    const profile = await loadProfile();

    expect(profile).toContain("Profile slot reserved but empty");
    expect(profile).toContain("~/.hive/profile.md");

    expect(() => profile.length).not.toThrow();
    expect(profile.length).toBeGreaterThan(0);
  });

  test("preference_recurrence_threshold: recurrence=1 does not emit signal", async () => {
    const episodic = new EpisodicStore(":memory:");

    episodic.appendEvent({
      type: "user.preference",
      summary: "Use Prettier for formatting",
      provenance: {
        data: {
          preference: "Use Prettier for formatting",
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

  test("preference_recurrence_gte2: recurrence≥2 emits signal once", async () => {
    const episodic = new EpisodicStore(":memory:");

    const preference = "Prefer async/await over promises";

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: {
        data: {
          preference,
          category: "pattern",
        },
      },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: {
        data: {
          preference,
          category: "pattern",
        },
      },
    });

    const firstHarvest = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(firstHarvest.signals.length).toBe(1);

    episodic.appendEvent({
      type: "user.preference",
      summary: preference,
      provenance: {
        data: {
          preference,
          category: "pattern",
        },
      },
    });

    const secondHarvest = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(secondHarvest.signals.length).toBe(0);

    episodic.close();
  });

  test("preference_categories: categorizes preferences correctly", async () => {
    const episodic = new EpisodicStore(":memory:");

    episodic.appendEvent({
      type: "user.preference",
      summary: "Use tabs for indentation",
      provenance: {
        data: {
          preference: "Use tabs for indentation",
          category: "style",
        },
      },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: "Use tabs for indentation",
      provenance: {
        data: {
          preference: "Use tabs for indentation",
          category: "style",
        },
      },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: "Prefer ripgrep over grep",
      provenance: {
        data: {
          preference: "Prefer ripgrep over grep",
          category: "tool",
        },
      },
    });

    episodic.appendEvent({
      type: "user.preference",
      summary: "Prefer ripgrep over grep",
      provenance: {
        data: {
          preference: "Prefer ripgrep over grep",
          category: "tool",
        },
      },
    });

    const harvestReport = await harvestPreferences({
      store: episodic,
      minRecurrence: 2,
    });

    expect(harvestReport.signals.length).toBe(2);

    const styleSignal = harvestReport.signals.find(
      (s) => s.category === "style",
    );
    const toolSignal = harvestReport.signals.find((s) => s.category === "tool");

    expect(styleSignal).toBeDefined();
    expect(toolSignal).toBeDefined();

    if (styleSignal) {
      expect(styleSignal.preference).toContain("tabs");
    }

    if (toolSignal) {
      expect(toolSignal.preference).toContain("ripgrep");
    }

    episodic.close();
  });

  test("pack_floor_constitution_always_present", async () => {
    const constitution = loadConstitution();

    expect(constitution).toContain("Hive Constitution");
    expect(constitution).toContain("Core Principles");
    expect(constitution).toContain("Learn from verified mistakes");
    expect(constitution.length).toBeGreaterThan(0);
  });
});
