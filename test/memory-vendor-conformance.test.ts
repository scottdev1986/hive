// HiveMemory HM-4 (board #121): the vendor memory conformance matrix, static
// half. Every wired vendor must deliver the one `hive` MCP server (loopback
// HTTP + per-agent Bearer capability auth) through its own config channel,
// because the whole memory surface — search/read/write, the episodic tools,
// pitfall promotion — rides that single entry. A vendor row drives the REAL
// config writer into a fixture worktree and asserts the produced config, the
// auth delivery channel, that no capability token ever reaches an argv, and
// the spawn-time prompt's memory surface.
//
// Kimi Code and opencode join this matrix when their adapters land (issue
// #63): adding a vendor is adding one row to VENDORS.
//
// Live-agent recall proofs stay environment-gated
// (HIVE_LIVE_MEMORY_CONFORMANCE=1), the repo's existing live e2e pattern;
// this suite is the static half of the HM-4 matrix.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "../src/adapters/tools/claude";
import {
  buildCodexSpawnCommand,
  CODEX_CAPABILITY_TOKEN_ENV,
  codexCapabilityTokenPath,
  writeCodexAgentConfig,
} from "../src/adapters/tools/codex";
import {
  buildGrokSpawnCommand,
  writeGrokAgentConfig,
} from "../src/adapters/tools/grok";
import { ROLE_GRANTS } from "../src/daemon/capabilities";
import { buildAgentPrompt } from "../src/daemon/spawner-impl";
import type { CapabilityProvider } from "../src/schemas";

const DAEMON_PORT = 4747;
const HIVE_URL = `http://127.0.0.1:${DAEMON_PORT}/mcp`;
const AGENT = "conformance-agent";
const TOKEN = "conformance-token-0123456789abcdef";
const MEMORY_MARKER = "HIVE-MEMORY-INDEX-MARKER";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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
        capabilityToken: TOKEN,
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
      const toml = await readFile(join(worktree, ".codex", "config.toml"), "utf8");
      expect(toml).toContain("[mcp_servers.hive]");
      expect(toml).toContain(`url = "${HIVE_URL}"`);
      // Codex's channel: bearer_token_env_var names an env var the launch
      // shell exports from the 0600 token file. Neither the project config
      // nor any argv element may carry the token itself.
      expect(toml).not.toContain(TOKEN);
      const tokenPath = codexCapabilityTokenPath(worktree);
      expect(await readFile(tokenPath, "utf8")).toBe(TOKEN);
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      const overrides = argv.join("\n");
      expect(overrides).toContain(`mcp_servers.hive.url="${HIVE_URL}"`);
      expect(overrides).toContain(
        `mcp_servers.hive.bearer_token_env_var="${CODEX_CAPABILITY_TOKEN_ENV}"`,
      );
    },
  },
  {
    vendor: "grok",
    writeConfig: (worktree) =>
      writeGrokAgentConfig(worktree, {
        daemonPort: DAEMON_PORT,
        capabilityToken: TOKEN,
      }),
    spawnArgv: (worktree) =>
      buildGrokSpawnCommand({
        model: "default",
        worktreePath: worktree,
        readOnly: false,
      }),
    inspectConfig: async (worktree) => {
      const toml = await readFile(join(worktree, ".grok", "config.toml"), "utf8");
      expect(toml).toContain("[mcp_servers.hive]");
      expect(toml).toContain(`url = "${HIVE_URL}"`);
      // Grok's channel is a static Authorization header in its config.toml —
      // the only delivery shape the CLI supports.
      expect(toml).toContain("[mcp_servers.hive.headers]");
      expect(toml).toContain(`Authorization = "Bearer ${TOKEN}"`);
    },
    inspectPrompt: (prompt) => {
      // The Grok safety directive must land BEFORE the memory index block:
      // the sandbox warning is a rule the agent reads first, and the memory
      // surface is the tail of the prompt.
      const directive = prompt.indexOf("Grok safety facts");
      expect(directive).toBeGreaterThanOrEqual(0);
      expect(directive).toBeLessThan(prompt.indexOf(MEMORY_MARKER));
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
          "/repo",
          `Memory index:\n${MEMORY_MARKER}`,
          { tool: row.vendor },
        );
        expect(prompt).toContain(MEMORY_MARKER);
        row.inspectPrompt?.(prompt);
      });
    });
  }

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

// The live half of the HM-4 matrix (real CLIs, real spawns, in-transcript
// recall proofs) runs only on explicit request — the repo's live e2e
// pattern. Skipped by default.
const live = process.env.HIVE_LIVE_MEMORY_CONFORMANCE === "1";
const liveSuite = live ? describe : describe.skip;

liveSuite("vendor memory conformance, live (HIVE_LIVE_MEMORY_CONFORMANCE=1)", () => {
  for (const row of VENDORS) {
    test(`${row.vendor} CLI answers --version (live proof precondition)`, () => {
      const result = Bun.spawnSync([row.vendor, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    });
  }
});
