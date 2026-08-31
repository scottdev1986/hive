import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { learnedVerificationInstruction } from "../../src/daemon/spawn/agent-prompt";
import {
  type AgentStandards,
  loadAgentStandards,
  promoteVerificationToStandards,
  scaffoldAgentStandardsMd,
  withPromotedVerification,
} from "../../src/daemon/spawn/agent-standards";
import {
  buildAgentPrompt,
  HiveSpawner,
} from "../../src/daemon/spawn/spawner-impl";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";
import { errorMessage } from "../../src/shared/error-message";

const REPO_ROOT = join(import.meta.dir, "../..");
const KARPATY_SKILL_PATHS = [
  join(REPO_ROOT, "skills/agent/karpathy-guidelines/SKILL.md"),
  join(REPO_ROOT, ".hive/skills/agent/karpathy-guidelines/SKILL.md"),
] as const;
/** The standards exactly as they read at the commit that moved them out of the
 * spawner, paired with prompts captured from the spawner before that commit.
 * Frozen on purpose: editing the live AGENT_STANDARDS.md is the whole point of
 * the change and must never break the assembly test. */
const BASELINE = join(import.meta.dir, "fixtures/agent-standards-baseline");

const worktree = {
  path: "/repo/.hive/worktrees/nina",
  branch: "hive/nina-golden",
};

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const rootHolding = async (standards: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hive-standards-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "AGENT_STANDARDS.md"), standards);
  return root;
};

/** Returns the refusal message, and fails rather than returning if the load
 * succeeded — a negative test that cannot tell "refused" from "did not run" is
 * not a test. */
const refusalFrom = async (root: string): Promise<string> => {
  try {
    await loadAgentStandards(root);
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error(`loadAgentStandards(${root}) resolved; it had to refuse`);
};

const sectionRange = (source: string, heading: string): [number, number] => {
  const marker = `## ${heading}\n`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n## ", start + marker.length);
  return [start, next === -1 ? source.length : next + 1];
};

const withoutSection = (source: string, heading: string): string => {
  const [start, end] = sectionRange(source, heading);
  return source.slice(0, start) + source.slice(end);
};

const emptySection = (source: string, heading: string): string => {
  const [start, end] = sectionRange(source, heading);
  return `${source.slice(0, start)}## ${heading}\n\n${source.slice(end)}`;
};

const live = await readFile(join(REPO_ROOT, "AGENT_STANDARDS.md"), "utf8");

/** One section's text by heading.
 *
 * Throws rather than returning undefined when the heading is absent: a `.not.toContain`
 * against a missing section would pass for the wrong reason, and every negative
 * assertion below depends on this fixture actually holding the section it names. */
const textOf = (standards: AgentStandards, heading: string): string => {
  const section = standards.sections.find((entry) => entry.heading === heading);
  if (section === undefined) {
    throw new Error(
      `fixture precondition failed: the standards hold no "${heading}" section`,
    );
  }
  return section.text;
};

/**
 * Every section's body delivery must match presence of its `##` heading as a
 * line — not as a substring. A delivered "## Code review evidence" contains
 * the text "## Code review"; line membership is the only check that does not
 * false-red the undelivered short heading.
 *
 * Shared by the live-taxonomy probe and the prefix-collision seed so a
 * "simplification" back to toContain cannot stay green: the live file has no
 * prefix pair, but the seeded call does, and both use this loop.
 */
const assertHeadingLinesMatchDelivery = (
  standards: AgentStandards,
  prompt: string,
): void => {
  const headingLines = new Set(
    prompt.split("\n").filter((line) => line.startsWith("## ")),
  );
  for (const section of standards.sections) {
    const headingLine = `## ${section.heading}`;
    if (prompt.includes(section.text)) {
      expect(headingLines.has(headingLine)).toBe(true);
    } else {
      expect(headingLines.has(headingLine)).toBe(false);
    }
  }
};

describe("promoting a measured verification command", () => {
  test("a generic scaffold gains a Verification section for writers", () => {
    const next = withPromotedVerification(
      scaffoldAgentStandardsMd(),
      "npm test",
    );
    expect(next).not.toBeNull();
    expect(next).toContain("Verification: writers");
    expect(next).toContain("## Verification");
    expect(next).toContain("`npm test`");
  });

  test("this repo's custom file is left alone", () => {
    expect(withPromotedVerification(live, "bun test")).toBeNull();
  });

  test("a custom file that already declares Verification is updated", () => {
    const custom = [
      "# Custom",
      "",
      "```standards",
      "Hive protocol: everyone",
      "Verification: writers",
      "```",
      "",
      "## Hive protocol",
      "",
      "Do the work.",
      "",
      "## Verification",
      "",
      "Old command.",
      "",
    ].join("\n");
    const next = withPromotedVerification(custom, "make test");
    expect(next).toContain("`make test`");
    expect(next).not.toContain("Old command.");
  });

  test("promoteVerificationToStandards writes the generic file when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-promote-standards-"));
    temporaryRoots.push(root);
    expect(await promoteVerificationToStandards(root, "npm test")).toBe(
      "promoted",
    );
    const written = await readFile(join(root, "AGENT_STANDARDS.md"), "utf8");
    expect(written).toContain("Generic Hive product standards");
    expect(written).toContain("`npm test`");
    expect(await promoteVerificationToStandards(root, "npm test")).toBe(
      "unchanged",
    );
  });
});

