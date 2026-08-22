import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "../src/adapters/providers/claude-cli";
import {
  buildCodexSpawnCommand,
  writeCodexAgentConfig,
} from "../src/adapters/providers/codex-cli";
import {
  buildGrokSpawnCommand,
  writeGrokAgentConfig,
} from "../src/adapters/providers/grok-cli";
import {
  buildKimiSpawnCommand,
  writeKimiAgentConfig,
} from "../src/adapters/providers/kimi-cli";
import {
  buildOpencodeSpawnCommand,
  writeOpencodeAgentConfig,
} from "../src/adapters/providers/opencode-cli";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../src/adapters/providers/shared/capability-env";
import {
  type AgentStandards,
  loadAgentStandards,
} from "../src/daemon/spawn/agent-standards";
import { ROLE_GRANTS } from "../src/daemon/authorization/authorization-service";
import {
  buildAgentPrompt,
  memoryIndexDigest,
} from "../src/daemon/spawn/spawner-impl";
import {
  buildMemoryIndex,
  writeMemoryFact,
} from "../src/memory-service/memory-store";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../src/schemas/capability";

const DAEMON_PORT = 4747;
const HIVE_URL = `http://127.0.0.1:${DAEMON_PORT}/mcp`;
const AGENT = "conformance-agent";
const TOKEN = "conformance-token-0123456789abcdef";
const FIXTURE_ARTICLE = "vendor-conformance-fixture-article";

const tempRoots: string[] = [];

// The memory surface every vendor's prompt is measured against: an index the
// real builder produced from real articles on disk. A marker string handed to
// buildAgentPrompt only proves the argument came back out, and the builder
// returns "" when it finds no rows — so a spawn whose memory never loaded
// yields a prompt a marker test cannot tell from a healthy one.
let fixtureIndex = "";
let fixtureStandards: AgentStandards;
let fixtureRoots: string[] = [];
let previousHiveHome: string | undefined;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-vendor-memory-repo-"));
  const home = await mkdtemp(join(tmpdir(), "hive-vendor-memory-home-"));
  fixtureRoots = [root, home];
  // Global memory joins the index from HIVE_HOME. Pointed at an empty
  // directory the fixture owns, so the user's own articles can neither
  // crowd the fixture row out of the index nor change it between runs.
  previousHiveHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  await writeMemoryFact(root, {
    scope: "repo",
    id: FIXTURE_ARTICLE,
    title: "Vendor conformance fixture article",
    topic: "testing",
    body: "The index each vendor's prompt is checked against holds this row.",
    source: "agent",
    evidence: "Written by the vendor conformance suite.",
    status: "unverified",
    kind: "article",
    supersedes: [],
    date: "2026-07-25",
  });
  fixtureIndex = await buildMemoryIndex(root);
  fixtureStandards = await loadAgentStandards(join(import.meta.dir, ".."));
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  await Promise.all(
    fixtureRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * The memory surface one spawn prompt must carry: the index's own rows, and
 * the digest that names the index they came from.
 *
 * `index` is the index as built from disk, never the prompt's own contents, so
 * a prompt that lost the block cannot satisfy this by agreeing with itself.
 * Shared with the vacuity probe below, which asserts this exact function
 * refuses a prompt built with an empty index — the check and its proof cannot
 * drift apart while they are the same function.
 */
function assertMemorySurface(prompt: string, index: string): void {
  expect(prompt).toContain(FIXTURE_ARTICLE);
  expect(prompt).toContain(
    `Memory index digest sha256:${memoryIndexDigest(index)}`,
  );
}

async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), "hive-vendor-conformance-"));
  tempRoots.push(worktree);
  return worktree;
}

interface VendorRow {
  vendor: CapabilityProvider;
  /** Drives the real config writer into the fixture worktree. */
  writeConfig: (worktree: string) => Promise<void>;
  /** The spawn argv the spawner builds for this vendor. */
  spawnArgv: (worktree: string) => string[];
  /** Asserts the produced config: the hive server entry pointing at the
   * loopback daemon, and auth delivered through the vendor's own channel. */
  inspectConfig: (worktree: string, argv: string[]) => Promise<void>;
  /** Vendor-specific prompt-assembly assertions (the memory index block is
   * asserted for every vendor by the harness). */
  inspectPrompt?: (prompt: string) => void;
}

