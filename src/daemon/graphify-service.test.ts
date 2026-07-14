import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { graphifyPin, writeGraphifyState } from "../adapters/graphify";
import { GraphifyService } from "./graphify-service";

// The hard rule under test everywhere here: nothing throws, nothing hangs,
// and a repo that cannot have a graph behaves exactly like one that never
// opted in — except that the failure is recorded and loggable.

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

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-gsvc-"));
  Bun.spawnSync(["git", "-C", root, "init"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return root;
}

async function installFakeMcp(ignoreSigterm = false): Promise<void> {
  const bin = join(hiveHome, "tools", "graphify", graphifyPin());
  await mkdir(bin, { recursive: true });
  const source = [
    `#!${process.execPath}`,
    "const flag = process.argv.indexOf('--port');",
    "const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[flag + 1]), fetch: () => new Response('', { status: 406 }) });",
    ignoreSigterm
      ? "process.on('SIGTERM', () => {});"
      : "process.on('SIGTERM', () => { server.stop(true); process.exit(0); });",
    "",
  ].join("\n");
  const path = join(bin, "graphify-mcp");
  await writeFile(path, source);
  await chmod(path, 0o755);
}

describe("GraphifyService", () => {
  test("a repo that never opted in: start is a no-op, url stays null", async () => {
    const root = await gitRepo();
    const calls: string[][] = [];
    const service = new GraphifyService(root, async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }, () => {});
    await service.start();
    expect(service.serverUrl()).toBeNull();
    expect(calls).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("enabled but not installed: loud lastError, no throw, no url", async () => {
    const root = await gitRepo();
    await writeGraphifyState(root, { enabled: true, pin: "0.9.12" });
    const logged: string[] = [];
    const service = new GraphifyService(
      root,
      async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      (line) => logged.push(line),
    );
    await service.start();
    expect(service.serverUrl()).toBeNull();
    expect(service.status().lastError).toContain("not installed");
    expect(logged.length).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  test("rebuilds coalesce: many landings in a burst queue one follow-up", async () => {
    const root = await gitRepo();
    // Never enabled, so the queued rebuild reads state and stops — what is
    // being counted is how many chain links a burst creates.
    const service = new GraphifyService(root, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }), () => {});
    service.scheduleRebuild();
    service.scheduleRebuild();
    service.scheduleRebuild();
    // Reaching into the private chain is deliberate: coalescing has no other
    // observable surface without a real server to restart.
    const chain = (service as unknown as { rebuildQueued: boolean });
    expect(chain.rebuildQueued).toBe(true);
    await (service as unknown as { rebuildChain: Promise<void> }).rebuildChain;
    expect(chain.rebuildQueued).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("stop with nothing running resolves quietly", async () => {
    const root = await gitRepo();
    const service = new GraphifyService(root);
    await service.stop();
    expect(service.serverUrl()).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  test("stop cannot be held open by a TERM-resistant server", async () => {
    const root = await gitRepo();
    await installFakeMcp(true);
    await writeGraphifyState(root, { enabled: true, pin: "0.9.12" });
    await mkdir(join(root, "graphify-out"));
    await writeFile(join(root, "graphify-out", "graph.json"), "{}");
    const service = new GraphifyService(root, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }), () => {});
    const unrelated = Bun.spawn(["/bin/sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let child: Subprocess | null = null;
    try {
      await service.start();
      child = (service as unknown as { child: Subprocess }).child;
      expect(() => process.kill(child!.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();

      const stopping = service.stop();
      const stopped = await Promise.race([
        stopping.then(() => true),
        Bun.sleep(500).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await stopping;
      }

      expect(stopped).toBe(true);
      expect(() => process.kill(child!.pid, 0)).toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(service.serverUrl()).toBeNull();
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebuild keeps the advertised endpoint stable; a crash withdraws it", async () => {
    const root = await gitRepo();
    await installFakeMcp();
    await writeGraphifyState(root, { enabled: true, pin: "0.9.12" });
    await mkdir(join(root, "graphify-out"));
    await writeFile(join(root, "graphify-out", "graph.json"), "{}");
    const logged: string[] = [];
    const service = new GraphifyService(
      root,
      async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      (line) => logged.push(line),
    );

    await service.start();
    const firstUrl = service.serverUrl();
    expect(firstUrl).not.toBeNull();
    expect((await fetch(firstUrl as string)).status).toBe(406);

    service.scheduleRebuild();
    await (service as unknown as { rebuildChain: Promise<void> }).rebuildChain;
    expect(service.serverUrl()).toBe(firstUrl);
    expect((await fetch(firstUrl as string)).status).toBe(406);

    const child = (service as unknown as { child: Subprocess }).child;
    child.kill();
    await child.exited;
    await Bun.sleep(0);
    expect(service.serverUrl()).toBeNull();
    expect(logged.some((line) => line.includes("agents spawn without graph tools"))).toBe(true);

    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
});
