// Live integration test for the Claude Channels adapter. It drives a REAL
// `claude` CLI in a REAL tmux session against a REAL hive daemon — no protocol
// fakes — and proves both the channel path and the tmux fallback.
//
// Skipped unless HIVE_LIVE_CHANNELS=1, because it needs an authenticated
// Claude Code >= 2.1.80 on PATH, a tmux server, and it spends real quota:
//
//   HIVE_LIVE_CHANNELS=1 bun test src/daemon/channels.live.test.ts
//
// Channels is a research preview reachable only behind
// --dangerously-load-development-channels, so this test is also the canary for
// the day the flag, the capability key, or the notification shape changes.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { QuotaConfigSchema, type AgentRecord } from "../schemas";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { shellJoin, TmuxAdapter } from "../adapters/tmux";
import { HiveDatabase } from "./db";
import { QuotaLedger } from "./quota-ledger";
import { QuotaService } from "./quota";
import { HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";

const live = process.env.HIVE_LIVE_CHANNELS === "1";
const suite = live ? describe : describe.skip;

const SESSION = "hive-live-channels";
const PORT = Number(process.env.HIVE_LIVE_PORT ?? 44831);
const CLI = resolve(import.meta.dir, "../cli.ts");

const root = mkdtempSync(join(tmpdir(), "hive-live-channels-"));
const hiveHome = join(root, "home");
const agentWorktree = join(root, "agent");
const binDir = join(root, "bin");

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("spawner is not exercised by this test");
  }
}

const tmuxAdapter = new TmuxAdapter();

async function tmux(...args: string[]): Promise<string> {
  const child = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return stdout;
}

const capture = (): Promise<string> => tmux("capture-pane", "-p", "-t", SESSION);

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${label}\n--- pane ---\n${await capture()}`);
}

const paneMatches = (pattern: RegExp) => async (): Promise<boolean> =>
  pattern.test(await capture());

let db: HiveDatabase;
let daemon: HiveDaemon;
let quota: QuotaService;
let shim = "";

async function boot(): Promise<void> {
  mkdirSync(hiveHome, { recursive: true });
  mkdirSync(agentWorktree, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Claude spawns `hive channel-bridge` and runs `hive statusline`, so the
  // binary the adapter names must actually resolve on the session's PATH.
  shim = join(binDir, "hive");
  writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${CLI} "$@"\n`);
  chmodSync(shim, 0o755);

  process.env.HIVE_HOME = hiveHome;
  db = new HiveDatabase(join(hiveHome, "hive.db"));
  quota = new QuotaService(
    new QuotaLedger(db),
    QuotaConfigSchema.parse({
      limits: [{
        provider: "claude",
        account: "personal",
        pool: "claude-subscription",
        models: ["sonnet"],
        fiveHourAllowance: 200,
        weeklyAllowance: 1_000,
      }],
    }),
  );
  daemon = new HiveDaemon({
    db,
    spawner: new UnusedSpawner(),
    tmuxSender: {
      sendMessage: (session, text) => tmuxAdapter.sendKeys(session, text),
    },
    port: PORT,
    quota,
  });

  const now = new Date().toISOString();
  db.insertAgent({
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "sonnet",
    category: "simple_coding",
    status: "idle",
    taskDescription: "live channels verification",
    worktreePath: agentWorktree,
    branch: "hive/maya-live",
    tmuxSession: SESSION,
    contextPct: 0,
    createdAt: now,
    lastEventAt: now,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    channelsEnabled: true,
  });

  // Exactly the config and argv a real spawn would produce.
  await writeClaudeAgentConfig(agentWorktree, {
    name: "maya",
    daemonPort: PORT,
    readOnly: false,
    channels: true,
  });
  const argv = buildClaudeSpawnCommand({
    name: "maya",
    model: "sonnet",
    worktreePath: agentWorktree,
    daemonPort: PORT,
    readOnly: false,
    channels: true,
  });

  await tmux("kill-session", "-t", SESSION).catch(() => undefined);
  await tmux(
    "new-session", "-d", "-s", SESSION, "-c", agentWorktree,
    "-x", "200", "-y", "50",
    "-e", `PATH=${binDir}:${process.env.PATH}`,
    "-e", `HIVE_HOME=${hiveHome}`,
    shellJoin(argv),
  );

  // Only now start the daemon: its startup reconciliation sweep marks any live
  // agent whose tmux session is missing as dead, and here we own the ordering
  // that a real spawn gets for free (row inserted, then session created).
  daemon.start();

  // Trust folder + development-channels warning dialogs.
  for (let dialog = 0; dialog < 2; dialog += 1) {
    try {
      await waitFor(paneMatches(/Enter to confirm/), 20_000, "a startup dialog");
      await tmux("send-keys", "-t", SESSION, "Enter");
      await Bun.sleep(2_000);
    } catch {
      // Already-trusted folders show no dialog.
    }
  }
  await waitFor(
    paneMatches(/Channels \(experimental\)/),
    60_000,
    "the Channels banner",
  );
  await waitFor(() => daemon.channels.isLive("maya"), 30_000, "bridge registration");
}

