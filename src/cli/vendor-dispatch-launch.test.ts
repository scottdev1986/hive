import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSkills, type SkillTool } from "../adapters/skills";
import { resolveConcreteModel } from "../adapters/tools/models";
import {
  GRAPHIFY_HOOK_SCRIPT,
  writeGraphifyHook,
  type GraphifyHookKind,
} from "../adapters/tools/graphify-hook";
import { readAccountBilling } from "../daemon/usage-credits";
import type { CapabilityProvider, Route } from "../schemas";
import {
  buildOrchestratorCommand,
  buildOrchestratorLaunchCommand,
  launchOrchestrator,
  orchestratorConfigRoot,
  prepareOrchestratorConfig,
  type OrchestratorTool,
} from "./orchestrator";

/**
 * Part 2 of the vendor-dispatch refactor: the LAUNCH side. Where part 1 guarded
 * what Hive reads about an agent (telemetry, recovery, quota pools), these
 * guard what Hive *starts* and what it *charges* — an orchestrator's argv, the
 * model a "default" route resolves to, and the billing surface the money guard
 * reads before a spawn.
 *
 * Every test drives one converted site with a vendor Hive does not know and
 * asserts the effect, never the shape: that it fails, that it names the vendor,
 * and — the discriminating half — that the vendor it was NOT is never reached.
 * A `codex` fallthrough restored at any of these sites fails exactly its test:
 * the launch ones by spawning a Codex process, the billing one by probing
 * Claude's usage surface for a vendor that is not Claude.
 *
 * The vendor is cast in, because after the refactor the compiler no longer
 * permits it. That is the point: these casts reach past the type wall on
 * purpose, to prove the runtime one behind it holds.
 */
const UNKNOWN_TOOL = "grok" as unknown as OrchestratorTool;
const UNKNOWN_PROVIDER = "grok" as unknown as CapabilityProvider;

const noExistingRoot = {
  hasSession: async () => false,
  listClientTtys: async () => [],
  killSession: async () => {},
};

// orchestratorConfigRoot() resolves under HIVE_HOME; sandbox it so an assertion
// about what was written to disk cannot touch the live orchestrator's config.
let hiveHome = "";
let previousHiveHome: string | undefined;