describe("agent standards come from the repo, not the binary", () => {
  // Positive control. Every refusal test below is worthless until this proves
  // the loader can read a real file and see text in all six sections.
  test("the committed file yields every section with text in it", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    expect(standards.sections.length).toBeGreaterThan(0);
    for (const { heading, text } of standards.sections) {
      expect(`${heading}: ${text.length > 0}`).toBe(`${heading}: true`);
    }
    expect(textOf(standards, "Coding guidelines")).toContain(
      "Coding guidelines",
    );
    expect(textOf(standards, "Hive protocol")).toContain("Hive protocol");
    expect(textOf(standards, "Code review")).toContain("Code review rules");
  });

  test("the prompt carries the file's text verbatim", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      { tool: "claude", category: "code_review" },
    );
    for (const section of [
      textOf(standards, "Coding guidelines"),
      textOf(standards, "Hive protocol"),
      textOf(standards, "Search hygiene"),
      textOf(standards, "Writer agents"),
      textOf(standards, "Code review"),
    ]) {
      expect(prompt).toContain(section);
    }
  });

  test("editing the file changes the next prompt, with no rebuild", async () => {
    const edited = live.replace(
      "1. Think before coding.",
      "1. Think before coding, and mind the SCOTT-EDITED-MARKER.",
    );
    expect(edited).not.toBe(live);
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(await rootHolding(edited)),
      { tool: "claude" },
    );
    expect(prompt).toContain("SCOTT-EDITED-MARKER");
  });
});

describe("a spawn without standards refuses", () => {
  test("a missing file loads the generic product scaffold", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-standards-none-"));
    temporaryRoots.push(root);
    const standards = await loadAgentStandards(root);
    expect(standards.sections.map((section) => section.heading)).toEqual([
      "Hive protocol",
      "Writer agents",
      "Read-only agents",
    ]);
    expect(
      standards.sections.some((section) => section.text.includes("bun run")),
    ).toBe(false);
  });

  test("an empty file refuses instead of spawning a silent agent", async () => {
    const message = await refusalFrom(await rootHolding(""));
    expect(message).toContain("Cannot spawn");
    // An empty file cannot be told it is missing "Coding guidelines": with the
    // taxonomy in the file, nothing says that section should exist. What it can
    // be told is that it declared no sections at all, which is the same refusal
    // for the same reason — no agent would receive any standards.
    expect(message).toContain("declares no sections");
    expect(message).toContain("```standards");
  });

  // One defect per fixture. A file that is missing two things proves only that
  // the first guard fires, and leaves the second guard untested.
  test("one deleted section refuses and names that section", async () => {
    const message = await refusalFrom(
      await rootHolding(withoutSection(live, "Search hygiene")),
    );
    expect(message).toContain("Search hygiene");
    expect(message).not.toContain("Coding guidelines");
  });

  test("one emptied section refuses and names that section", async () => {
    const message = await refusalFrom(
      await rootHolding(emptySection(live, "Hive protocol")),
    );
    expect(message).toContain("Hive protocol");
    expect(message).not.toContain("Coding guidelines");
  });

  test("a section no agent is given refuses rather than being ignored", async () => {
    const message = await refusalFrom(
      await rootHolding(`${live}\n## House style\n\nUse tabs.\n`),
    );
    expect(message).toContain("House style");
  });

  test("a section written twice refuses rather than picking one", async () => {
    const message = await refusalFrom(
      await rootHolding(`${live}\n## Search hygiene\n\nSecond opinion.\n`),
    );
    expect(message).toContain("twice");
    expect(message).toContain("Search hygiene");
  });
});