const VENDORS: readonly VendorRow[] = [
  {
    vendor: "claude",
    writeConfig: (worktree) =>
      writeClaudeAgentConfig(worktree, {
        name: AGENT,
        daemonPort: DAEMON_PORT,
        readOnly: false,
        hiveCommand: ["hive"],
      }),
    spawnArgv: (worktree) =>
      buildClaudeSpawnCommand({
        name: AGENT,
        model: "default",
        worktreePath: worktree,
        daemonPort: DAEMON_PORT,
        readOnly: false,
      }),
    inspectConfig: async (worktree) => {
      const mcp = JSON.parse(
        await readFile(join(worktree, ".mcp.json"), "utf8"),
      ) as { mcpServers?: Record<string, Record<string, unknown>> };
      const hive = mcp.mcpServers?.hive;
      expect(hive).toBeDefined();
      expect(hive?.type).toBe("http");
      expect(hive?.url).toBe(HIVE_URL);
      // Claude's channel: a headersHelper command run at connect time that
      // reads the 0600 credential file — never a literal header or env var.
      const helper = hive?.headersHelper;
      expect(typeof helper).toBe("string");
      expect(helper).toContain("credential");
      expect(helper).toContain(`--agent ${AGENT}`);
      expect(helper).not.toContain(TOKEN);
      expect(hive?.headers).toBeUndefined();
    },
  },
  {
    vendor: "codex",
    writeConfig: (worktree) =>
      writeCodexAgentConfig(worktree, {
        name: AGENT,
        daemonPort: DAEMON_PORT,
        readOnly: false,
        hiveCommand: ["hive"],
      }),
    spawnArgv: (worktree) =>
      buildCodexSpawnCommand({
        name: AGENT,
        model: "default",
        effort: "medium",
        worktreePath: worktree,
        daemonPort: DAEMON_PORT,
        readOnly: false,
        withCapabilityToken: true,
      }),
    inspectConfig: async (worktree, argv) => {
      const toml = await readFile(
        join(worktree, ".codex", "config.toml"),
        "utf8",
      );
      expect(toml).toContain("[mcp_servers.hive]");
      expect(toml).toContain(`url = "${HIVE_URL}"`);
      // Codex's channel: bearer_token_env_var names an env var the launch
      // shell exports from the credential file outside the worktree. Neither
      // the project config nor any argv element may carry the token itself.
      expect(toml).not.toContain(TOKEN);
      const overrides = argv.join("\n");
      expect(overrides).toContain(`mcp_servers.hive.url="${HIVE_URL}"`);
      expect(overrides).toContain(
        `mcp_servers.hive.bearer_token_env_var="${HIVE_CAPABILITY_TOKEN_ENV}"`,
      );
    },
  },
  {
    vendor: "grok",
    writeConfig: (worktree) =>
      writeGrokAgentConfig(worktree, { daemonPort: DAEMON_PORT }),
    spawnArgv: (worktree) =>
      buildGrokSpawnCommand({
        model: "default",
        worktreePath: worktree,
        readOnly: false,
      }),
    inspectConfig: async (worktree) => {
      const toml = await readFile(
        join(worktree, ".grok", "config.toml"),
        "utf8",
      );
      expect(toml).toContain("[mcp_servers.hive]");
      expect(toml).toContain(`url = "${HIVE_URL}"`);
      // Grok's channel is an Authorization header in its config.toml whose
      // value names an env var grok expands at load time, so the live token
      // never reaches the project tree.
      expect(toml).toContain("[mcp_servers.hive.headers]");
      expect(toml).toContain(
        `Authorization = "Bearer \${${HIVE_CAPABILITY_TOKEN_ENV}}"`,
      );
      expect(toml).not.toContain(TOKEN);
    },
    inspectPrompt: (prompt) => {
      // The Grok safety directive must land BEFORE the memory index block:
      // the sandbox warning is a rule the agent reads first, and the memory
      // surface is the tail of the prompt.
      const directive = prompt.indexOf("Grok safety facts");
      expect(directive).toBeGreaterThanOrEqual(0);
      expect(directive).toBeLessThan(prompt.indexOf(FIXTURE_ARTICLE));
    },
  },
  {
    vendor: "kimi",
    writeConfig: (worktree) =>
      writeKimiAgentConfig(worktree, { daemonPort: DAEMON_PORT }),
    spawnArgv: () =>
      buildKimiSpawnCommand({
        model: "default",
        readOnly: false,
        dangerous: false,
      }),
    inspectConfig: async (worktree) => {
      const config = JSON.parse(
        await readFile(join(worktree, ".kimi-code", "mcp.json"), "utf8"),
      ) as { mcpServers?: Record<string, Record<string, unknown>> };
      const hive = config.mcpServers?.hive;
      expect(hive).toBeDefined();
      expect(hive?.url).toBe(HIVE_URL);
      // Kimi's channel: the project config names the environment variable the
      // launch shell exports from the credential file, never the bearer.
      expect(hive?.bearerTokenEnvVar).toBe(HIVE_CAPABILITY_TOKEN_ENV);
      expect(JSON.stringify(config)).not.toContain(TOKEN);
    },
  },
  {
    vendor: "opencode",
    writeConfig: (worktree) =>
      writeOpencodeAgentConfig(worktree, {
        daemonPort: DAEMON_PORT,
        readOnly: false,
      }),
    spawnArgv: () =>
      buildOpencodeSpawnCommand({
        model: "default",
        readOnly: false,
        dangerous: false,
      }),
    inspectConfig: async (worktree) => {
      const config = JSON.parse(
        await readFile(join(worktree, "opencode.json"), "utf8"),
      ) as { mcp?: Record<string, Record<string, unknown>> };
      const hive = config.mcp?.hive;
      expect(hive).toBeDefined();
      expect(hive?.type).toBe("remote");
      expect(hive?.url).toBe(HIVE_URL);
      // A server opencode never enables delivers no memory at all, so the
      // enablement is part of the wiring rather than a detail of it.
      expect(hive?.enabled).toBe(true);
      // opencode's channel: a {env:} reference it substitutes at config load,
      // with OAuth auto-detection off so the static bearer is what it sends.
      expect(hive?.oauth).toBe(false);
      const headers = hive?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe(
        `Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}`,
      );
      expect(JSON.stringify(config)).not.toContain(TOKEN);
    },
  },
];

