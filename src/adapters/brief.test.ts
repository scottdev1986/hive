import { describe, expect, test } from "bun:test";
import {
  BRIEF_MAX_CHARS,
  type BriefConfig,
  buildScopedBrief,
  findTaskDocReferences,
  loadBriefConfig,
  parseDocOutline,
  resolveBriefablePath,
  SECTION_MAX_CHARS,
  selectSections,
} from "./brief";

// The brief inputs on-demand doc discovery produces for this repo. Passing them
// explicitly keeps the unit tests independent of a live tree walk while
// exercising exactly the config product code derives from it. A dedicated test
// below asserts `loadBriefConfig` recovers these from the repo's docs on disk.
const CONFIG: BriefConfig = {
  briefableDocs: ["SPEC.md", "README.md", "CLAUDE.md"],
  briefableDirectories: ["docs/", "research/"],
  primaryDoc: "SPEC.md",
};

const SPEC = [
  "# hive",
  "",
  "Intro prose that belongs to no section.",
  "",
  "## How it works",
  "",
  "### 1. How agents talk",
  "",
  "Agents talk over the daemon.",
  "",
  "### 6. Who picks the model",
  "",
  "The orchestrator classifies; the table resolves.",
  "",
  "### 7. What happens when a context fills up",
  "",
  "Recycle at 65%.",
  "",
  "## Open questions",
  "",
  "Does review pay for itself?",
].join("\n");

const readSpec = async (path: string): Promise<string> => {
  if (path.endsWith("SPEC.md")) return SPEC;
  throw new Error(`ENOENT: ${path}`);
};

describe("parseDocOutline", () => {
  test("captures heading, level, ordinal and 1-indexed line range", () => {
    const outline = parseDocOutline(SPEC);
    expect(outline.map((section) => section.heading)).toEqual([
      "hive",
      "How it works",
      "1. How agents talk",
      "6. Who picks the model",
      "7. What happens when a context fills up",
      "Open questions",
    ]);
    const model = outline.find((section) => section.ordinal === 6)!;
    expect(model.level).toBe(3);
    expect(model.startLine).toBe(11);
    expect(SPEC.split("\n")[model.startLine - 1]).toBe(
      "### 6. Who picks the model",
    );
    expect(model.body).toContain("The orchestrator classifies");
    // A section stops at the next heading of any level, so it never re-embeds
    // a sibling's text.
    expect(model.body).not.toContain("Recycle at 65%");
  });

  test("prose before the first heading is not addressable", () => {
    expect(parseDocOutline(SPEC)[0]!.startLine).toBe(1);
    expect(parseDocOutline("no headings here")).toEqual([]);
  });
});

describe("findTaskDocReferences", () => {
  test("binds a trailing section selector to the doc", () => {
    expect(findTaskDocReferences("Rework SPEC.md §6 to add a tier", CONFIG))
      .toEqual([{ path: "SPEC.md", sections: [6] }]);
  });

  test("binds a leading section selector to the doc", () => {
    expect(findTaskDocReferences("Read section 7 of SPEC.md first", CONFIG))
      .toEqual([{ path: "SPEC.md", sections: [7] }]);
  });

  test("reads a bare primary-doc § reference with no .md", () => {
    expect(findTaskDocReferences("Follow SPEC §6 exactly", CONFIG)).toEqual([
      { path: "SPEC.md", sections: [6] },
    ]);
  });

  test("the bare-name rule follows whatever doc the profile names primary", () => {
    const design: BriefConfig = {
      briefableDocs: ["DESIGN.md"],
      briefableDirectories: [],
      primaryDoc: "DESIGN.md",
    };
    expect(findTaskDocReferences("Follow DESIGN §3 exactly", design)).toEqual([
      { path: "DESIGN.md", sections: [3] },
    ]);
    // And a repo whose profile names no primary doc simply loses the special
    // case: a bare "SPEC §6" resolves to nothing.
    const none: BriefConfig = {
      briefableDocs: ["notes.md"],
      briefableDirectories: [],
      primaryDoc: null,
    };
    expect(findTaskDocReferences("Follow SPEC §6 exactly", none)).toEqual([]);
  });

  test("collects several sections and de-duplicates", () => {
    expect(
      findTaskDocReferences("Update SPEC.md sections 6 and 7, then §6 again", CONFIG),
    ).toEqual([{ path: "SPEC.md", sections: [6, 7] }]);
  });

  test("reads a quoted heading selector", () => {
    expect(
      findTaskDocReferences('Revise SPEC.md "Who picks the model" today', CONFIG),
    ).toEqual([{ path: "SPEC.md", sections: ["Who picks the model"] }]);
  });

  test("a doc named with no section still resolves, so it gets an outline", () => {
    expect(findTaskDocReferences("Read SPEC.md before designing", CONFIG))
      .toEqual([{ path: "SPEC.md", sections: [] }]);
  });

  test("finds docs in briefable directories", () => {
    expect(
      findTaskDocReferences(
        "See docs/routing/rejected-approaches.md",
        CONFIG,
      ),
    ).toEqual([
      { path: "docs/routing/rejected-approaches.md", sections: [] },
    ]);
  });

  test("strips trailing punctuation from a path", () => {
    expect(findTaskDocReferences("Read SPEC.md, then stop.", CONFIG)[0]!.path)
      .toBe("SPEC.md");
  });

  test("ignores non-briefable paths", () => {
    expect(findTaskDocReferences("Fix src/daemon/spawner-impl.ts", CONFIG))
      .toEqual([]);
    expect(findTaskDocReferences("Read node_modules/pkg/readme.md", CONFIG))
      .toEqual([]);
  });

  test("a task naming no doc gets no references", () => {
    expect(findTaskDocReferences("Add a retry to the poller", CONFIG)).toEqual([]);
  });
});

