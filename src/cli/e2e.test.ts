import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAdapter } from "../adapters/terminal";
import type { TerminalHandle } from "../schemas";
import { HiveDatabase } from "../daemon/db";
import type { TmuxSender } from "../daemon/delivery";
import { HiveDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";
import { runHiveEvent } from "./event";
import { fetchAgentStatus } from "./mcp";

class FakeTmux implements TmuxSender {
  readonly sessions: string[] = [];
  readonly messages: Array<[string, string]> = [];

  async newSession(name: string): Promise<void> {
    this.sessions.push(name);
  }

  async hasSession(session: string): Promise<boolean> {
    return this.sessions.includes(session);
  }

  async capturePane(_session: string): Promise<string> {
    return "";
  }

  async listPanePids(_session: string): Promise<number[]> {
    return [];
  }

  async killSession(session: string): Promise<void> {
    const index = this.sessions.indexOf(session);
    if (index !== -1) {
      this.sessions.splice(index, 1);
    }
  }

  async sendMessage(session: string, text: string): Promise<void> {
    this.messages.push([session, text]);
  }
}

class FakeTerminal implements TerminalAdapter {
  async openWindow(
    _session: string,
    _title: string,
  ): Promise<TerminalHandle> {
    return { app: "iterm2", sessionId: "unused-headless-session" };
  }

  async closeWindow(_handle: TerminalHandle): Promise<void> {}
}

describe("CLI-to-daemon smoke", () => {
  // A spawn writes its brief under HIVE_HOME. Point it at a throwaway directory
  // so the suite never writes into the operator's real ~/.hive.
  let previousHiveHome: string | undefined;
  let hiveHome = "";

  beforeAll(async () => {
    hiveHome = await mkdtemp(join(tmpdir(), "hive-e2e-home-"));
    previousHiveHome = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = hiveHome;
  });

  afterAll(async () => {
    if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
    else Bun.env.HIVE_HOME = previousHiveHome;
    if (hiveHome !== "") await rm(hiveHome, { recursive: true, force: true });
  });

  test("real event POSTs drive status observed through the real MCP client", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-cli-e2e-"));
    const worktreePath = join(root, "worktree");
    await mkdir(worktreePath, { recursive: true });
    const db = new HiveDatabase(":memory:");
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      isModelEnabled: async () => true,
      db,
      repoRoot: root,
      port: 0,
      config: { terminal: "auto", headless: true },
      routing: async () => ({
        tool: "codex",
        claude: { model: "sonnet" },
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => ({
        path: worktreePath,
        branch: `hive/${name}-${slug}`,
      }),
      // The fail-loud launch watch needs proof of life. Advancing lastEventAt
      // without leaving "spawning" stands in for the first hook event and
      // keeps the post-spawn status assertion honest.
      sleep: async () => {
        const current = db.getAgentByName("maya");
        if (current !== null && current.status === "spawning") {
          db.upsertAgent({
            ...current,
            lastEventAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
      },
    });
    let daemon: HiveDaemon | null = null;
    try {
      daemon = new HiveDaemon({
        db,
        spawner,
        tmuxSender: tmux,
      });
      const port = 4317;
      // The `hive` CLI presents the operator credential on every call; here it
      // is minted in process rather than read from its 0600 file.
      const operatorToken = daemon.capabilities.mint("operator", "operator").token;
      const daemonFetch = (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${operatorToken}`);
        return daemon!.fetch(new Request(input, { ...init, headers }));
      };
      const spawned = await spawner.spawn({
        task: "Smoke test event wiring",
        tier: "standard",
      });
      expect(spawned.name).toEqual("maya");
      expect((await fetchAgentStatus(port, daemonFetch))[0]?.status).toEqual(
        "spawning",
      );

      expect(await runHiveEvent(
        "turn-start",
        port,
        { agent: "maya" },
        daemonFetch,
      ))
        .toEqual(0);
      expect((await fetchAgentStatus(port, daemonFetch))[0]?.status).toEqual(
        "working",
      );

      expect(await runHiveEvent("turn-end", port, {
        agent: "maya",
      }, daemonFetch)).toEqual(0);
      const [finished] = await fetchAgentStatus(port, daemonFetch);
      expect(finished?.status).toEqual("idle");
    } finally {
      await daemon?.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
