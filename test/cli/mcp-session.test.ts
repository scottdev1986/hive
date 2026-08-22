// What a held MCP session costs and what it survives, measured against a real
// daemon: the client and the server here are the production ones, and every
// count below is of the JSON-RPC traffic the client actually sent.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { isString } from "../../src/shared/is-record";
import {
  fetchAgentStatus,
  HiveMcpSession,
  readAgentStatus,
} from "../../src/cli/mcp";
import type { AgentRecord } from "../../src/schemas/agent";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import { tempRoot } from "../temp-root";

process.env.HIVE_HOME = tempRoot("hive-mcp-session-test-");

/** The handshake this client opens a session with. One per connection, which is what these tests count. */
const CONNECT = "server/discover";

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("this test never spawns");
  }
}

const harness = () => {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    repoRoot: join(tmpdir(), "hive-mcp-session-noop"),
    landBranch: async () => {
      throw new Error("this test never lands");
    },
    projectGate: async () => {},
    mainHealthMonitor: null,
    readLandReadiness: async () => ({
      pending: null,
      rebased: null,
      targetBranch: null,
      targetHead: null,
      baseSha: null,
    }),
    listSettlementBranches: async () => [],
    reconcileOrphanedWorktrees: async () => ({
      worktrees: [],
      preservedRefs: { releasable: [], kept: [] },
    }),
  });
  return { daemon, db, token: daemon.capabilities.mint("user", "user").token };
};

/** Records the JSON-RPC method of every request the client sends, and can make one `tools/call` fail the way a dropped connection does. */
const recordingFetch = (daemon: HiveDaemon, token: string) => {
  const methods: string[] = [];
  let failNext = false;
  return {
    methods,
    failNextToolCall: () => {
      failNext = true;
    },
    fetcher: async (input: string | URL, init?: RequestInit) => {
      const body = isString(init?.body) ? init.body : "";
      const method = /"method":"([^"]+)"/.exec(body)?.[1];
      if (method !== undefined) methods.push(method);
      if (failNext && method === "tools/call") {
        failNext = false;
        throw new Error("connection reset by peer");
      }
      // Headers must be merged through the Headers API: spreading a Headers instance yields {} and would strip the MCP client's Accept header.
      const headers = new Headers(init?.headers);
      headers.set("Host", "127.0.0.1");
      headers.set("Authorization", `Bearer ${token}`);
      return daemon.fetch(new Request(input, { ...init, headers }));
    },
  };
};

describe("HiveMcpSession", () => {
  test("a held session connects once however many times it is read", async () => {
    const { daemon, db, token } = harness();
    const { methods, fetcher } = recordingFetch(daemon, token);
    const session = new HiveMcpSession(4483, fetcher);
    try {
      // This daemon has no agent bound to a terminal host, so an empty roster is the correct answer; the memory section is the positive control that these reads carry daemon-authored content rather than a key this client cannot see.
      expect(await readAgentStatus(session)).toEqual([]);
      expect(await readAgentStatus(session)).toEqual([]);
      expect(await session.call("hive_status", {}, "memory")).toMatchObject({
        embeddings: { state: expect.any(String) },
      });

      expect(methods.filter((name) => name === CONNECT)).toHaveLength(1);
      expect(methods.filter((name) => name === "tools/call")).toHaveLength(3);
    } finally {
      await session.close();
      await daemon.stop();
      db.close();
    }
  });

  test("the one-shot call pays for a whole session every time", async () => {
    const { daemon, db, token } = harness();
    const { methods, fetcher } = recordingFetch(daemon, token);
    try {
      await fetchAgentStatus(4483, fetcher);
      await fetchAgentStatus(4483, fetcher);
      await fetchAgentStatus(4483, fetcher);

      expect(methods.filter((name) => name === CONNECT)).toHaveLength(3);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a read on a session the daemon dropped reconnects and answers", async () => {
    const { daemon, db, token } = harness();
    const { methods, failNextToolCall, fetcher } = recordingFetch(
      daemon,
      token,
    );
    const session = new HiveMcpSession(4483, fetcher);
    try {
      await readAgentStatus(session);
      failNextToolCall();

      expect(await session.call("hive_status", {}, "memory")).toMatchObject({
        embeddings: { state: expect.any(String) },
      });
      expect(methods.filter((name) => name === CONNECT)).toHaveLength(2);
    } finally {
      await session.close();
      await daemon.stop();
      db.close();
    }
  });

  test("a fresh session's first failure is the daemon's answer, not a retry", async () => {
    const { daemon, db, token } = harness();
    const { methods, failNextToolCall, fetcher } = recordingFetch(
      daemon,
      token,
    );
    const session = new HiveMcpSession(4483, fetcher);
    failNextToolCall();
    try {
      await expect(readAgentStatus(session)).rejects.toThrow(
        "connection reset by peer",
      );

      expect(methods.filter((name) => name === CONNECT)).toHaveLength(1);
    } finally {
      await session.close();
      await daemon.stop();
      db.close();
    }
  });
});
