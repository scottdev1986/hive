import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ChildReady {
  port: number;
  pid: number;
  instanceId: string;
  token: string;
}

type DaemonChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hive acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@hive.local",
      GIT_COMMITTER_NAME: "Hive acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@hive.local",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

async function waitForReady(
  child: DaemonChild,
): Promise<ChildReady> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("acceptance daemon exited before READY");
    buffered += decoder.decode(next.value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("READY ")) continue;
      reader.releaseLock();
      return JSON.parse(line.slice("READY ".length)) as ChildReady;
    }
  }
}

async function spawnDaemon(
  repoRoot: string,
  home: string,
  quotaPath: string,
): Promise<{ process: DaemonChild; ready: ChildReady }> {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "__fixtures__", "multi-instance-daemon.ts"),
  ], {
    cwd: join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      HIVE_HOME: home,
      HIVE_PROJECT_ROOT: repoRoot,
      HIVE_TEST_QUOTA_DB: quotaPath,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { process: child, ready: await waitForReady(child) };
}

async function stopDaemon(child: DaemonChild): Promise<void> {
  if (child.exitCode !== null) return;
  process.kill(child.pid, "SIGTERM");
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(5_000).then(() => {
      throw new Error("acceptance daemon did not exit after SIGTERM");
    }),
  ]);
  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`acceptance daemon exited ${exitCode}: ${stderr.trim()}`);
  }
}

async function connect(ready: ChildReady): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${ready.port}/mcp`),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${ready.token}`);
        return fetch(input, { ...init, headers });
      },
    },
  );
  const client = new Client({ name: "multi-instance-acceptance", version: "1" });
  await client.connect(transport);
  return client;
}

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