describe("which sections an agent gets", () => {
  const build = (options: Parameters<typeof buildAgentPrompt>[5]) =>
    loadAgentStandards(REPO_ROOT).then((standards) =>
      buildAgentPrompt("nina", "Fix the parser.", worktree, "", standards, {
        ...options,
      }),
    );

  test("code review rules reach only a code-review agent", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    expect(await build({ category: "code_review" })).toContain(
      textOf(standards, "Code review"),
    );
    for (const category of ["simple_coding", "light_research"] as const) {
      expect(await build({ category })).not.toContain(
        textOf(standards, "Code review"),
      );
    }
    expect(await build({})).not.toContain(textOf(standards, "Code review"));
  });

  test("a harvested verification command reaches the spawn prompt", async () => {
    const learned = { command: "npm test", status: "unverified" };
    const prompt = await build({ learnedVerification: learned });
    expect(prompt).toContain(learnedVerificationInstruction(learned));
    expect(prompt).toContain("npm test");
    expect(await build({})).not.toContain("## Learned verification");
  });

  test("a reader gets the read-only clause and a writer the landing clause", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const reader = await build({ readOnly: true });
    expect(reader).toContain(textOf(standards, "Read-only agents"));
    expect(reader).not.toContain(textOf(standards, "Writer agents"));
    const writer = await build({ readOnly: false });
    expect(writer).toContain(textOf(standards, "Writer agents"));
    expect(writer).not.toContain(textOf(standards, "Read-only agents"));
  });

  test("everyone gets the guidelines, the protocol, and search hygiene", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    for (const category of [
      "simple_coding",
      "light_research",
      "code_review",
      "summarization",
    ] as const) {
      const prompt = await build({ category });
      expect(prompt).toContain(textOf(standards, "Coding guidelines"));
      expect(prompt).toContain(textOf(standards, "Hive protocol"));
      expect(prompt).toContain(textOf(standards, "Search hygiene"));
    }
  });

  // Vacuity probe for section-name citability. Body-only delivery left
  // sections like "Writer agents" present but unnameable; goldens would
  // recapture that silence and stay green. This asserts the heading itself
  // ships, for every delivered section on every audience path, so a
  // regression that drops headings fails for that reason — not because a
  // fixture drifted.
  //
  // Compare heading LINES, not substrings. The live REPO_ROOT taxonomy has no
  // prefix-sharing pair, so a second call against a seeded collision
  // taxonomy is what makes a toContain regression fail rather than stay green.
  test("every delivered section ships under its ## heading", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const roles = [
      { readOnly: false, category: "complex_coding" as const },
      { readOnly: true, category: "light_research" as const },
      { readOnly: false, category: "code_review" as const },
    ];
    for (const role of roles) {
      assertHeadingLinesMatchDelivery(standards, await build(role));
    }

    // Enforced collision (enzo finding): undelivered "## Code review" is a
    // strict prefix of delivered "## Code review evidence". Under substring
    // not.toContain this call goes red; under line membership it passes.
    // Without it, reverting the helper to toContain stays fully green.
    const evidence =
      "Cite the section that names the rule, not a paraphrase of it.";
    const collisionSource = `${live
      .replace(
        "```standards\n",
        "```standards\nCode review evidence: everyone\n",
      )
      .trimEnd()}\n\n## Code review evidence\n\n${evidence}\n`;
    const collision = await loadAgentStandards(
      await rootHolding(collisionSource),
    );
    const writer = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      collision,
      { readOnly: false, category: "simple_coding" },
    );
    assertHeadingLinesMatchDelivery(collision, writer);
  });
});