describe("resolveBriefablePath", () => {
  test("resolves an allowed doc inside the root", () => {
    expect(resolveBriefablePath("/repo", "SPEC.md", CONFIG))
      .toBe("/repo/SPEC.md");
    expect(resolveBriefablePath("/repo", "docs/x.md", CONFIG))
      .toBe("/repo/docs/x.md");
  });

  test("refuses traversal, absolute paths, and non-briefable files", () => {
    expect(resolveBriefablePath("/repo", "../../etc/passwd.md", CONFIG)).toBeNull();
    expect(resolveBriefablePath("/repo", "/etc/passwd.md", CONFIG)).toBeNull();
    expect(resolveBriefablePath("/repo", "src/secret.md", CONFIG)).toBeNull();
  });
});

describe("selectSections", () => {
  test("matches a numeric selector against the heading ordinal", () => {
    const picked = selectSections(parseDocOutline(SPEC), [6]);
    expect(picked.map((section) => section.heading)).toEqual([
      "6. Who picks the model",
    ]);
  });

  test("matches a string selector loosely against heading text", () => {
    const picked = selectSections(parseDocOutline(SPEC), ["who picks the MODEL"]);
    expect(picked).toHaveLength(1);
  });

  test("an unmatched selector selects nothing", () => {
    expect(selectSections(parseDocOutline(SPEC), [99, "absent"])).toEqual([]);
  });
});

describe("loadBriefConfig", () => {
  test("recovers this repo's briefable docs and primary from on-demand discovery", async () => {
    // Against this very repo, two directories up from this file (src/adapters/ →
    // repo root). Nothing is cached for it to read: the docs are discovered on
    // demand from the tree, which is exactly what product code relies on.
    const root = new URL("../..", import.meta.url).pathname;
    const config = await loadBriefConfig(root);
    expect(config.briefableDocs).toContain("SPEC.md");
    expect(config.primaryDoc).toBe("SPEC.md");
    expect(config.briefableDirectories).toContain("docs/");
    // docs/ is gitignored here, so it is found by walking disk. This repo also
    // has live agent worktrees under .hive/worktrees/, each a full checkout
    // with its own docs/ — an unscoped walk would find all of them and the
    // corpus would run to hundreds. It is a couple of dozen docs.
    expect(config.briefableDocs.length).toBeLessThan(100);
  });

  test("a repo with no discoverable docs briefs nothing rather than assuming doc names", async () => {
    const config = await loadBriefConfig("/no/such/repo");
    expect(config).toEqual({
      briefableDocs: [],
      briefableDirectories: [],
      primaryDoc: null,
    });
  });
});

