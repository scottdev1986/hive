import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import graphifyLock from "../../graphify.lock" with { type: "text" };
import {
  buildGraph,
  buildGraphBrief,
  buildTargetedGraphBrief,
  ensureGraphifyIgnored,
  GRAPHIFY_IGNORE_MARKER,
  graphifyPin,
  graphifyStatePath,
  installGraphify,
  noArtifactMessage,
  purgeGraphify,
  readGraphifyState,
  removeGraphifyExcludeEntry,
  runCommand,
  scrubbedGraphifyEnv,
  selectGraphBrief,
  writeGraphifyIgnore,
  writeGraphifyState,
  type CommandRunner,
  type RunResult,
} from "./graphify";
import type { GraphifyArtifact } from "./graphify-artifacts";

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

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-graphify-"));
  git(root, ["init"]);
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

const ok = (stdout = ""): RunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

describe("the embedded lock", () => {
  test("pins graphifyy to an exact version", () => {
    expect(graphifyPin()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("carries a hash for every pinned requirement", () => {
    // The provenance invariant: a lock entry without hashes silently disables
    // --require-hashes verification for that artifact. Every requirement line
    // must open a continuation block containing at least one --hash.
    const lines = graphifyLock.split("\n");
    const requirements = lines.filter((line) => /^[a-z0-9._-]+==/i.test(line));
    expect(requirements.length).toBeGreaterThan(0);
    for (const requirement of requirements) {
      const start = lines.indexOf(requirement);
      const block: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!line.startsWith(" ")) break;
        block.push(line);
      }
      expect(
        block.some((line) => line.includes("--hash=sha256:")),
        `${requirement} has no --hash`,
      ).toBe(true);
    }
  });

  test("includes the mcp extra's server dependencies", () => {
    // graphify-mcp import-errors without the [mcp] extra; the lock must carry
    // it or the installed tool cannot serve.
    expect(graphifyLock).toContain("\nmcp==");
  });
});

describe("scrubbedGraphifyEnv", () => {
  test("is an allowlist that cannot leak provider keys", () => {
    process.env.FAKE_PROVIDER_API_KEY = "secret";
    try {
      const env = scrubbedGraphifyEnv();
      expect(Object.keys(env).sort()).toEqual(
        ["HOME", "PATH", ...(process.env.TMPDIR === undefined ? [] : ["TMPDIR"])].sort(),
      );
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.HOME).toContain(join("tools", "graphify"));
      expect(JSON.stringify(env)).not.toContain("secret");
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });
});

describe("per-repo state", () => {
  test("round-trips, and absence reads as disabled", async () => {
    const root = await gitRepo();
    expect(await readGraphifyState(root)).toEqual({ enabled: false, pin: null });
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    expect(await readGraphifyState(root)).toEqual({
      enabled: true,
      pin: graphifyPin(),
    });
    expect(graphifyStatePath(root).startsWith(hiveHome)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("a malformed state file reads as disabled", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: null });
    await writeFile(graphifyStatePath(root), "enabled = maybe???");
    expect(await readGraphifyState(root)).toEqual({ enabled: false, pin: null });
    await rm(root, { recursive: true, force: true });
  });
});

describe("ensureGraphifyIgnored", () => {
  test("writes .git/info/exclude once and verifies with --no-index", async () => {
    const root = await gitRepo();
    const first = await ensureGraphifyIgnored(root);
    expect(first.ok).toBe(true);
    const second = await ensureGraphifyIgnored(root);
    expect(second.ok).toBe(true);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    for (const entry of ["graphify-out/", ".graphifyignore"]) {
      const occurrences = exclude
        .split("\n")
        .filter((line) => line.trim() === entry).length;
      expect(occurrences, entry).toBe(1);
    }
    const check = Bun.spawnSync(
      ["git", "-C", root, "check-ignore", "--no-index", "graphify-out/probe", ".graphifyignore"],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(check.exitCode).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  test("from a linked worktree, one exclude in the common dir covers it", async () => {
    const root = await gitRepo();
    const worktree = join(root, ".wt");
    git(root, ["worktree", "add", worktree, "-b", "wt"]);
    const result = await ensureGraphifyIgnored(worktree);
    expect(result.ok).toBe(true);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("graphify-out/");
    const check = Bun.spawnSync(
      ["git", "-C", worktree, "check-ignore", "--no-index", "graphify-out/probe"],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(check.exitCode).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  test("outside a git repo it fails loudly instead of writing anywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-nogit-"));
    const result = await ensureGraphifyIgnored(root);
    expect(result.ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

describe("removeGraphifyExcludeEntry", () => {
  test("removes exactly the lines Hive appended and keeps the user's", async () => {
    const root = await gitRepo();
    const excludePath = join(root, ".git", "info", "exclude");
    await writeFile(excludePath, "mine.log\n");
    await ensureGraphifyIgnored(root);
    expect(await removeGraphifyExcludeEntry(root)).toBe(true);
    const after = await readFile(excludePath, "utf8");
    expect(after).toContain("mine.log");
    expect(after).not.toContain("graphify-out/");
    expect(after).not.toContain("hive graphify");
    // A second removal finds nothing to do.
    expect(await removeGraphifyExcludeEntry(root)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

describe("installGraphify", () => {
  const bundleBytes = new TextEncoder().encode("not really a tarball");
  const bundleSha256 = new Bun.CryptoHasher("sha256")
    .update(bundleBytes)
    .digest("hex");
  const artifact: GraphifyArtifact = {
    tag: "graphify-vtest-hive.1",
    asset: "graphify-test-darwin-arm64.tar.zst",
    sha256: bundleSha256,
  };

  test("no published artifact for this platform: one honest line, nothing run", async () => {
    const calls: string[][] = [];
    let fetched = 0;
    const result = await installGraphify({
      artifact: () => null,
      fetchArtifact: async () => {
        fetched += 1;
        return new Response(bundleBytes);
      },
      run: async (argv) => {
        calls.push(argv);
        return ok();
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(noArtifactMessage("darwin-arm64"));
    expect(fetched).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a hash mismatch refuses to unpack: no tar run, bundle dir absent", async () => {
    const calls: string[][] = [];
    const result = await installGraphify({
      artifact: () => ({ ...artifact, sha256: "0".repeat(64) }),
      fetchArtifact: async () => new Response(bundleBytes),
      run: async (argv) => {
        calls.push(argv);
        return ok();
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("refusing to install");
      expect(result.reason).toContain(bundleSha256);
    }
    expect(calls).toEqual([]);
    expect(
      await readFile(join(hiveHome, "tools", "graphify", graphifyPin(), "graphify"), "utf8")
        .catch(() => null),
    ).toBeNull();
  });

  test("verifies the sha256, unpacks with tar, then probes both entry points", async () => {
    const calls: string[][] = [];
    const result = await installGraphify({
      artifact: () => artifact,
      fetchArtifact: async (url) => {
        expect(url).toBe(
          `https://github.com/${process.env.HIVE_UPDATE_REPO ?? "scottdev1986/hive"}/releases/download/${artifact.tag}/${artifact.asset}`,
        );
        return new Response(bundleBytes);
      },
      run: async (argv) => {
        calls.push(argv);
        return ok();
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain("sha256-verified");
    expect(calls.length).toBe(3);
    const [untar, probe, mcpProbe] = calls as [string[], string[], string[]];
    expect(untar[0]).toBe("/usr/bin/tar");
    expect(untar).toContain("--strip-components");
    // Probes run the bundle binaries by absolute path, never a PATH lookup.
    expect(probe[0]).toContain(join("tools", "graphify", graphifyPin(), "graphify"));
    expect(mcpProbe[0]).toContain(
      join("tools", "graphify", graphifyPin(), "graphify-mcp"),
    );
    // The downloaded tarball is cleaned up either way.
    expect(untar[2]).toContain(".download");
    expect(await readFile(untar[2] as string, "utf8").catch(() => null)).toBeNull();
  });

  test("a healthy existing bundle is kept: no download, probes only", async () => {
    const bin = join(hiveHome, "tools", "graphify", graphifyPin());
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "graphify"), "#!/bin/sh\n");
    let fetched = 0;
    const calls: string[][] = [];
    try {
      const result = await installGraphify({
        artifact: () => artifact,
        fetchArtifact: async () => {
          fetched += 1;
          return new Response(bundleBytes);
        },
        run: async (argv) => {
          calls.push(argv);
          return ok();
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.detail).toContain("already installed");
      expect(fetched).toBe(0);
      expect(calls.length).toBe(2);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe("buildGraph", () => {
  test("always --code-only, always scrubbed, by absolute path", async () => {
    let seen: { argv: string[]; env: Record<string, string> | undefined } | null =
      null;
    const run: CommandRunner = async (argv, options) => {
      seen = { argv, env: options.env };
      return ok("[graphify extract] wrote /r/graphify-out/graph.json: 5 nodes, 9 edges, 2 communities");
    };
    const result = await buildGraph("/repo", run);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toBe("5 nodes, 9 edges, 2 communities");
    const call = seen as unknown as {
      argv: string[];
      env: Record<string, string> | undefined;
    };
    expect(call.argv).toContain("--code-only");
    expect(call.argv[0]).toContain(join("tools", "graphify", graphifyPin(), "graphify"));
    expect(call.env).toEqual(scrubbedGraphifyEnv());
    expect(JSON.stringify(call.argv)).not.toContain("--backend");
  });

  test("a timeout degrades to a loud failure, never a hang", async () => {
    const run: CommandRunner = async () => ({
      exitCode: 143,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const result = await buildGraph("/repo", run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("timed out");
  });
});

describe("buildGraphBrief", () => {
  test("a repo that never opted in gets silence, not a note", async () => {
    const root = await gitRepo();
    expect(await buildGraphBrief(root, "fix the bug")).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  test("opted in but no graph yet: one loud line, no command run", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    const calls: string[][] = [];
    const brief = await buildGraphBrief(root, "fix the bug", async (argv) => {
      calls.push(argv);
      return ok();
    });
    expect(brief).toContain("unavailable");
    expect(brief).toContain("proceeding without it");
    expect(calls).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a timed-out query degrades to the loud line inside its time-box", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    // Fake an installed binary and graph so the query path is reached.
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    const { graphifyBin, graphJsonPath } = await import("./graphify");
    const { dirname } = await import("node:path");
    await mkdir(dirname(graphifyBin()), { recursive: true });
    await write(graphifyBin(), "");
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await write(graphJsonPath(root), "{}");
    let seen: { argv: string[]; timeoutMs: number } | null = null;
    const brief = await buildGraphBrief(root, "fix the bug", async (argv, options) => {
      seen = { argv, timeoutMs: options.timeoutMs };
      return { exitCode: 143, stdout: "", stderr: "", timedOut: true };
    });
    expect(brief).toContain("timed out");
    const call = seen as unknown as { argv: string[]; timeoutMs: number };
    // The digest is budgeted and time-boxed — the two bounds that keep the
    // spawn from ever waiting on a sick graphify.
    expect(call.timeoutMs).toBe(3_000);
    expect(call.argv).toContain("--budget");
    expect(call.argv).toContain("query");
    // The serializer emits all nodes before any edge; below ~16000 the edges
    // — the only cited, tagged content — never survive to be selected.
    expect(Number(call.argv[call.argv.indexOf("--budget") + 1]))
      .toBeGreaterThanOrEqual(16_000);
    await rm(root, { recursive: true, force: true });
  });

  test("a healthy query becomes an advisory-prefixed digest", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    const { graphifyBin, graphJsonPath } = await import("./graphify");
    const { dirname } = await import("node:path");
    await mkdir(dirname(graphifyBin()), { recursive: true });
    await write(graphifyBin(), "");
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await write(graphJsonPath(root), "{}");
    const brief = await buildGraphBrief(root, "fix the bug", async () =>
      ok("NODE server.ts [src=src/daemon/server.ts]"));
    expect(brief).toContain("advisory");
    expect(brief).toContain("verify");
    expect(brief).toContain("NODE server.ts");
    await rm(root, { recursive: true, force: true });
  });
});

describe("buildTargetedGraphBrief", () => {
  const node = (
    id: string, label: string, file: string, loc = "L1",
  ) => ({ id, label, source_file: file, source_location: loc, community: 1 });
  const link = (source: string, target: string, relation = "imports_from") =>
    ({ relation, confidence: "EXTRACTED", context: "import", source, target });
  // A seed found by name; a second file whose ONLY relevance is defining a
  // task-matched symbol the seed imports — the measured gap in the acceptance
  // question (nothing named the config writer; its imported symbol did).
  const graph = {
    nodes: [
      node("api", "api.ts", "src/api.ts"),
      node("api_handle", "handleRequest()", "src/api.ts", "L20"),
      node("billing", "billing.ts", "src/billing.ts"),
      node("billing_render", "renderInvoice()", "src/billing.ts", "L7"),
      node("api_test", "api.test.ts", "src/api.test.ts"),
      node("api_test_sym", "invoiceFixture()", "src/api.test.ts", "L3"),
      node("util", "util.ts", "src/util.ts"),
      node("util_pad", "padLeft()", "src/util.ts", "L2"),
      node("log", "log.ts", "src/log.ts"),
      node("log_write", "writeLog()", "src/log.ts", "L4"),
    ],
    links: [
      link("api", "billing"),
      link("api", "billing_render", "imports"),
      link("api", "util"),
      link("api_test", "api"),
    ],
  };

  test("surfaces the name-matched seed and the matched-symbol import target", () => {
    const brief = buildTargetedGraphBrief(graph, "where does the api render an invoice");
    expect(brief).not.toBeNull();
    // Cited NODE lines for both files, including the symbol that matched.
    expect(brief).toContain("NODE api.ts [src=src/api.ts loc=L1 community=1]");
    expect(brief).toContain("NODE renderInvoice() [src=src/billing.ts loc=L7 community=1]");
    // The relational skeleton rides in upstream's EDGE grammar, module↔module first.
    const edges = (brief as string).split("\n").filter((l) => l.startsWith("EDGE "));
    expect(edges[0]).toBe("EDGE api.ts --imports_from [EXTRACTED context=import]--> billing.ts");
    expect(brief).toContain("[graph brief: ");
  });

  test("a test file never outranks the code it tests", () => {
    const brief = buildTargetedGraphBrief(graph, "where does the api render an invoice") as string;
    const apiIndex = brief.indexOf("NODE api.ts ");
    const testIndex = brief.indexOf("src/api.test.ts");
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex === -1 || testIndex > apiIndex).toBe(true);
  });

  test("malformed graphs and matchless tasks return null, never throw", () => {
    expect(buildTargetedGraphBrief(null, "anything")).toBeNull();
    expect(buildTargetedGraphBrief({ nodes: "nope" }, "anything")).toBeNull();
    expect(buildTargetedGraphBrief({ nodes: [], links: [] }, "anything")).toBeNull();
    expect(buildTargetedGraphBrief(graph, "zzz qqq xxx")).toBeNull();
  });
});

describe("buildGraphBrief targeted path", () => {
  test("a parseable graph is answered by Hive's locate with no subprocess", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    const { graphifyBin, graphJsonPath } = await import("./graphify");
    const { dirname } = await import("node:path");
    await mkdir(dirname(graphifyBin()), { recursive: true });
    await write(graphifyBin(), "");
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await write(graphJsonPath(root), JSON.stringify({
      nodes: [
        { id: "auth", label: "auth.ts", source_file: "src/auth.ts", source_location: "L1", community: 1 },
        { id: "auth_login", label: "loginUser()", source_file: "src/auth.ts", source_location: "L9", community: 1 },
        { id: "util", label: "util.ts", source_file: "src/util.ts", source_location: "L1", community: 2 },
      ],
      links: [{ relation: "imports_from", confidence: "EXTRACTED", context: "import", source: "auth", target: "util" }],
    }));
    const calls: string[][] = [];
    const brief = await buildGraphBrief(root, "fix the login flow in auth", async (argv) => {
      calls.push(argv);
      return ok();
    });
    expect(brief).toContain("advisory");
    expect(brief).toContain("Graph locate:");
    expect(brief).toContain("NODE loginUser() [src=src/auth.ts loc=L9");
    // The binary was never invoked: locate reads graph.json directly.
    expect(calls).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("selectGraphBrief", () => {
  // The serializer writes every NODE before the first EDGE; a head slice
  // therefore always delivers zero edges (measured: 51 nodes, 0 edges at the
  // old budget on the acceptance question). Selection must keep edges.
  const header = "Traversal: BFS depth=2 | Start: ['a'] | 999 nodes found";
  const output = [
    header,
    "",
    ...Array.from({ length: 400 }, (_, i) => `NODE filler${i} [src=src/f${i}.ts loc=L1 community=1]`),
    "NODE alpha [src=src/a.ts loc=L10 community=2]",
    "NODE beta [src=src/b.ts loc=L20 community=2]",
    "EDGE alpha --imports_from [EXTRACTED context=import]--> beta",
    ...Array.from({ length: 300 }, (_, i) => `EDGE filler${i} --indirect_call [INFERRED context=collection]--> filler${i + 1}`),
  ].join("\n");

  test("keeps the header, the edges, and cites kept edges' endpoints first", () => {
    const brief = selectGraphBrief(output);
    expect(brief).toContain("Traversal: BFS");
    expect(brief).toContain("EDGE alpha --imports_from [EXTRACTED context=import]--> beta");
    // alpha/beta sit at position 401/402 of 402 — a head slice would never
    // reach them; endpoint-first selection must.
    expect(brief).toContain("NODE alpha [src=src/a.ts loc=L10");
    expect(brief).toContain("NODE beta [src=src/b.ts loc=L20");
  });

  test("stays within the brief's context cost and says what it elided", () => {
    const brief = selectGraphBrief(output);
    expect(brief.length).toBeLessThanOrEqual(6_200);
    expect(brief).toMatch(/\[graph brief: kept \d+\/402 nodes, \d+\/301 edges\]/);
  });

  test("a small result passes through whole", () => {
    const small = `${header}\n\nNODE a [src=s.ts loc=L1]\nEDGE a --calls [EXTRACTED]--> b`;
    const brief = selectGraphBrief(small);
    expect(brief).toContain("NODE a [src=s.ts loc=L1]");
    expect(brief).toContain("EDGE a --calls [EXTRACTED]--> b");
    expect(brief).toContain("kept 1/1 nodes, 1/1 edges");
  });
});

describe("writeGraphifyIgnore", () => {
  test("derives nested-gitignore dirs the binary cannot see, plus the floor", async () => {
    // The pinned binary reads gitignore rules only at the scan root; a nested
    // `sub/.gitignore: .build/` is invisible to it (this is how 51% of this
    // repo's graph became vendored Swift). git ls-files evaluates every level.
    const root = await gitRepo();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "sub", ".build", "checkouts"), { recursive: true });
    await writeFile(join(root, "sub", ".gitignore"), ".build/\n");
    await writeFile(join(root, "sub", ".build", "checkouts", "dep.swift"), "let x = 1\n");
    const result = await writeGraphifyIgnore(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain("sub/.build/");
    const content = await readFile(join(root, ".graphifyignore"), "utf8");
    expect(content.startsWith(GRAPHIFY_IGNORE_MARKER)).toBe(true);
    expect(content).toContain("/sub/.build/");
    expect(content).toContain("vendor/");
    expect(content).toContain("third_party/");
    await rm(root, { recursive: true, force: true });
  });

  test("a user-authored .graphifyignore is never rewritten", async () => {
    const root = await gitRepo();
    await writeFile(join(root, ".graphifyignore"), "my-own-rules/\n");
    const result = await writeGraphifyIgnore(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain("user-authored");
    expect(await readFile(join(root, ".graphifyignore"), "utf8")).toBe("my-own-rules/\n");
    await rm(root, { recursive: true, force: true });
  });

  test("purge removes Hive's generated file but never a user's", async () => {
    const root = await gitRepo();
    await writeGraphifyIgnore(root);
    let removed = await purgeGraphify(root);
    expect(removed.some((path) => path.endsWith(".graphifyignore"))).toBe(true);

    await writeFile(join(root, ".graphifyignore"), "my-own-rules/\n");
    removed = await purgeGraphify(root);
    expect(removed.some((path) => path.endsWith(".graphifyignore"))).toBe(false);
    expect(await readFile(join(root, ".graphifyignore"), "utf8")).toBe("my-own-rules/\n");
    await rm(root, { recursive: true, force: true });
  });
});

describe("snapshotGraphForServing", () => {
  test("copies the built graph to state-dir path rebuilds never touch", async () => {
    // The MCP server re-reads its graph file per query and rebuilds rewrite
    // graphify-out/graph.json in place, so serving the live file opens a
    // "graph.json not found" window on every landing (measured 2026-07-12).
    const { snapshotGraphForServing, servingGraphPath, graphJsonPath } =
      await import("./graphify");
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const root = await gitRepo();
    await mkdir(dirname(graphJsonPath(root)), { recursive: true });
    await writeFile(graphJsonPath(root), '{"nodes":[]}');
    const result = await snapshotGraphForServing(root);
    expect(result.ok).toBe(true);
    const serving = servingGraphPath(root);
    expect(serving.startsWith(hiveHome)).toBe(true);
    expect(serving).not.toContain("graphify-out");
    expect(await readFile(serving, "utf8")).toBe('{"nodes":[]}');
    // Rewriting the live file must not disturb what the server reads.
    await writeFile(graphJsonPath(root), "MID-REBUILD GARBAGE");
    expect(await readFile(serving, "utf8")).toBe('{"nodes":[]}');
    await rm(root, { recursive: true, force: true });
  });

  test("a missing graph degrades to a reason, never a throw", async () => {
    const { snapshotGraphForServing } = await import("./graphify");
    const root = await gitRepo();
    const result = await snapshotGraphForServing(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("snapshot");
    await rm(root, { recursive: true, force: true });
  });
});

describe("runCommand", () => {
  test("kills at the deadline and reports timedOut", async () => {
    const result = await runCommand(["/bin/sleep", "5"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