// Missing AGENT_STANDARDS.md is no longer a spawn refusal: the generic
// product scaffold loads so a stranger's repo can start workers. This drives
// the real spawner and measures that worktree creation is reached.
test("a spawn over a repo with no standards file uses the generic scaffold", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-standards-spawn-"));
  const home = await mkdtemp(join(tmpdir(), "hive-standards-spawn-home-"));
  temporaryRoots.push(root, home);
  const previousHome = process.env.HIVE_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HIVE_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  const db = new HiveDatabase(":memory:");
  const policy: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
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
  let worktreesCreated = 0;
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    port: 4319,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: async () => {
      worktreesCreated += 1;
      return { path: join(root, "nina"), branch: "hive/nina-standards" };
    },
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => ({ killed: [], survivors: [] }),
    listCodexMcpServers: async () => [],
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    writeTerminalLaunchSpec: async () => {
      throw new Error("terminal creation stopped after prompt assembly");
    },
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-test",
        visibility: {
          workspaceSessionId: "workspace-test",
          workspacePid: 123,
          workspaceStartToken: "123:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async () => {
          throw new Error("terminal creation must not be reached");
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
    const record = await spawner.spawn({
      task: "Fix the parser",
      category: "simple_coding",
    });
    expect(record.taskDescription).toBe("Fix the parser");
    expect(worktreesCreated).toBe(1);
  } finally {
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

// Assembly pin: baseline standards plus the current preamble must match the
// captured prompts. Recapture the goldens when the preamble contract changes
// (CONTINUOUS_EXECUTION now requires hive_mail_poll and settlement before
// continuing), not when live AGENT_STANDARDS.md does.
describe("the move changed the source of the text and nothing else", () => {
  const golden = async (file: string): Promise<string> =>
    readFile(join(BASELINE, file), "utf8");

  test("a full writer prompt is byte-identical", async () => {
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(BASELINE),
      { tool: "claude", category: "simple_coding" },
    );
    expect(prompt).toBe(await golden("writer-full.txt"));
  });

  test("a concise read-only prompt is byte-identical", async () => {
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(BASELINE),
      { tool: "codex", readOnly: true, category: "light_research" },
    );
    expect(prompt).toBe(await golden("readonly-concise.txt"));
  });

  test("a code-review prompt is byte-identical", async () => {
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(BASELINE),
      { tool: "claude", category: "code_review" },
    );
    expect(prompt).toBe(await golden("code-review.txt"));
  });
});