test("two live daemon processes isolate one repo through spawn, message, land, and teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-multi-instance-live-"));
  const repo = join(root, "repo");
  const homeA = join(root, "instances", "a");
  const homeB = join(root, "instances", "b");
  const quota = join(root, "quota.db");
  await Bun.$`git init -b main ${repo}`.quiet();
  await writeFile(join(repo, "README.md"), "# acceptance\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial", "--no-gpg-sign"]);

  let childA: Awaited<ReturnType<typeof spawnDaemon>> | null = null;
  let childB: Awaited<ReturnType<typeof spawnDaemon>> | null = null;
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  try {
    childA = await spawnDaemon(repo, homeA, quota);
    childB = await spawnDaemon(repo, homeB, quota);
    expect(childA.ready.instanceId).not.toEqual(childB.ready.instanceId);
    expect(childA.ready.port).not.toEqual(childB.ready.port);
    expect(existsSync(join(homeA, "daemon.lock"))).toEqual(true);
    expect(existsSync(join(homeB, "daemon.lock"))).toEqual(true);
    clientA = await connect(childA.ready);
    clientB = await connect(childB.ready);

    await clientA.callTool({
      name: "hive_spawn",
      arguments: {
        task: "write the acceptance marker",
        category: "simple_coding",
        name: "maya",
        tool: "codex",
      },
    });
    await clientB.callTool({
      name: "hive_spawn",
      arguments: {
        task: "hold the sibling worktree",
        category: "simple_coding",
        name: "david",
        tool: "codex",
      },
    });

    const statusA = textValue(await clientA.callTool({
      name: "hive_status",
      arguments: { detail: "full" },
    })) as Array<{ name: string; worktreePath: string; branch: string; tmuxSession: string }>;
    const statusB = textValue(await clientB.callTool({
      name: "hive_status",
      arguments: { detail: "full" },
    })) as Array<{ name: string; worktreePath: string; branch: string; tmuxSession: string }>;
    expect(statusA.map((agent) => agent.name)).toEqual(["maya"]);
    expect(statusB.map((agent) => agent.name)).toEqual(["david"]);
    expect(statusA[0]!.tmuxSession).toEndWith(`-${childA.ready.instanceId}`);
    expect(statusB[0]!.tmuxSession).toEndWith(`-${childB.ready.instanceId}`);

    const crossA = await clientA.callTool({
      name: "hive_send",
      arguments: { from: "orchestrator", to: "david", body: "wrong daemon" },
    });
    const crossB = await clientB.callTool({
      name: "hive_send",
      arguments: { from: "orchestrator", to: "maya", body: "wrong daemon" },
    });
    expect(crossA.isError).toEqual(true);
    expect(crossB.isError).toEqual(true);

    await clientA.callTool({
      name: "hive_send",
      arguments: { from: "maya", to: "orchestrator", body: "from-instance-a" },
    });
    await clientB.callTool({
      name: "hive_send",
      arguments: { from: "david", to: "orchestrator", body: "from-instance-b" },
    });
    const inboxA = textValue(await clientA.callTool({
      name: "hive_inbox",
      arguments: { agent: "orchestrator" },
    })) as Array<{ body: string }>;
    const inboxB = textValue(await clientB.callTool({
      name: "hive_inbox",
      arguments: { agent: "orchestrator" },
    })) as Array<{ body: string }>;
    expect(inboxA.map((message) => message.body)).toEqual(["from-instance-a"]);
    expect(inboxB.map((message) => message.body)).toEqual(["from-instance-b"]);

    await writeFile(join(statusA[0]!.worktreePath, "from-a.txt"), "landed by a\n");
    git(statusA[0]!.worktreePath, ["add", "from-a.txt"]);
    git(statusA[0]!.worktreePath, [
      "commit", "-m", "acceptance marker", "--no-gpg-sign",
    ]);
    const landed = textValue(await clientA.callTool({
      name: "hive_land",
      arguments: { agent: "maya", capabilityEpoch: 0 },
    })) as { commit: string };
    expect(git(repo, ["rev-parse", "HEAD"])).toEqual(landed.commit);
    expect(await readFile(join(repo, "from-a.txt"), "utf8")).toEqual("landed by a\n");
    expect(existsSync(statusB[0]!.worktreePath)).toEqual(true);

    await clientA.close();
    clientA = null;
    await stopDaemon(childA.process);
    expect(existsSync(join(homeA, "daemon.lock"))).toEqual(false);
    expect(existsSync(join(homeA, "daemon.pid"))).toEqual(false);
    expect(existsSync(statusA[0]!.worktreePath)).toEqual(true);
    expect(existsSync(statusB[0]!.worktreePath)).toEqual(true);
    expect(existsSync(join(homeB, "daemon.lock"))).toEqual(true);

    const healthB = await fetch(`http://127.0.0.1:${childB.ready.port}/health`);
    expect(healthB.ok).toEqual(true);
    const surviving = textValue(await clientB.callTool({
      name: "hive_status",
      arguments: { detail: "full" },
    })) as Array<{ name: string }>;
    expect(surviving.map((agent) => agent.name)).toEqual(["david"]);
    await clientB.callTool({
      name: "hive_send",
      arguments: { from: "david", to: "orchestrator", body: "b-survived-a-stop" },
    });
    const survivingInbox = textValue(await clientB.callTool({
      name: "hive_inbox",
      arguments: { agent: "orchestrator" },
    })) as Array<{ body: string }>;
    expect(survivingInbox.map((message) => message.body))
      .toEqual(["b-survived-a-stop"]);

    console.log("multi-instance acceptance", JSON.stringify({
      ports: [childA.ready.port, childB.ready.port],
      instanceIds: [childA.ready.instanceId, childB.ready.instanceId],
      statusA: ["maya"],
      statusB: ["david"],
      crossRoutingRejected: true,
      inboxA: ["from-instance-a"],
      inboxB: ["from-instance-b"],
      landed: landed.commit,
      afterStopA: {
        daemonAStopped: true,
        worktreeAPreserved: true,
        daemonBHealthy: healthB.ok,
        statusB: ["david"],
        messageB: "b-survived-a-stop",
        worktreeBExists: existsSync(statusB[0]!.worktreePath),
        lockBExists: existsSync(join(homeB, "daemon.lock")),
      },
    }));
  } finally {
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    if (childA !== null) await stopDaemon(childA.process).catch(() => undefined);
    if (childB !== null) await stopDaemon(childB.process).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