afterAll(async () => {
  if (!live) return;
  await tmux("kill-session", "-t", SESSION).catch(() => undefined);
  await daemon?.stop();
  db?.close();
});

suite("Claude Channels against a live CLI", () => {
  test("boots a real session whose bridge registers a live channel", async () => {
    await boot();
    expect(daemon.channels.isLive("maya")).toBe(true);
  }, 180_000);

  test("delivers a hive message into the running session as a channel event", async () => {
    const message = await daemon.delivery.send(
      "sam",
      "maya",
      "LIVE CHANNEL TEST: reply in this session with exactly the word: walnut",
    );

    // The CLI queues the event for its next turn and never acknowledges it.
    expect(message.state).toBe("injected");
    expect(message.deliveredAt).not.toBeNull();

    await waitFor(paneMatches(/walnut/i), 120_000, "the model to act on the event");
    const pane = await capture();
    // A channel event renders as a <channel> tag, never as the tmux envelope.
    expect(pane).not.toContain("📨 message from sam");
  }, 180_000);

  test("relays a CLI permission prompt through hive's approval queue", async () => {
    const before = db.listApprovals("pending").length;
    await tmux(
      "set-buffer", "-b", "live",
      "run this exact bash command: mkdir -p /tmp/hive-live-relay-proof",
    );
    await tmux("paste-buffer", "-d", "-p", "-b", "live", "-t", SESSION);
    await Bun.sleep(1_000);
    await tmux("send-keys", "-t", SESSION, "Enter");

    await waitFor(
      () => db.listApprovals("pending").length > before,
      90_000,
      "the CLI permission prompt to reach hive's approval queue",
    );
    const approval = db.listApprovals("pending").at(-1)!;
    expect(approval.agentName).toBe("maya");
    expect(approval.description).toContain("hive-live-relay-proof");

    // Answer through the single approval queue, exactly as the orchestrator does.
    const client = new Client({ name: "live", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)),
    );
    await client.callTool({
      name: "hive_approve",
      arguments: { id: approval.id, decision: "approve" },
    });
    await client.close();

    // The relayed verdict answers the CLI's still-open dialog.
    await waitFor(
      async () =>
        await Bun.$`test -d /tmp/hive-live-relay-proof`.quiet().then(
          () => true,
          () => false,
        ),
      90_000,
      "the relayed allow verdict to release the tool call",
    );
    await Bun.$`rm -rf /tmp/hive-live-relay-proof`.quiet().catch(() => undefined);
  }, 240_000);

  test("records the session's statusLine usage as a reported observation", async () => {
    const payload = JSON.stringify({
      rate_limits: {
        five_hour: {
          used_percentage: 33,
          resets_at: Math.floor(Date.now() / 1_000) + 3_600,
        },
        seven_day: {
          used_percentage: 12,
          resets_at: Math.floor(Date.now() / 1_000) + 86_400,
        },
      },
    });
    const child = Bun.spawn(
      [shim, "statusline", "--agent", "maya", "--port", String(PORT)],
      { stdin: new TextEncoder().encode(payload), stdout: "pipe" },
    );
    const rendered = await new Response(child.stdout).text();
    await child.exited;
    expect(rendered).toContain("5h 33%");

    const status = quota.statuses()[0]!;
    if (!("fiveHour" in status)) throw new Error("expected a configured pool");
    expect(status.confidence).toBe("reported");
    expect(status.source).toBe("statusline");
    expect(status.fiveHour.used).toBe(66);
    expect(status.fiveHour.resetsAt).not.toBeNull();
  }, 60_000);

  test("falls back to a tmux paste when the session has no channel", async () => {
    db.upsertAgent({ ...db.getAgentByName("maya")!, channelsEnabled: false });
    daemon.channels.drop("maya");

    const message = await daemon.delivery.send(
      "sam",
      "maya",
      "LIVE FALLBACK TEST: reply in this session with exactly the word: acorn",
    );
    // Paste-then-delayed-Enter structurally submits the turn.
    expect(message.state).toBe("applied");

    await waitFor(paneMatches(/acorn/i), 120_000, "the model to act on the paste");
    expect(await capture()).toContain("📨 message from sam");
  }, 180_000);
});
