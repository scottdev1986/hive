#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type DaemonProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface LiveDaemon {
  readonly pid: number;
  readonly port: number;
  readonly handshake: Record<string, unknown>;
}

interface OrchestrationEvidence {
  readonly model: string;
  readonly marker: string;
  readonly spawn: unknown;
  readonly observedStatuses: string[];
  readonly message: { from: string; to: string; body: string };
  readonly killed: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const recordPath = resolve(
  process.argv[2] ?? join(import.meta.dir, "evidence", "live-isolation.json"),
);

function run(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.map((part) => JSON.stringify(part)).join(" ")} exited ${result.exitCode}: ` +
        result.stderr.toString().trim(),
    );
  }
  return result.stdout.toString().trim();
}

function startDaemon(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): DaemonProcess {
  return Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForDaemon(
  process: DaemonProcess,
  hiveHome: string,
): Promise<LiveDaemon> {
  const portPath = join(hiveHome, "daemon.port");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (process.exitCode !== null) {
      const stderr = await new Response(process.stderr).text();
      throw new Error(`daemon ${process.pid} exited ${process.exitCode}: ${stderr.trim()}`);
    }
    const port = Number.parseInt(
      await readFile(portPath, "utf8").catch(() => ""),
      10,
    );
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        const handshake = await fetch(`http://127.0.0.1:${port}/handshake`);
        if (health.ok && handshake.ok) {
          return {
            pid: process.pid,
            port,
            handshake: await handshake.json() as Record<string, unknown>,
          };
        }
      } catch {
        // The lifecycle file is written immediately before the listener is ready.
      }
    }
    await Bun.sleep(100);
  }
  throw new Error(`daemon ${process.pid} did not become healthy within 30 seconds`);
}

async function stopDaemon(process: DaemonProcess | null): Promise<void> {
  if (process === null || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    process.exited,
    Bun.sleep(5_000).then(() => {
      throw new Error(`daemon ${process.pid} did not stop after SIGTERM`);
    }),
  ]);
}

function lsofPaths(pid: number, roots: readonly string[]): string[] {
  const output = run(["lsof", "-nP", "-p", String(pid), "-Fn"]);
  const physicalRoots = roots.map((root) => realpathSync(root));
  return output.split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter((path) => physicalRoots.some((root) =>
      path === root || path.startsWith(`${root}/`)
    ))
    .sort();
}