describe("vendor memory conformance (HM-4 static matrix)", () => {
  for (const row of VENDORS) {
    describe(row.vendor, () => {
      test("config wires the hive MCP server with the vendor's auth channel", async () => {
        const worktree = await makeWorktree();
        await row.writeConfig(worktree);
        await row.inspectConfig(worktree, row.spawnArgv(worktree));
      });

      test("no capability token appears on any spawn argv element", async () => {
        const worktree = await makeWorktree();
        for (const arg of row.spawnArgv(worktree)) {
          expect(arg).not.toContain(TOKEN);
        }
      });

      test("spawn prompt carries the memory index block", async () => {
        const worktree = await makeWorktree();
        const prompt = buildAgentPrompt(
          AGENT,
          "Conformance task",
          { path: worktree, branch: "hive/conformance" },
          fixtureIndex,
          fixtureStandards,
          { tool: row.vendor },
        );
        assertMemorySurface(prompt, fixtureIndex);
        expect(prompt).toContain("separation of concerns");
        expect(prompt).toContain(
          "Comments refer only to code, never to documents.",
        );
        expect(prompt).toContain("Use the code-comments skill");
        expect(prompt).toContain(
          "Never run `make clean`, `make build`, or `make run`",
        );
        expect(prompt).toContain("Skills live in the primary checkout");
        row.inspectPrompt?.(prompt);
      });
    });
  }

  // `VENDORS` is an array, so a vendor Hive can spawn but this matrix never
  // covers is not a type error anywhere — it is simply a row nobody wrote, and
  // the suite stays green while a whole adapter goes unmeasured. This guard is
  // the only thing that fails when the registry grows or a row is deleted.
  test("every vendor in the capability registry has a conformance row", () => {
    expect(VENDORS.length).toBe(CAPABILITY_PROVIDERS.length);
    expect(VENDORS.map((row) => row.vendor).toSorted()).toEqual(
      [...CAPABILITY_PROVIDERS].toSorted(),
    );
  });

  // The vacuity probe for the per-vendor prompt assertion above. buildAgentPrompt
  // omits the memory block entirely when the index is empty, and the builder
  // returns "" whenever it finds no rows, so total injection failure is the
  // failure mode most likely to reach a real spawn unnoticed. Both halves run
  // here: the same helper, on prompts that differ only in the index it was
  // given. Without the passing half, a helper that threw for some unrelated
  // reason would read as a working probe.
  test("the prompt memory assertion refuses a spawn whose index arrived empty", async () => {
    const worktree = await makeWorktree();
    const promptWith = (index: string): string =>
      buildAgentPrompt(
        AGENT,
        "Conformance task",
        { path: worktree, branch: "hive/conformance" },
        index,
        fixtureStandards,
        { tool: "claude" },
      );
    expect(() =>
      assertMemorySurface(promptWith(fixtureIndex), fixtureIndex),
    ).not.toThrow();
    expect(() => assertMemorySurface(promptWith(""), fixtureIndex)).toThrow();
  });

  // Role-level, so it holds for every vendor at once: the spawner mints
  // writer and reader capabilities from these grants.
  test("writer role mints memory:read+write, never delete; reader is read-only", () => {
    expect(ROLE_GRANTS.writer.actions).toContain("memory:read");
    expect(ROLE_GRANTS.writer.actions).toContain("memory:write");
    expect(ROLE_GRANTS.writer.actions).not.toContain("memory:delete");
    expect(ROLE_GRANTS.reader.actions).toContain("memory:read");
    expect(ROLE_GRANTS.reader.actions).not.toContain("memory:write");
    expect(ROLE_GRANTS.reader.actions).not.toContain("memory:delete");
  });
});