// The artifact store only helps if agents know to use it. The store itself
// landed earlier; this pin is the adoption gap — without it, agents keep
// pasting full analyses into mail whose settled bodies are unrecoverable.
describe("artifact delivery convention", () => {
  const CONVENTION_MARKERS = [
    "hive_artifact_put",
    "artifactId",
    "Full deliverables go into the artifact store",
  ] as const;
  // The preamble now names artifactId too (work-lane status). The mutation
  // must prove the *standards* sentences dropped, not that the word vanished.
  const STANDARDS_ONLY_MARKERS = [
    "hive_artifact_put",
    "Full deliverables go into the artifact store",
    "never the full findings prose in mail",
  ] as const;

  test("Hive protocol names the store-vs-mail split", async () => {
    const protocol = textOf(
      await loadAgentStandards(REPO_ROOT),
      "Hive protocol",
    );
    for (const marker of CONVENTION_MARKERS) {
      expect(protocol).toContain(marker);
    }
  });

  test("writer and code-review report text keep mail to summary plus artifactId", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const writer = textOf(standards, "Writer agents");
    expect(writer).toContain("artifactId");
    expect(writer).toContain("artifact store");
    const review = textOf(standards, "Code review");
    expect(review).toContain("hive_artifact_put");
    expect(review).toContain("never the full findings prose in mail");
  });

  test("the convention reaches the spawn prompt, mutation-proven", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      { tool: "claude", category: "code_review" },
    );
    for (const marker of CONVENTION_MARKERS) {
      expect(prompt).toContain(marker);
    }
    for (const marker of STANDARDS_ONLY_MARKERS) {
      expect(prompt).toContain(marker);
    }

    // Mutation control: excise only the convention sentences (not whole
    // sections — Writer agents packs the landing gates on the same line) and
    // prove the next prompt drops the markers. A green pass is otherwise a
    // constant-true assertion.
    const stripped = live
      .replace(/\n5\. Full deliverables go into the artifact store[^\n]*/, "")
      .replace(/ When you report completion or findings by mail[^.]*\./, "")
      .replace(
        /5\. Store the full review body with `hive_artifact_put` first, then report with one durable hive_mail_publish message to queen: verdict \(APPROVE \/ REQUEST_CHANGES \/ NEEDS_DISCUSSION\), reviewed SHA, test evidence, the `artifactId`, and a short summary of blocking and non-blocking findings as path:line — never the full findings prose in mail\./,
        "5. Report with one durable hive_mail_publish message to queen: verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), reviewed SHA, test evidence, then blocking and non-blocking findings as path:line, each naming a concrete failure.",
      );
    expect(stripped).not.toBe(live);
    for (const marker of STANDARDS_ONLY_MARKERS) {
      expect(stripped).not.toContain(marker);
    }
    // Positive control: the rest of each section still loads so a loader
    // refusal cannot masquerade as a clean drop of the convention.
    expect(stripped).toContain("Hive protocol (non-negotiable)");
    expect(stripped).toContain("Complete writer work must be committed");
    expect(stripped).toContain("Code review rules");

    const mutated = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(await rootHolding(stripped)),
      { tool: "claude", category: "code_review" },
    );
    for (const marker of STANDARDS_ONLY_MARKERS) {
      expect(mutated).not.toContain(marker);
    }
  });
});

describe("team role split reaches the spawn prompt", () => {
  test("status is work-lane; control is escalations; landing does not wait for GO", async () => {
    const prompt = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(REPO_ROOT),
      { tool: "claude", category: "simple_coding" },
    );
    expect(prompt).toContain("not a ticket desk");
    expect(prompt).toContain("Do not wait for GO or a verify window");
    expect(prompt).toContain("on the work lane");
    expect(prompt).toContain(
      "Use the control lane to queen only for a design fork",
    );
    expect(prompt).not.toContain(
      'important findings to queen with hive_mail_publish on the "control" lane',
    );
  });
});

// Two rules Scott decided on. They are prose in an editable file, so nothing
// but a test stops a later edit from quietly dropping them.
describe("rule 3 licenses fixing what you find in your path", () => {
  test("redundancy met on the way gets consolidated, and says why", async () => {
    const codingGuidelines = textOf(
      await loadAgentStandards(REPO_ROOT),
      "Coding guidelines",
    );
    expect(codingGuidelines).toContain("hide bugs");
    expect(codingGuidelines).toContain("gets consolidated");
  });

  test("a discovered bug gets fixed rather than only reported", async () => {
    const codingGuidelines = textOf(
      await loadAgentStandards(REPO_ROOT),
      "Coding guidelines",
    );
    expect(codingGuidelines).toContain(
      "A bug you discover gets fixed, not merely reported.",
    );
  });

  test("both stop at a boundary that keeps the diff reviewable", async () => {
    const codingGuidelines = textOf(
      await loadAgentStandards(REPO_ROOT),
      "Coding guidelines",
    );
    expect(codingGuidelines).toContain("larger than the task");
    expect(codingGuidelines).toContain("another agent's files");
    expect(codingGuidelines).toContain(
      "changes behaviour outside your task, report it",
    );
  });
});