describe("buildScopedBrief", () => {
  test("a task naming no doc gets no brief at all", async () => {
    expect(
      await buildScopedBrief("/repo", "Add a retry", { readDoc: readSpec, config: CONFIG }),
    ).toBe("");
  });

  test("embeds only the named section, verbatim, with a file:line pointer", async () => {
    const brief = await buildScopedBrief("/repo", "Rework SPEC.md §6", {
      readDoc: readSpec,
      config: CONFIG,
    });
    expect(brief).toContain("--- SPEC.md:11-14 ---");
    expect(brief).toContain("The orchestrator classifies; the table resolves.");
    // The sections the task did not name are never embedded.
    expect(brief).not.toContain("Recycle at 65%");
    expect(brief).not.toContain("Agents talk over the daemon.");
  });

  test("lists the unembedded sections as an outline with pointers", async () => {
    const brief = await buildScopedBrief("/repo", "Rework SPEC.md §6", {
      readDoc: readSpec,
      config: CONFIG,
    });
    expect(brief).toContain("Outline of SPEC.md");
    // Depth is rendered as indentation under the `path:line` pointer.
    expect(brief).toContain("SPEC.md:15    7. What happens when a context fills up");
    expect(brief).toContain("SPEC.md:19  Open questions");
  });

  test("a doc named without a section yields an outline, never its full text", async () => {
    const big = `${SPEC}\n\n${"filler prose. ".repeat(500)}`;
    const brief = await buildScopedBrief("/repo", "Read SPEC.md first", {
      readDoc: async () => big,
      config: CONFIG,
    });
    expect(brief).toContain("Outline of SPEC.md");
    expect(brief).toContain("SPEC.md:11    6. Who picks the model");
    expect(brief).not.toContain("The orchestrator classifies");
    expect(brief).not.toContain("filler prose.");
    expect(brief.length).toBeLessThan(big.length / 2);
  });

  test("a small doc named without a section is embedded whole", async () => {
    const brief = await buildScopedBrief("/repo", "Read SPEC.md first", {
      readDoc: readSpec,
      config: CONFIG,
    });
    expect(brief).toContain("whole document");
    expect(brief).toContain("The orchestrator classifies");
  });

  test("tells the agent not to read the files whole", async () => {
    const brief = await buildScopedBrief("/repo", "Rework SPEC.md §6", {
      readDoc: readSpec,
      config: CONFIG,
    });
    expect(brief).toContain("Do not read these files whole");
  });

  test("truncates an oversized section and points at the remainder", async () => {
    const long = [
      "### 6. Who picks the model",
      "x".repeat(SECTION_MAX_CHARS + 500),
    ].join("\n");
    const brief = await buildScopedBrief("/repo", "SPEC.md §6", {
      readDoc: async () => long,
      config: CONFIG,
    });
    expect(brief).toContain("…truncated");
    expect(brief).toMatch(/The rest of this section is SPEC\.md:\d+-\d+\./);
    expect(brief.length).toBeLessThan(SECTION_MAX_CHARS + 1_000);
  });

  test("stays inside the total budget across many sections", async () => {
    const headings = Array.from(
      { length: 12 },
      (_, index) => `### ${index + 1}. Section\n${"y".repeat(2_000)}`,
    ).join("\n\n");
    const brief = await buildScopedBrief(
      "/repo",
      "SPEC.md sections 1 and 2, §3, §4, §5, §6, §7, §8",
      { readDoc: async () => headings, config: CONFIG },
    );
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS + 1_000);
    expect(brief).toContain("Brief budget exhausted");
  });

  test("a missing doc is not a spawn failure", async () => {
    expect(
      await buildScopedBrief("/repo", "Read README.md", {
        readDoc: readSpec,
        config: CONFIG,
      }),
    ).toBe("");
  });

  test("a doc outside the repo is never read", async () => {
    let attempted = false;
    await buildScopedBrief("/repo", "Read ../../etc/passwd.md", {
      readDoc: async () => {
        attempted = true;
        return "secret";
      },
      config: CONFIG,
    });
    expect(attempted).toBe(false);
  });

  test("with no config and nothing discoverable at root, produces no brief", async () => {
    // Product path against a directory with no docs to discover: no doc is
    // briefable, so the mechanism is a safe no-op rather than assuming hive's
    // doc names.
    const brief = await buildScopedBrief("/no/such/repo", "Rework SPEC.md §6", {
      readDoc: readSpec,
    });
    expect(brief).toBe("");
  });

  test("with no config, builds a brief end to end through on-demand discovery", async () => {
    // The full production path with nothing stubbed: no config passed, so
    // buildScopedBrief must load it from on-demand doc discovery against this
    // very repo, find SPEC.md as briefable, read it, and embed the reference.
    // The other buildScopedBrief tests inject `config`, so this is the only one
    // that exercises the discovery wiring the brief is fed from in production.
    const root = new URL("../..", import.meta.url).pathname;
    const brief = await buildScopedBrief(root, "Follow SPEC.md before you start");
    expect(brief).toContain("SPEC.md");
    expect(brief).toContain("Do not read these files whole");
  });
});