beforeEach(async () => {
  previousHiveHome = process.env.HIVE_HOME;
  hiveHome = await mkdtemp(join(tmpdir(), "hive-vendor-launch-"));
  process.env.HIVE_HOME = hiveHome;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

test("an unknown vendor's orchestrator config is refused, not silently skipped", async () => {
  await expect(prepareOrchestratorConfig(UNKNOWN_TOOL, 4317, process.cwd()))
    .rejects.toThrow(/unknown vendor "grok"/);
  // The old `if (tool === "claude")` wrote nothing and said nothing. Silence is
  // the failure being asserted here: an orchestrator with no config posts its
  // hooks nowhere and can never prove life.
  expect(existsSync(orchestratorConfigRoot())).toBe(false);
});

test("no orchestrator command is built for an unknown vendor, least of all codex's", () => {
  // Positive control: the codex arm still builds the codex launch.
  expect(buildOrchestratorCommand("codex", 4317)[0]).toBe("codex");

  let command: string[] | null = null;
  expect(() => {
    command = buildOrchestratorCommand(UNKNOWN_TOOL, 4317);
  }).toThrow(/unknown vendor "grok"/);
  // The discriminating assertion: a claude-or-else ternary would have handed
  // back Codex's argv, sandbox flags and all, for a CLI that is not Codex.
  expect(command).toBeNull();
});

test("no tmux launch command is built for an unknown vendor", () => {
  let command: string[] | null = null;
  expect(() => {
    command = buildOrchestratorLaunchCommand(UNKNOWN_TOOL, 4317, "/repo");
  }).toThrow(/unknown vendor "grok"/);
  expect(command).toBeNull();

  // Honest about what this proves. Both arms of buildOrchestratorLaunchCommand
  // delegate to buildOrchestratorCommand, which already throws — so restoring
  // the codex fallthrough at THIS site leaves this test passing, on a throw
  // raised one frame deeper. Measured, not assumed: the mutation survives. The
  // property asserted (no argv escapes for a vendor Hive cannot launch) is
  // real and holds; this site's own switch earns its place as a compile error,
  // not as a second runtime guard, and it is not claimed to be more.
});

test("launching an unknown vendor's orchestrator spawns nothing and touches no tmux session", async () => {
  let spawned: string[] | null = null;
  let resolvedClaude = false;
  let askedTmux = false;

  await expect(launchOrchestrator(
    UNKNOWN_TOOL,
    4317,
    process.cwd(),
    (command) => {
      spawned = command;
      return { exited: Promise.resolve(0) };
    },
    async () => null,
    async () => "9.9.9",
    () => {
      resolvedClaude = true;
      return { path: "claude", version: "9.9.9" };
    },
    {
      ...noExistingRoot,
      hasSession: async () => {
        askedTmux = true;
        return false;
      },
    },
  )).rejects.toThrow(/unknown vendor "grok"/);

  // The vendor switch is the FIRST thing the launch does, so an unknown vendor
  // costs nothing: no process, no tmux session killed, no Claude install
  // demanded of a vendor that does not need one. A restored `if (claude)` gate
  // would fall through to the tmux prep before anything complained.
  expect(spawned).toBeNull();
  expect(askedTmux).toBe(false);
  expect(resolvedClaude).toBe(false);
});

test("a 'default' model is never resolved for an unknown vendor from codex's config", async () => {
  const route = {
    tool: UNKNOWN_TOOL,
    claude: { model: "default" },
    codex: { model: "default" },
    grok: { model: "default" },
  } as unknown as Route;

  // The old ternary read ~/.codex/config.toml for anything that was not Claude
  // and launched a third vendor's agent on whatever model Codex is pinned to —
  // or, finding none, returned the "default" alias as though it had resolved
  // something.
  await expect(resolveConcreteModel(UNKNOWN_TOOL as Route["tool"], route))
    .rejects.toThrow(/unknown vendor "grok"/);
});

test("billing for an unknown vendor throws instead of probing claude's usage surface", async () => {
  let claudeProbes = 0;
  let codexProbes = 0;
  const transports = {
    claude: {
      readUsage: async () => {
        claudeProbes += 1;
        throw new Error("must not probe Claude for a vendor that is not Claude");
      },
    },
    codex: {
      readRateLimits: async () => {
        codexProbes += 1;
        throw new Error("must not probe Codex for a vendor that is not Codex");
      },
    },
  };

  // Positive control, and the reason this matters: a probe that fails is
  // swallowed into `null`, which the money guard reads as "billing unknown" and
  // tolerates. Claude was the ELSE of the old `if (provider === "codex")`, so an
  // unknown vendor was probed with Claude's surface and its answer — or its
  // silence — was billed to a vendor that never sent it.
  await expect(readAccountBilling("claude", undefined, 10, transports))
    .resolves.toBeNull();
  expect(claudeProbes).toBe(1);
  await expect(readAccountBilling("codex", undefined, 10, transports))
    .resolves.toBeNull();
  expect(codexProbes).toBe(1);

  await expect(
    readAccountBilling(UNKNOWN_PROVIDER, undefined, 10, transports),
  ).rejects.toThrow(/unknown vendor "grok"/);
  // Never swallowed into the null a quiet vendor produces, and never answered
  // by the other vendor's probe.
  expect(claudeProbes).toBe(1);
  expect(codexProbes).toBe(1);
});

test("an unknown vendor's spawn provisions no skills at all, rather than the wrong ones", async () => {
  const worktree = join(hiveHome, "worktree");

  // Positive control, and the discriminating half. Codex's skills land in
  // `.agents/skills` and Claude's in `.claude/skills` — two directories, because
  // neither CLI reads the other's. The private `SkillTool` alias this file used
  // to keep was invisible to the shared vendor enum, so a third vendor would
  // have been provisioned on every single spawn with whatever the record's
  // missing key resolved to: no skills, or another CLI's.
  await provisionSkills(worktree, "codex", join(hiveHome, "global"));
  expect(existsSync(join(worktree, ".agents", "skills", "hive-codex"))).toBe(true);
  expect(existsSync(join(worktree, ".claude", "skills"))).toBe(false);

  const unknownWorktree = join(hiveHome, "unknown-worktree");
  await expect(
    provisionSkills(
      unknownWorktree,
      UNKNOWN_PROVIDER as SkillTool,
      join(hiveHome, "global"),
    ),
  ).rejects.toThrow(/unknown vendor "grok"/);

  // Nothing was written anywhere: the vendor is resolved before the first mkdir,
  // so a vendor Hive cannot provision does not get a half-provisioned worktree
  // that a later read would happily call provisioned.
  expect(existsSync(unknownWorktree)).toBe(false);
});

test("every graphify hook kind nudges, and a kind the script does not know fails open", async () => {
  // A stand-in for the graphify MCP endpoint: the hook nudges only when the
  // server answers the way a live one does.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('{"error":"Missing session ID"}'),
  });
  const path = join(hiveHome, ".claude", GRAPHIFY_HOOK_SCRIPT);
  await writeGraphifyHook(path, `http://127.0.0.1:${server.port}/mcp`);

  const run = async (kind: string, input: string) => {
    const child = Bun.spawn([path, kind], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    return { stdout, exitCode: await child.exited };
  };

  // The kinds are the record's own keys: a kind added there without a working
  // arm fails here rather than going quiet in the field.
  const nudged: Record<string, boolean> = {};
  for (const kind of ["claude-search", "codex"] satisfies GraphifyHookKind[]) {
    const result = await run(kind, JSON.stringify({ command: "grep -rn foo" }));
    nudged[kind] = result.stdout.includes("Graphify is on");
  }
  const read = await run("claude-read", JSON.stringify({ file_path: "a.ts" }));
  nudged["claude-read"] = read.stdout.includes("Graphify is on");
  expect(nudged).toEqual({
    "claude-search": true,
    codex: true,
    "claude-read": true,
  });

  // A kind the script has no arm for: silent, and exit 0. This is the one place
  // in the refactor where a silent zero is CORRECT, and it is a deliberate
  // choice, not an oversight. A PreToolUse hook that fails loudly does not
  // inform anyone — it blocks the agent's tool call, mid-turn, on every search.
  // A Hive wiring bug must not be paid for by the agent, so the shell stays
  // fail-open and the loud failure lives at the compile step: the filter record
  // is total over GraphifyHookKind, so a new vendor cannot reach this arm
  // without first refusing to compile.
  const unknown = await run("grok", JSON.stringify({ command: "grep -rn foo" }));
  expect(unknown.stdout).toBe("");
  expect(unknown.exitCode).toBe(0);

  server.stop(true);
});