const assertRule3IsRetired = async (
  skillPaths: readonly string[] = KARPATY_SKILL_PATHS,
): Promise<void> => {
  const copies = await Promise.all(
    skillPaths.map((path) => readFile(path, "utf8")),
  );
  for (const copy of copies) {
    expect(copy).not.toContain("aren't broken");
    expect(copy).not.toContain("trace directly");
  }
  expect(copies[0]).toBe(copies[1]);
};

describe("the shipped karpathy guidelines follow the live rule 3", () => {
  test("both copies retire the contradicting rule and remain byte-identical", async () => {
    await assertRule3IsRetired();
  });

  test("the assertion rejects an old-rule fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-old-rule-"));
    temporaryRoots.push(root);
    const oldRule = [
      "- Don't refactor things that aren't broken.",
      "The test: Every changed line should trace directly to the user's request.",
    ].join("\n");
    const paths = [join(root, "first.md"), join(root, "second.md")];
    await Promise.all(paths.map((path) => writeFile(path, oldRule)));
    await expect(assertRule3IsRetired(paths)).rejects.toThrow("aren't broken");
  });

  test("the assertion rejects a missing skill file", async () => {
    await expect(
      assertRule3IsRetired([join(tmpdir(), "hive-missing-rule-3.md")]),
    ).rejects.toThrow();
  });
});

