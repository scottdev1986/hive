/**
 * The daemon-owned per-repo graphify MCP server
 * (docs/graphify/integration.md, "One server per repo").
 *
 * One HTTP instance per repository, held (not detached) so it dies with the
 * daemon and can never leak; restarted after each successful rebuild so every
 * agent queries the current graph. The contract callers rely on:
 *
 *   - `serverUrl()` is the only thing spawns read: a URL when the server is
 *     up, null otherwise. A spawn that gets null attaches nothing — a dead
 *     server in an agent's MCP config would cost every agent a
 *     connect-timeout, so absence is the honest degradation.
 *   - Nothing here is awaited by spawn or landing paths. `start()` and
 *     `scheduleRebuild()` are fire-and-forget; failures land in `lastError`
 *     and the daemon log, never in a caller's latency.
 */
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import {
  graphJsonPath,
  graphifyMcpBin,
  buildGraph,
  runCommand,
  scrubbedGraphifyEnv,
  servingGraphPath,
  snapshotGraphForServing,
  updateGraph,
  type CommandRunner,
} from "../adapters/graphify";

const READINESS_TIMEOUT_MS = 15_000;

export interface GraphifyServiceStatus {
  running: boolean;
  url: string | null;
  lastError: string | null;
}

async function stopSubprocess(child: Subprocess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await child.exited;
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Could not verify graphify server ${child.pid} stopped`);
  }
}

export class GraphifyService {
  private child: Subprocess | null = null;
  private port: number | null = null;
  private lastError: string | null = null;
  /** Rebuilds are serialized: one runs, at most one more is queued. A landing
   * during a rebuild coalesces into that single follow-up. */
  private rebuildChain: Promise<void> = Promise.resolve();
  private rebuildQueued = false;

  constructor(
    private readonly repoRoot: string,
    private readonly run: CommandRunner = runCommand,
    private readonly log: (line: string) => void = (line) =>
      console.error(line),
  ) {}

  /** What a spawn attaches, or null. Never blocks, never throws. */
  serverUrl(): string | null {
    return this.child !== null && this.port !== null
      ? `http://127.0.0.1:${this.port}/mcp`
      : null;
  }

  status(): GraphifyServiceStatus {
    return {
      running: this.child !== null,
      url: this.serverUrl(),
      lastError: this.lastError,
    };
  }

  /** Bring the required server up. Missing graph? Build it in the background
   * first so startup never waits on graph extraction. */
  async start(): Promise<void> {
    if (!existsSync(graphifyMcpBin())) {
      this.lastError = "required runtime not installed — run `hive graphify enable`";
      this.log(`graphify: ${this.lastError}`);
      return;
    }
    if (!existsSync(graphJsonPath(this.repoRoot))) {
      const built = await buildGraph(this.repoRoot, this.run);
      if (!built.ok) {
        this.lastError = built.reason;
        this.log(`graphify: initial build failed — agents run without graph context: ${built.reason}`);
        return;
      }
    }
    await this.startServer();
  }

  async stop(): Promise<void> {
    const child = this.child;
    const port = this.port;
    this.child = null;
    if (child !== null) {
      await stopSubprocess(child);
    }
    // Keep the repo's endpoint stable across a rebuild. Agent MCP configs are
    // fixed at spawn time; choosing a fresh port here strands every live agent
    // on the old URL even when the replacement server is healthy.
    this.port = port;
  }

  /** Called after every successful landing. Fire-and-forget by design: the
   * land response is already on the wire when this runs. */
  scheduleRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    this.rebuildChain = this.rebuildChain
      .then(async () => {
        this.rebuildQueued = false;
        if (!existsSync(graphifyMcpBin())) return;
        const updated = await updateGraph(this.repoRoot, this.run);
        if (!updated.ok) {
          this.lastError = updated.reason;
          this.log(`graphify: incremental rebuild failed — serving the previous graph: ${updated.reason}`);
          return;
        }
        // Only a rebuild that exited 0 earns a restart; the old process keeps
        // serving the last good graph through the swap.
        await this.stop();
        await this.startServer();
      })
      .catch((error) => {
        this.rebuildQueued = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log(`graphify: rebuild crashed: ${this.lastError}`);
      });
  }

  private async startServer(): Promise<void> {
    // Serve a snapshot, never the live graphify-out/graph.json: the server
    // re-reads its graph file per query, and rebuilds rewrite the live file
    // in place — an agent querying mid-rebuild would get "graph.json not
    // found" from a perfectly healthy server. Snapshot failure (exotic:
    // disk full) degrades to the old serve-the-live-file behavior, noted.
    const snapshot = await snapshotGraphForServing(this.repoRoot);
    if (!snapshot.ok) {
      this.log(`graphify: ${snapshot.reason}; serving the live graph file`);
    }
    const port = this.port ?? await freeLoopbackPort();
    const child = Bun.spawn(
      [
        graphifyMcpBin(),
        "--graph",
        snapshot.ok ? servingGraphPath(this.repoRoot) : graphJsonPath(this.repoRoot),
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: this.repoRoot,
        env: scrubbedGraphifyEnv(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    // Hold the process before waiting for readiness. The URL remains hidden
    // because port is not published until the probe succeeds, while an exit
    // between the successful probe and publication can now clear this handle
    // instead of leaving a dead child advertised.
    this.child = child;
    this.port = null;
    // An early exit (bad graph, stolen port) must not leave a corpse handle
    // that serverUrl() advertises forever.
    void child.exited.then(() => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.lastError = "graphify MCP server exited";
        this.log("graphify: MCP server exited — agents spawn without graph tools until the next rebuild or daemon start");
      }
    });

    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        // Any HTTP response proves the transport is up; the MCP handshake
        // itself is each client's business.
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "GET",
          signal: AbortSignal.timeout(1_000),
        });
        if (this.child !== child || child.exitCode !== null) break;
        this.port = port;
        this.lastError = null;
        this.log(`graphify: MCP server serving ${graphJsonPath(this.repoRoot)} on 127.0.0.1:${port}`);
        return;
      } catch {
        await Bun.sleep(250);
      }
    }
    if (this.child === child) this.child = null;
    await stopSubprocess(child);
    this.lastError = "graphify MCP server never became ready";
    this.log(`graphify: ${this.lastError} — agents run without graph tools`);
  }
}

/** Ask the OS for a free loopback port by binding one and letting it go. The
 * race between close and reuse is real but loses only a startup, which the
 * readiness poll reports loudly. */
async function freeLoopbackPort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}
