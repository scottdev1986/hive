// `POST /graphify`: the daemon converges the per-repo MCP server on the
// persisted opt-in state. Operator-only — an agent that can toggle a code
// indexer on the human's machine has escaped its sandbox through the control
// plane — and absent entirely on daemons with no service configured.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphifyService } from "./graphify-service";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";

const home = mkdtempSync(join(tmpdir(), "hive-graphify-endpoint-"));
process.env.HIVE_HOME = home;

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-graphify-repo-"));
  Bun.spawnSync(["git", "-C", root, "init"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return root;
}

function harness(options: { withService?: boolean } = {}): HiveDaemon {
  const root = repo();
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: root,
    tmux: {
      hasSession: async () => false,
      killSession: async () => {},
      capturePane: async () => "",
      newSession: async () => {},
    },
    ...(options.withService === false
      ? {}
      : { graphify: new GraphifyService(root, undefined, () => {}) }),
    resourceRunners: { orphans: null },
  });
}

const post = (daemon: HiveDaemon, token: string | null): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return daemon.fetch(
    new Request("http://hive/graphify", { method: "POST", headers }),
  );
};

describe("POST /graphify", () => {
  test("the operator converges a never-enabled repo to stopped", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("operator", "operator");
    const response = await post(daemon, token);
    expect(response.status).toEqual(200);
    expect(await response.json()).toEqual({
      enabled: false,
      running: false,
      url: null,
      lastError: null,
    });
    await daemon.stop();
  });

  test("agents cannot toggle it", async () => {
    const daemon = harness();
    const writer = daemon.capabilities.mint("maya", "writer").token;
    const orchestrator = daemon.capabilities
      .mint("orchestrator", "orchestrator").token;
    expect((await post(daemon, writer)).status).toEqual(403);
    expect((await post(daemon, orchestrator)).status).toEqual(403);
    await daemon.stop();
  });

  test("no token is denied outright", async () => {
    const daemon = harness();
    expect((await post(daemon, null)).status).toEqual(401);
    await daemon.stop();
  });

  test("a daemon without the service says so instead of pretending", async () => {
    const daemon = harness({ withService: false });
    const { token } = daemon.capabilities.mint("operator", "operator");
    const response = await post(daemon, token);
    expect(response.status).toEqual(503);
    await daemon.stop();
  });
});