// F-01. Every heading invented below appears in no TypeScript file anywhere in
// this repo. If the daemon still held a closed list of section names, not one
// of these fixtures could load — which is what makes them a test of the
// taxonomy rather than a test of the parser.
describe("a project declares its own standards categories", () => {
  const RELEASE_RULE = "Every release note names the commit it shipped from.";
  const WINDOW_RULE =
    "Deployments land Tuesday through Thursday, never on a Friday.";
  const PAIRING_RULE =
    "A reviewer who wrote any line under review says so first.";

  /** A standards file plus one section the project invented, declared with the
   * audience it asks for. Takes the source it extends so that seeding several
   * categories is the same operation applied repeatedly. */
  const declaring = (
    source: string,
    heading: string,
    audience: string,
    text: string,
  ): string =>
    `${source
      .replace("```standards\n", `\`\`\`standards\n${heading}: ${audience}\n`)
      .trimEnd()}\n\n## ${heading}\n\n${text}\n`;

  const withCategory = (
    heading: string,
    audience: string,
    text: string,
  ): string => declaring(live, heading, audience, text);

  const promptFrom = async (
    source: string,
    options: Parameters<typeof buildAgentPrompt>[5],
  ): Promise<string> =>
    buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      await loadAgentStandards(await rootHolding(source)),
      options,
    );

  test("a category that exists in no TypeScript file reaches an agent", async () => {
    const prompt = await promptFrom(
      withCategory("Release notes policy", "everyone", RELEASE_RULE),
      { tool: "claude" },
    );
    expect(prompt).toContain(RELEASE_RULE);
  });

  // Vacuity probe (a), both directions. The file and its declaration block must
  // agree, and disagreeing either way names the section rather than shipping an
  // agent that is quietly missing a rule.
  test("a declared section with no text refuses and names it", async () => {
    const message = await refusalFrom(
      await rootHolding(
        withoutSection(
          withCategory("Release notes policy", "everyone", RELEASE_RULE),
          "Release notes policy",
        ),
      ),
    );
    expect(message).toContain("Release notes policy");
    // One defect per fixture: naming a second section would mean an earlier
    // guard fired and this one was never reached.
    expect(message).not.toContain("Coding guidelines");
  });

  test("a section nothing declared refuses and names it", async () => {
    const undeclared = withCategory(
      "Release notes policy",
      "everyone",
      RELEASE_RULE,
    ).replace("Release notes policy: everyone\n", "");
    const message = await refusalFrom(await rootHolding(undeclared));
    expect(message).toContain("Release notes policy");
  });

  // Vacuity probe (b), the half a routing test usually skips: broadcasting to
  // everyone satisfies every positive assertion, so the negative side is the
  // only thing that can detect it. Each pair asserts the same text on the same
  // fixture, so a section that failed to load cannot pass the negative half.
  test("a writers section reaches a writer and not a reader", async () => {
    const source = withCategory("Deployment windows", "writers", WINDOW_RULE);
    expect(await promptFrom(source, { readOnly: false })).toContain(
      WINDOW_RULE,
    );
    expect(await promptFrom(source, { readOnly: true })).not.toContain(
      WINDOW_RULE,
    );
  });

  test("a category section reaches that category and no other", async () => {
    const source = withCategory(
      "Pairing rules",
      "category code_review",
      PAIRING_RULE,
    );
    expect(await promptFrom(source, { category: "code_review" })).toContain(
      PAIRING_RULE,
    );
    expect(
      await promptFrom(source, { category: "simple_coding" }),
    ).not.toContain(PAIRING_RULE);
    expect(await promptFrom(source, {})).not.toContain(PAIRING_RULE);
  });

  // The categories this project actually seeded. They exist only in
  // AGENT_STANDARDS.md, so this is the same claim as the fixtures above made
  // against the file the fleet really spawns from.
  test("this project's own added categories reach the agents they name", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const seeded = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      {
        readOnly: false,
      },
    );
    expect(seeded).toContain(textOf(standards, "Documentation conventions"));
    expect(seeded).toContain(textOf(standards, "Skill bindings"));
    expect(seeded).toContain(textOf(standards, "QA and environment flags"));
    const reader = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      {
        readOnly: true,
      },
    );
    expect(reader).toContain(textOf(standards, "Documentation conventions"));
    // Declared for writers only: a reader cannot ship a flag.
    expect(reader).not.toContain(textOf(standards, "QA and environment flags"));
  });

  // Both halves of the line-vs-substring hardening. The bug's precise shape:
  // the UNDELIVERED heading is a STRICT PREFIX of a DELIVERED one with the
  // `## ` aligned — so not.toContain("## Code review") false-reds while
  // "## Code review evidence" sits delivered. Suffix, reversed direction,
  // both-delivered, and body-text collisions are not this bug.
  test("heading-line comparison survives a prefix collision and still catches a leak", async () => {
    const evidence =
      "Cite the section that names the rule, not a paraphrase of it.";
    const source = declaring(
      live,
      "Code review evidence",
      "everyone",
      evidence,
    );
    // simple_coding writer: "Code review" is category-only, so undelivered;
    // "Code review evidence" is everyone, so delivered. Undelivered is the
    // shorter string — the only direction that fires the substring bug.
    const writer = await promptFrom(source, {
      readOnly: false,
      category: "simple_coding",
    });
    const undeliveredHeading = "## Code review";
    const deliveredHeading = "## Code review evidence";
    const headingLinesOf = (prompt: string): Set<string> =>
      new Set(prompt.split("\n").filter((line) => line.startsWith("## ")));

    // Precondition: the undelivered heading really is a strict prefix of the
    // delivered one with the ## aligned. Anything weaker is a different bug.
    expect(deliveredHeading.startsWith(undeliveredHeading)).toBe(true);
    expect(deliveredHeading.length).toBeGreaterThan(undeliveredHeading.length);
    expect(deliveredHeading[undeliveredHeading.length]).not.toBeUndefined();

    // (a) CURRENT substring assertion FAILING — a false RED. The failure
    // message must name the shorter (undelivered) heading, or the red is not
    // about this bug.
    let substringFailure: unknown;
    try {
      expect(writer).not.toContain(undeliveredHeading);
    } catch (error) {
      substringFailure = error;
    }
    expect(substringFailure).toBeInstanceOf(Error);
    expect(String(substringFailure)).toContain(undeliveredHeading);

    // (b) Line-based assertion PASSING on that same fixture.
    const lines = headingLinesOf(writer);
    expect(lines.has(deliveredHeading)).toBe(true);
    expect(lines.has(undeliveredHeading)).toBe(false);

    // (c) Line-based assertion STILL FAILING on a genuine leak of the
    // undelivered heading as its own line (the shape Charge 2 produces for
    // undelivered sections: heading present, body absent).
    const leaked = `${writer}\n\n${undeliveredHeading}\n\nleaked body that should never ship.\n`;
    expect(headingLinesOf(leaked).has(undeliveredHeading)).toBe(true);
  });

  // Charge 2 survival: if standardsFor emitted ## heading for every LOADED
  // section instead of every DELIVERED one, the vacuity probe's negative half
  // must still die — line precision must not cost leak detection. This is the
  // instrument enzo re-runs; rebuild it here so a future softening fails for
  // the same reason.
  test("the heading vacuity probe still dies when every loaded heading ships", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const writer = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      { readOnly: false, category: "complex_coding" },
    );
    // Positive control: the clean prompt already has a non-empty undelivered
    // set (Read-only agents, Code review) so the mutation has something to leak.
    const undelivered = standards.sections.filter(
      (section) => !writer.includes(section.text),
    );
    expect(undelivered.map((section) => section.heading)).toContain(
      "Read-only agents",
    );

    // Charge 2: inject every loaded section's heading line regardless of
    // audience — bodies stay delivery-filtered.
    const mutated = [
      writer,
      ...standards.sections.map((section) => `## ${section.heading}`),
    ].join("\n\n");
    const headingLines = new Set(
      mutated.split("\n").filter((line) => line.startsWith("## ")),
    );

    const leaks: string[] = [];
    for (const section of standards.sections) {
      const headingLine = `## ${section.heading}`;
      if (mutated.includes(section.text)) {
        if (!headingLines.has(headingLine)) {
          leaks.push(`missing ${headingLine}`);
        }
      } else if (headingLines.has(headingLine)) {
        // Negative half of the live probe: undelivered body ⇒ heading must
        // not appear as a line. Charge 2 violates this.
        leaks.push(headingLine);
      }
    }
    expect(leaks).toContain("## Read-only agents");
  });

  test("an audience Hive cannot route refuses and names both", async () => {
    const message = await refusalFrom(
      await rootHolding(
        withCategory("House style", "the tall people", "Use tabs."),
      ),
    );
    expect(message).toContain("House style");
    expect(message).toContain("the tall people");
  });

  test("a routing category Hive does not have refuses and names it", async () => {
    const message = await refusalFrom(
      await rootHolding(
        withCategory("House style", "category archaeology", "Use tabs."),
      ),
    );
    expect(message).toContain("archaeology");
  });

  // The roadmap's own acceptance test: a different team on this machinery seeds
  // rules that contradict Hive's, and not one of them may need a code change.
  test("a different team's opposing standards need no code change", async () => {
    const seeds = [
      ["Decision records", "everyone", "Decisions go in decisions/ as ADRs."],
      [
        "Documentation policy",
        "everyone",
        "We keep no docs — the tests are the spec.",
      ],
      [
        "Review process",
        "category code_review",
        "All review happens in GitHub PRs.",
      ],
      ["Release flags", "writers", "Prod-only flags are fine, we ship dark."],
    ] as const;
    let source = live;
    for (const [heading, audience, text] of seeds) {
      source = declaring(source, heading, audience, text);
    }
    const root = await rootHolding(source);
    const standards = await loadAgentStandards(root);
    for (const [heading] of seeds) {
      expect(standards.sections.map((section) => section.heading)).toContain(
        heading,
      );
    }
    const reviewer = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      { category: "code_review" },
    );
    expect(reviewer).toContain("Decisions go in decisions/ as ADRs.");
    expect(reviewer).toContain("All review happens in GitHub PRs.");
    const reader = buildAgentPrompt(
      "nina",
      "Fix the parser.",
      worktree,
      "",
      standards,
      { readOnly: true },
    );
    expect(reader).not.toContain("All review happens in GitHub PRs.");
    expect(reader).not.toContain("Prod-only flags are fine, we ship dark.");
  });
});