async function fileIdentity(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.dev}:${info.ino}`;
}

async function runtimeFileIdentities(paths: readonly string[]): Promise<string[]> {
  const identities = await Promise.all(paths.map((path) => fileIdentity(path).catch(() => null)));
  return identities.filter((identity): identity is string => identity !== null).sort();
}

async function socketFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await stat(path)).isSocket()) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

function tmuxSocketName(hiveHome: string): string {
  const suffix = createHash("sha256").update(resolve(hiveHome)).digest("hex").slice(0, 10);
  return `hive-${suffix}`;
}

function databaseCanary(bootstrapDb: string, devDb: string, marker: string): {
  bootstrapRows: string[];
  devHasCanaryTable: boolean;
  devRows: string[];
} {
  const bootstrap = new Database(bootstrapDb);
  bootstrap.exec(
    "CREATE TABLE IF NOT EXISTS bootstrap_isolation_proof " +
      "(marker TEXT PRIMARY KEY NOT NULL)",
  );
  bootstrap.query("INSERT INTO bootstrap_isolation_proof (marker) VALUES (?)").run(marker);
  const bootstrapRows = bootstrap.query(
    "SELECT marker FROM bootstrap_isolation_proof ORDER BY marker",
  ).values().flat() as string[];
  bootstrap.close();

  const dev = new Database(devDb);
  const devHasCanaryTable = dev.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' " +
      "AND name = 'bootstrap_isolation_proof'",
  ).get() !== null;
  const devRows = devHasCanaryTable
    ? dev.query("SELECT marker FROM bootstrap_isolation_proof ORDER BY marker")
      .values().flat() as string[]
    : [];
  dev.close();
  return { bootstrapRows, devHasCanaryTable, devRows };
}

function toolValue(result: Awaited<ReturnType<Client["callTool"]>>, key: string): unknown {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured?.[key] !== undefined) return structured[key];
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error(`tool response has no ${key} or text content`);
  return JSON.parse(text) as unknown;
}

async function proveOrchestration(
  launcher: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  tmuxEnv: NodeJS.ProcessEnv,
  hiveHome: string,
  port: number,
  model: string,
): Promise<OrchestrationEvidence> {
  run([launcher, "autonomy", "dangerous"], { cwd, env });
  let revision = (JSON.parse(
    run([launcher, "routing", "policy"], { cwd, env }),
  ) as { revision: number }).revision;
  const mutate = (args: string[]): void => {
    const policy = JSON.parse(run(
      [launcher, "routing", ...args, "--expect-revision", String(revision)],
      { cwd, env },
    )) as { revision: number };
    revision = policy.revision;
  };
  mutate(["set-provider", "codex", "enabled"]);
  mutate(["set-model", "codex", model, "enabled"]);
  mutate(["set-effort", "codex", model, "exact:medium"]);
  mutate(["set-selection", "choice"]);
  mutate(["set-chain", "simple_coding", `codex/${model}@medium`]);

  const token = (await readFile(join(hiveHome, "credentials", "operator.cap"), "utf8")).trim();
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    },
  );
  const client = new Client({ name: "bootstrap-live-proof", version: "1" });
  const marker = `BOOTSTRAP_E2E_${randomUUID().replaceAll("-", "_")}`;
  const observedStatuses = new Set<string>();
  const receivedMessages: Array<{ from: string; to: string; body: string }> = [];
  let latestAgents: Array<{
    name: string;
    status: string;
    tmuxSession?: string;
    failureReason?: string;
  }> = [];
  try {
    await client.connect(transport);
    const spawned = await client.callTool({
      name: "hive_spawn",
      arguments: {
        name: "bootstrapproof",
        tool: "codex",
        category: "simple_coding",
        readOnly: true,
        task:
          `Read README.md without modifying any file. Then call hive_send from ` +
          `bootstrapproof to orchestrator with the exact body ${marker}. Stop after sending.`,
      },
    });
    if (spawned.isError === true) {
      throw new Error(`hive_spawn failed: ${JSON.stringify(spawned.content)}`);
    }
    const spawn = toolValue(spawned, "agent");
    let received: { from: string; to: string; body: string } | null = null;
    for (let attempt = 0; attempt < 120 && received === null; attempt += 1) {
      const status = await client.callTool({
        name: "hive_status",
        arguments: { detail: "full" },
      });
      latestAgents = toolValue(status, "agents") as typeof latestAgents;
      for (const agent of latestAgents) {
        if (agent.name === "bootstrapproof") observedStatuses.add(agent.status);
      }
      const inbox = await client.callTool({
        name: "hive_inbox",
        arguments: { agent: "orchestrator" },
      });
      const messages = toolValue(inbox, "messages") as Array<{
        from: string;
        to: string;
        body: string;
      }>;
      receivedMessages.push(...messages);
      received = messages.find((message) => message.body === marker) ?? null;
      if (received === null) await Bun.sleep(1_000);
    }
    if (received === null) {
      const agent = latestAgents.find((candidate) => candidate.name === "bootstrapproof");
      let pane = "unavailable";
      if (agent?.tmuxSession !== undefined) {
        try {
          pane = run([
            "tmux", "-L", tmuxSocketName(hiveHome),
            "capture-pane", "-p", "-S", "-120", "-t", agent.tmuxSession,
          ], { cwd, env: tmuxEnv });
        } catch (error) {
          pane = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(`bootstrap agent delivered no exact marker: ${JSON.stringify({
        observedStatuses: [...observedStatuses],
        latestAgent: agent,
        receivedMessages,
        pane,
      })}`);
    }
    await client.close();
    const killed = run([launcher, "kill", "bootstrapproof"], { cwd, env });
    return {
      model,
      marker,
      spawn,
      observedStatuses: [...observedStatuses],
      message: received,
      killed,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const proofRoot = await mkdtemp(join(tmpdir(), "hive-bootstrap-proof-"));
  const neutralRepo = join(proofRoot, "neutral-project");
  const bootstrapRoot = join(proofRoot, "bootstrap");
  const bootstrapBin = join(proofRoot, "bin");
  const devRoot = join(proofRoot, "dev");
  const devHome = join(devRoot, "home");
  const devHiveHome = join(devRoot, "runtime");
  const devSocketRoot = await mkdtemp("/tmp/hive-dev-proof-");
  const devTmp = join(devSocketRoot, "tmp");
  const devTmuxTmp = join(devSocketRoot, "tmux");
  const bootstrapPrivateRoot = join(bootstrapRoot, "state", "0.0.37");
  const bootstrapHome = join(bootstrapPrivateRoot, "home");
  const bootstrapHiveHome = join(bootstrapPrivateRoot, "runtime");
  const bootstrapNamespace = createHash("sha256")
    .update(bootstrapRoot).digest("hex").slice(0, 10);
  const bootstrapSocketRoot = `/tmp/hive-bootstrap-${process.getuid?.() ?? 0}-${bootstrapNamespace}`;
  const bootstrapTmp = join(bootstrapSocketRoot, "tmp");
  const bootstrapTmuxTmp = join(bootstrapSocketRoot, "tmux");
  const launcher = join(bootstrapBin, "hive-bootstrap");
  const currentCli = join(repoRoot, "src", "cli.ts");
  const marker = `bootstrap-only-${randomUUID()}`;
  const bootstrapSession = `bootstrap-${randomUUID().slice(0, 8)}`;
  const devSession = `dev-${randomUUID().slice(0, 8)}`;
  let bootstrapDaemon: DaemonProcess | null = null;
  let devDaemon: DaemonProcess | null = null;
  const orchestrationRequested = process.env.HIVE_BOOTSTRAP_ORCHESTRATION === "1";
  let orchestration: OrchestrationEvidence | null = null;

  const bootstrapControlEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HIVE_BOOTSTRAP_ROOT: bootstrapRoot,
    HIVE_BOOTSTRAP_BIN_DIR: bootstrapBin,
    HIVE_PROJECT_ROOT: neutralRepo,
  };
  const bootstrapRuntimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: bootstrapHome,
    HIVE_HOME: bootstrapHiveHome,
    HIVE_PORT: "0",
    HIVE_PROJECT_ROOT: neutralRepo,
    TMPDIR: bootstrapTmp,
    TMP: bootstrapTmp,
    TEMP: bootstrapTmp,
    TMUX_TMPDIR: bootstrapTmuxTmp,
    XDG_CONFIG_HOME: join(bootstrapHome, ".config"),
    XDG_CACHE_HOME: join(bootstrapHome, ".cache"),
    XDG_DATA_HOME: join(bootstrapHome, ".local", "share"),
    XDG_STATE_HOME: join(bootstrapHome, ".local", "state"),
  };
  const devEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: devHome,
    HIVE_HOME: devHiveHome,
    HIVE_PORT: "0",
    HIVE_PROJECT_ROOT: neutralRepo,
    TMPDIR: devTmp,
    TMP: devTmp,
    TEMP: devTmp,
    TMUX_TMPDIR: devTmuxTmp,
    XDG_CONFIG_HOME: join(devHome, ".config"),
    XDG_CACHE_HOME: join(devHome, ".cache"),
    XDG_DATA_HOME: join(devHome, ".local", "share"),
    XDG_STATE_HOME: join(devHome, ".local", "state"),
  };

  try {
    await mkdir(neutralRepo, { recursive: true });
    await mkdir(bootstrapBin, { recursive: true });
    await Promise.all([
      mkdir(devHome, { recursive: true }),
      mkdir(devHiveHome, { recursive: true }),
      mkdir(devTmp, { recursive: true }),
      mkdir(devTmuxTmp, { recursive: true }),
    ]);
    run(["git", "init", "-b", "main"], { cwd: neutralRepo });
    await writeFile(join(neutralRepo, "README.md"), "# Neutral bootstrap proof\n");
    run(["git", "add", "README.md"], { cwd: neutralRepo });
    run(["git", "-c", "user.name=Hive proof", "-c", "user.email=proof@hive.local",
      "commit", "-m", "neutral fixture", "--no-gpg-sign"], { cwd: neutralRepo });

    const installOutput = run([join(import.meta.dir, "hive-bootstrap"), "install"], {
      env: bootstrapControlEnv,
    });
    const reinstallOutput = run([launcher, "install"], { env: bootstrapControlEnv });
    const pin = run([launcher, "pin"], { env: bootstrapControlEnv });
    const verifiedPin = run([launcher, "verify"], { env: bootstrapControlEnv });
    const bootstrapVersion = run([launcher, "--version"], {
      cwd: neutralRepo,
      env: bootstrapControlEnv,
    });
    const devVersion = run([process.execPath, currentCli, "--version"], {
      cwd: neutralRepo,
      env: devEnv,
    });

    if (orchestrationRequested) {
      const authSource = join(process.env.HOME ?? "", ".codex", "auth.json");
      const authTarget = join(bootstrapHome, ".codex", "auth.json");
      await mkdir(dirname(authTarget), { recursive: true });
      await copyFile(authSource, authTarget);
      await chmod(authTarget, 0o600);
      const trustedRepo = realpathSync(neutralRepo).replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      await writeFile(
        join(dirname(authTarget), "config.toml"),
        `[projects."${trustedRepo}"]\ntrust_level = "trusted"\n`,
        { mode: 0o600 },
      );
    }

    bootstrapDaemon = startDaemon([launcher, "daemon"], neutralRepo, bootstrapControlEnv);
    devDaemon = startDaemon([process.execPath, currentCli, "daemon"], neutralRepo, devEnv);
    const [bootstrapLive, devLive] = await Promise.all([
      waitForDaemon(bootstrapDaemon, bootstrapHiveHome),
      waitForDaemon(devDaemon, devHiveHome),
    ]);

    const memoryWrite = run([
      launcher, "memory", "write", "Bootstrap isolation marker",
      "--scope", "global",
      "--topic", "bootstrap-isolation-proof",
      "--body", marker,
      "--source", "human",
      "--evidence", "M1-BOOT simultaneous live positive control",
      "--status", "verified",
      "--supersedes", "",
      "--verified", new Date().toISOString().slice(0, 10),
    ], { cwd: neutralRepo, env: bootstrapControlEnv });
    const bootstrapMemorySearch = run([launcher, "memory", "search", marker], {
      cwd: neutralRepo,
      env: bootstrapControlEnv,
    });
    const devMemorySearch = run([process.execPath, currentCli, "memory", "search", marker], {
      cwd: neutralRepo,
      env: devEnv,
    });

    if (orchestrationRequested) {
      const model = process.env.HIVE_BOOTSTRAP_CODEX_MODEL;
      if (model === undefined || model.length === 0) {
        throw new Error("HIVE_BOOTSTRAP_CODEX_MODEL is required for orchestration proof");
      }
      orchestration = await proveOrchestration(
        launcher,
        neutralRepo,
        bootstrapControlEnv,
        bootstrapRuntimeEnv,
        bootstrapHiveHome,
        bootstrapLive.port,
        model,
      );
    }

    const bootstrapDb = join(bootstrapHiveHome, "hive.db");
    const devDb = join(devHiveHome, "hive.db");
    const bootstrapQuotaDb = join(bootstrapHome, ".hive", "quota.db");
    const devQuotaDb = join(devHome, ".hive", "quota.db");
    const dbCanary = databaseCanary(bootstrapDb, devDb, marker);

    const bootstrapSocketName = tmuxSocketName(bootstrapHiveHome);
    const devSocketName = tmuxSocketName(devHiveHome);
    run(["tmux", "-L", bootstrapSocketName, "new-session", "-d", "-s",
      bootstrapSession, "sleep", "300"], { cwd: neutralRepo, env: bootstrapRuntimeEnv });
    run(["tmux", "-L", devSocketName, "new-session", "-d", "-s",
      devSession, "sleep", "300"], { cwd: neutralRepo, env: devEnv });
    const bootstrapSessions = run(
      ["tmux", "-L", bootstrapSocketName, "list-sessions", "-F", "#{session_name}"],
      { env: bootstrapRuntimeEnv },
    ).split("\n");
    const devSessions = run(
      ["tmux", "-L", devSocketName, "list-sessions", "-F", "#{session_name}"],
      { env: devEnv },
    ).split("\n");
    const [bootstrapSockets, devSockets] = await Promise.all([
      socketFiles(bootstrapTmuxTmp),
      socketFiles(devTmuxTmp),
    ]);

    const bootstrapOpenFiles = lsofPaths(
      bootstrapLive.pid,
      [bootstrapPrivateRoot, bootstrapSocketRoot],
    );
    const devOpenFiles = lsofPaths(devLive.pid, [devRoot, devSocketRoot]);
    const [bootstrapOpenInodes, devOpenInodes] = await Promise.all([
      runtimeFileIdentities(bootstrapOpenFiles),
      runtimeFileIdentities(devOpenFiles),
    ]);
    const sharedRuntimeInodes = bootstrapOpenInodes.filter((identity) =>
      devOpenInodes.includes(identity)
    );
    const [bootstrapDbIdentity, devDbIdentity] = await Promise.all([
      readFile(join(bootstrapHiveHome, "hive.db.identity"), "utf8"),
      readFile(join(devHiveHome, "hive.db.identity"), "utf8"),
    ]);
    const [bootstrapSocketInodes, devSocketInodes] = await Promise.all([
      Promise.all(bootstrapSockets.map(fileIdentity)),
      Promise.all(devSockets.map(fileIdentity)),
    ]);

    const assertions = {
      pinnedVersionExact: bootstrapVersion.startsWith("hive 0.0.37 (40c4efa,"),
      pinVerifiedOnReadback: verifiedPin === pin,
      simultaneousDaemonsHealthy: bootstrapDaemon.exitCode === null && devDaemon.exitCode === null,
      portsDistinct: bootstrapLive.port !== devLive.port,
      instanceIdsDistinct:
        bootstrapLive.handshake.instanceId !== devLive.handshake.instanceId,
      databaseFilesDistinct: await fileIdentity(bootstrapDb) !== await fileIdentity(devDb),
      databaseIdentitiesDistinct: bootstrapDbIdentity.trim() !== devDbIdentity.trim(),
      quotaDatabaseFilesDistinct:
        await fileIdentity(bootstrapQuotaDb) !== await fileIdentity(devQuotaDb),
      noSharedOpenRuntimeInodes: sharedRuntimeInodes.length === 0,
      bootstrapDatabaseCanaryVisible:
        dbCanary.bootstrapRows.length === 1 && dbCanary.bootstrapRows[0] === marker,
      devDatabaseCanaryInvisible:
        !dbCanary.devHasCanaryTable && dbCanary.devRows.length === 0,
      openRuntimeFilesObserved:
        bootstrapOpenFiles.some((path) => path === realpathSync(bootstrapDb)) &&
        bootstrapOpenFiles.some((path) => path === realpathSync(bootstrapQuotaDb)) &&
        devOpenFiles.some((path) => path === realpathSync(devDb)) &&
        devOpenFiles.some((path) => path === realpathSync(devQuotaDb)),
      bootstrapMemoryWriteVisible:
        bootstrapMemorySearch.includes("Bootstrap isolation marker") &&
        bootstrapMemorySearch !== "no matching memory articles",
      devMemoryWriteInvisible: devMemorySearch === "no matching memory articles",
      socketNamesDistinct: bootstrapSocketName !== devSocketName,
      socketFilesDistinct:
        bootstrapSocketInodes.length > 0 && devSocketInodes.length > 0 &&
        bootstrapSocketInodes.every((identity) => !devSocketInodes.includes(identity)),
      socketSessionsCrossInvisible:
        bootstrapSessions.includes(bootstrapSession) && !bootstrapSessions.includes(devSession) &&
        devSessions.includes(devSession) && !devSessions.includes(bootstrapSession),
      neutralProjectHasNoHivePackage:
        !(await readdir(neutralRepo)).includes("package.json") &&
        basename(neutralRepo) === "neutral-project",
      ...(orchestrationRequested
        ? {
            orchestrationEndToEnd:
              orchestration !== null &&
              orchestration.message.body === orchestration.marker &&
              orchestration.observedStatuses.length > 0,
          }
        : {}),
    };
    const passed = Object.values(assertions).every(Boolean);
    const evidence = {
      schema: 1,
      story: "M1-BOOT",
      recordedAt: new Date().toISOString(),
      passed,
      pin: Object.fromEntries(pin.split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })),
      installOutput,
      reinstallOutput,
      versions: { bootstrap: bootstrapVersion, dev: devVersion },
      neutralProject: { path: neutralRepo, head: run(["git", "rev-parse", "HEAD"], { cwd: neutralRepo }) },
      bootstrap: {
        ...bootstrapLive,
        home: bootstrapHome,
        hiveHome: bootstrapHiveHome,
        database: { path: bootstrapDb, inode: await fileIdentity(bootstrapDb), identity: bootstrapDbIdentity.trim() },
        quotaDatabase: { path: bootstrapQuotaDb, inode: await fileIdentity(bootstrapQuotaDb) },
        openRuntimeFiles: bootstrapOpenFiles,
        socket: { name: bootstrapSocketName, files: bootstrapSockets, inodes: bootstrapSocketInodes, sessions: bootstrapSessions },
      },
      dev: {
        ...devLive,
        home: devHome,
        hiveHome: devHiveHome,
        database: { path: devDb, inode: await fileIdentity(devDb), identity: devDbIdentity.trim() },
        quotaDatabase: { path: devQuotaDb, inode: await fileIdentity(devQuotaDb) },
        openRuntimeFiles: devOpenFiles,
        socket: { name: devSocketName, files: devSockets, inodes: devSocketInodes, sessions: devSessions },
      },
      positiveControls: {
        marker,
        memoryWrite,
        bootstrapMemorySearch,
        devMemorySearch,
        database: dbCanary,
      },
      orchestration,
      sharedRuntimeInodes,
      assertions,
      externalContracts: {
        releaseAssetDigest: "https://docs.github.com/en/rest/releases/assets",
        tmuxIndependentServers: "https://man.openbsd.org/tmux.1",
        sqliteDatabaseInspection: "https://sqlite.org/pragma.html#pragma_database_list",
      },
    };
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(evidence, null, 2)}\n`);
    const readBack = JSON.parse(await readFile(recordPath, "utf8")) as { passed?: boolean };
    if (!passed || readBack.passed !== true) {
      throw new Error(`live isolation proof failed; inspect ${recordPath}`);
    }
    console.log(`M1-BOOT live isolation proof passed: ${recordPath}`);
  } finally {
    Bun.spawnSync(["tmux", "-L", tmuxSocketName(bootstrapHiveHome), "kill-server"], {
      env: bootstrapRuntimeEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    Bun.spawnSync(["tmux", "-L", tmuxSocketName(devHiveHome), "kill-server"], {
      env: devEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    await Promise.allSettled([stopDaemon(bootstrapDaemon), stopDaemon(devDaemon)]);
    await Promise.all([
      rm(proofRoot, { recursive: true, force: true }),
      rm(devSocketRoot, { recursive: true, force: true }),
      rm(bootstrapSocketRoot, { recursive: true, force: true }),
    ]);
  }
}

await main();
