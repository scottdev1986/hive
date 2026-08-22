// Runs tests on a unique size-capped volume and denies writes anywhere else.
// Every invocation owns its image and mount, so cleanup trouble can leave
// bounded residue but cannot block another worktree or test mode.
// This boundary covers commands launched through this runner. It cannot contain
// arbitrary shell commands an agent runs outside it, and it does not wrap the
// native Zig suite that package.json starts after the guarded Bun suite. The
// native gate routes its Bun-only tail through this runner separately.

import { isNumber, isRecord, isString } from "../src/shared/is-record";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HDIUTIL = "/usr/bin/hdiutil";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_IMAGE_SIZE = "1g";
const REPO_ROOT = resolve(import.meta.dir, "..");
const DETACH_DEADLINE_MS = 2_000;

function sandboxScratchRoot(): string {
  return process.env.HIVE_TEST_ROOT ?? "/tmp";
}

// One preserved timeout sandbox per invocation key. A new timeout evicts the
// previous image for that key so 1 GB residues cannot accumulate. Nested
// callers (bun test inside this runner) must scratch on HIVE_TEST_ROOT
// because the outer profile denies writes to /tmp.
export function preservedSandboxRoot(): string {
  return join(sandboxScratchRoot(), "hv-timeout");
}

// The suite starts from a closed environment. These are either ordinary
// process facts needed by macOS tools or explicit opt-in test modes. Product
// controls and credentials never belong in a test process by inheritance.
const INHERITED_TEST_ENV_NAMES = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "SHELL",
  "TERM",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  "HIVE_ACP_LIVE",
  "HIVE_CLAUDE_LIVE",
  "HIVE_CODEX_LIVE",
  "HIVE_DURABLE_RESUME_LIVE",
  "HIVE_LIVE_CAPABILITIES",
  "HIVE_LIVE_MEMORY_EMBEDDINGS",
  "HIVE_USAGE_PARITY_LIVE",
  "HIVE_WRITE_EVIDENCE",
  "HIVE_LIVE_GROK_AUTH_FILE",
  "HIVE_LIVE_GROK_CONFIG_FILE",
  "HIVE_LIVE_CLAUDE_CREDENTIAL_FILE",
  "HIVE_LIVE_CLAUDE_CONFIG_FILE",
  "HIVE_LIVE_KIMI_AUTH_FILE",
  "HIVE_LIVE_KIMI_OAUTH_FILE",
  "HIVE_LIVE_KIMI_CONFIG_FILE",
  "HIVE_LIVE_CODEX_AUTH_FILE",
  "HIVE_LIVE_CODEX_CONFIG_FILE",
  "HIVE_LIVE_OPENCODE_AUTH_FILE",
] as const;

interface RootPaths {
  readonly base: string;
  readonly imageBase: string;
  readonly image: string;
  readonly mount: string;
  readonly outside: string;
}

interface RunOptions {
  readonly key: string;
  readonly imageSize: string;
  readonly maxBytes: number;
  readonly cwd?: string;
  readonly beforeRun?: (root: string) => void | Promise<void>;
  readonly deadlineMs?: number;
  readonly waitingFor?: string;
  readonly cleanup?: (base: string) => Promise<void>;
}

export class SandboxTimeoutError extends Error {
  readonly deadlineMs: number;
  readonly waitingFor: string;
  readonly preservedPath: string;

  constructor(deadlineMs: number, waitingFor: string, preservedPath: string) {
    super(
      `timed out after ${deadlineMs}ms waiting for ${waitingFor}\npreserved sandbox: ${preservedPath}`,
    );
    this.name = "SandboxTimeoutError";
    this.deadlineMs = deadlineMs;
    this.waitingFor = waitingFor;
    this.preservedPath = preservedPath;
  }
}

export function preservedSandboxPointer(key: string): string {
  return join(preservedSandboxRoot(), key);
}

export function readPreservedSandboxBase(key: string): string | null {
  const pointer = preservedSandboxPointer(key);
  if (!existsSync(pointer)) return null;
  const base = readFileSync(pointer, "utf8").trim();
  return base.length > 0 ? base : null;
}

export async function releasePreservedSandbox(key: string): Promise<void> {
  const base = readPreservedSandboxBase(key);
  if (base !== null) await cleanupSandboxBase(base);
  const pointer = preservedSandboxPointer(key);
  if (existsSync(pointer)) await rm(pointer, { force: true });
}

async function createTestSandboxPaths(): Promise<RootPaths> {
  const base = await mkdtemp(join(sandboxScratchRoot(), "hv-"));
  return {
    base,
    imageBase: join(base, "v"),
    image: join(base, "v.sparseimage"),
    // Sessiond creates a socket below this root. Keep the mount name short so
    // that production socket paths stay within macOS's AF_UNIX limit.
    mount: join(base, "m"),
    outside: join(base, "outside"),
  };
}

async function runCommand(
  argv: string[],
  options: { quiet?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const child = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    stdout: options.quiet === true ? "ignore" : "inherit",
    stderr: options.quiet === true ? "ignore" : "inherit",
  });
  return child.exited;
}

async function detach(paths: RootPaths): Promise<boolean> {
  if (!existsSync(paths.mount)) return true;
  if (statSync(paths.mount).dev === statSync(resolve(paths.mount, "..")).dev) {
    return true;
  }
  const child = Bun.spawn([HDIUTIL, "detach", "-quiet", paths.mount], {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(DETACH_DEADLINE_MS).then(() => null),
  ]);
  if (result === null) {
    child.kill();
    return false;
  }
  return result.exitCode === 0;
}

function pathsFromBase(base: string): RootPaths {
  return {
    base,
    imageBase: join(base, "v"),
    image: join(base, "v.sparseimage"),
    mount: join(base, "m"),
    outside: join(base, "outside"),
  };
}

async function cleanupTestSandbox(paths: RootPaths): Promise<void> {
  try {
    if (!(await detach(paths))) return;
    await rm(paths.base, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort. A unique orphan costs bounded disk space but
    // cannot block another invocation, and cleanup must not change test truth.
  }
}

async function cleanupSandboxBase(base: string): Promise<void> {
  await cleanupTestSandbox(pathsFromBase(base));
}

async function preserveTimedOutSandbox(
  paths: RootPaths,
  key: string,
  cleanup: (base: string) => Promise<void>,
): Promise<string> {
  await mkdir(preservedSandboxRoot(), { recursive: true });
  const pointer = preservedSandboxPointer(key);
  const previous = readPreservedSandboxBase(key);
  await writeFile(pointer, `${paths.base}\n`);
  if (previous !== null && previous !== paths.base) {
    await cleanup(previous);
  }
  return realpathSync(paths.mount);
}

function assertBoundedVolume(root: string, maxBytes: number): void {
  const stats = statfsSync(root, { bigint: true });
  const volumeBytes = stats.bsize * stats.blocks;
  if (volumeBytes > BigInt(maxBytes)) {
    throw new Error(
      `test volume is ${volumeBytes} bytes, above its ${maxBytes}-byte ceiling`,
    );
  }
}

async function initializeVolumeRoot(root: string): Promise<void> {
  // Keep the marker as a second, inspectable guard even though hdiutil creates
  // the image with -nospotlight before attaching it.
  await writeFile(join(root, ".metadata_never_index"), "");
  await Promise.all(
    ["tmp", "home", "cache", "config", "data", "zig-global", "zig-local"].map(
      (name) => mkdir(join(root, name), { recursive: true }),
    ),
  );
  await createProcessListProxy(root);
  await createMktempWrapper(root);
}

async function createVolume(
  paths: RootPaths,
  options: RunOptions,
): Promise<void> {
  await Promise.all([mkdir(paths.mount), mkdir(paths.outside)]);
  const createCode = await runCommand(
    [
      HDIUTIL,
      "create",
      "-quiet",
      "-size",
      options.imageSize,
      "-fs",
      "APFS",
      "-type",
      "SPARSE",
      "-nospotlight",
      "-volname",
      `hive-tests-${options.key}`,
      paths.imageBase,
    ],
    { quiet: true },
  );
  if (createCode !== 0)
    throw new Error("could not create the bounded test volume");
  const attachCode = await runCommand(
    [
      HDIUTIL,
      "attach",
      "-quiet",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      paths.mount,
      paths.image,
    ],
    { quiet: true },
  );
  if (attachCode !== 0)
    throw new Error("could not attach the bounded test volume");

  const root = realpathSync(paths.mount);
  assertBoundedVolume(root, options.maxBytes);
  await initializeVolumeRoot(root);
}

// macOS refuses its setuid /bin/ps inside sandbox-exec. The suite needs real
// process tables, so the unsandboxed runner performs that read-only command and
// returns its bytes through a socket inside the controlled root.
async function createProcessListProxy(root: string): Promise<void> {
  const socket = join(root, "ps.sock");
  const script = join(root, "ps");
  await writeFile(
    script,
    `#!/bin/sh\nexec bun -e 'import { readFileSync, unlinkSync } from "node:fs"; const socket = process.argv[1]; const args = process.argv.slice(2); let response = ""; const client = await Bun.connect({ unix: socket, socket: { data(_socket, data) { response += data.toString(); }, open(socket) { socket.write(JSON.stringify({ id: process.pid, args })); }, close() { try { process.stdout.write(readFileSync(response)); unlinkSync(response); process.exit(0); } catch (error) { console.error(error.message); process.exit(1); } }, error(_socket, error) { console.error(error.message); process.exit(1); } } }); await client.closed;' ${JSON.stringify(socket)} "$@"\n`,
  );
  await chmod(script, 0o755);
}

async function createMktempWrapper(root: string): Promise<void> {
  const script = join(root, "mktemp");
  await writeFile(
    script,
    `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "-d" ]; then exec /usr/bin/mktemp -d "${join(root, "tmp", "tmp.XXXXXXXXXX")}"; fi\nexec /usr/bin/mktemp "$@"\n`,
  );
  await chmod(script, 0o755);
}

function sandboxProfile(root: string): string {
  return `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "/dev") (subpath ${JSON.stringify(root)}))`;
}

function testEnvironment(paths: RootPaths, root: string, maxBytes: number) {
  const inherited: Record<string, string> = {};
  for (const name of INHERITED_TEST_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return {
    ...inherited,
    HIVE_TEST_ROOT: root,
    HIVE_TEST_ROOT_MAX_BYTES: String(maxBytes),
    HIVE_TEST_OUTSIDE_PATH: paths.outside,
    HIVE_HOME: join(root, "home", "hive"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
    ZIG_GLOBAL_CACHE_DIR: join(root, "zig-global"),
    ZIG_LOCAL_CACHE_DIR: join(root, "zig-local"),
    PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
}

function startProcessListServer(root: string): ReturnType<typeof Bun.listen> {
  return Bun.listen({
    unix: join(root, "ps.sock"),
    socket: {
      data(socket, data) {
        let request: unknown;
        try {
          request = JSON.parse(data.toString());
        } catch {
          socket.end("invalid ps request\n");
          return;
        }
        if (
          !isRecord(request) ||
          !("id" in request) ||
          !isNumber(request.id) ||
          !Number.isSafeInteger(request.id) ||
          request.id <= 0 ||
          !("args" in request) ||
          !Array.isArray(request.args)
        ) {
          socket.end("invalid ps arguments\n");
          return;
        }
        const args = request.args.filter(isString);
        if (args.length !== request.args.length) {
          socket.end("invalid ps arguments\n");
          return;
        }
        const result = Bun.spawnSync(["/bin/ps", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const response = join(root, `ps-output-${request.id}`);
        writeFileSync(response, Buffer.concat([result.stdout, result.stderr]));
        socket.end(response);
      },
    },
  });
}

async function stopProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // SAFETY: The surrounding code already established this contract.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runInBoundedTestRoot(
  command: string[],
  options: RunOptions,
): Promise<number> {
  if (process.platform !== "darwin") {
    throw new Error("the fail-closed test filesystem sandbox requires macOS");
  }
  if (!existsSync(HDIUTIL) || !existsSync(SANDBOX_EXEC)) {
    throw new Error("the fail-closed test filesystem sandbox is unavailable");
  }
  if (command.length === 0) throw new Error("no test command was supplied");
  if (!/^[a-z0-9-]+$/.test(options.key)) {
    throw new Error(`invalid test-root key: ${options.key}`);
  }
  if (options.deadlineMs !== undefined && options.deadlineMs <= 0) {
    throw new Error("deadlineMs must be a positive number of milliseconds");
  }
  if (options.deadlineMs !== undefined && options.waitingFor === undefined) {
    throw new Error("a named deadline requires waitingFor");
  }

  const paths = await createTestSandboxPaths();
  const cleanup = options.cleanup ?? cleanupSandboxBase;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let processListServer: ReturnType<typeof Bun.listen> | undefined;
  let timedOut = false;
  let timeoutError: SandboxTimeoutError | undefined;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal: NodeJS.Signals): void => {
    if (child !== undefined) void stopProcessGroup(child.pid, signal);
  };
  try {
    await createVolume(paths, options);
    const root = realpathSync(paths.mount);
    await options.beforeRun?.(root);
    processListServer = startProcessListServer(root);
    child = Bun.spawn([SANDBOX_EXEC, "-p", sandboxProfile(root), ...command], {
      cwd: options.cwd ?? REPO_ROOT,
      env: testEnvironment(paths, root, options.maxBytes),
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
    for (const signal of signals) process.on(signal, forward);
    const finished =
      options.deadlineMs === undefined
        ? { kind: "exited" as const, exitCode: await child.exited }
        : await Promise.race([
            child.exited.then((exitCode) => ({
              kind: "exited" as const,
              exitCode,
            })),
            Bun.sleep(options.deadlineMs).then(() => ({
              kind: "timeout" as const,
            })),
          ]);
    if (finished.kind === "timeout") {
      timedOut = true;
    } else {
      await stopProcessGroup(child.pid, "SIGTERM");
      await Bun.sleep(100);
      await stopProcessGroup(child.pid, "SIGKILL");
      return finished.exitCode;
    }
  } finally {
    for (const signal of signals) process.off(signal, forward);
    if (child !== undefined) await stopProcessGroup(child.pid, "SIGKILL");
    processListServer?.stop(true);
    // A timeout is when the working directory is most valuable. Cleanup on
    // that path would delete the evidence and can emit a secondary fatal
    // about a missing directory that readers then mistake for the failure.
    if (timedOut) {
      let preservedPath = paths.mount;
      try {
        preservedPath = await preserveTimedOutSandbox(
          paths,
          options.key,
          cleanup,
        );
      } catch {
        // Eviction of a previous image must not replace the timeout.
      }
      timeoutError = new SandboxTimeoutError(
        options.deadlineMs ?? 0,
        options.waitingFor ?? "the sandboxed command",
        preservedPath,
      );
    } else {
      await cleanup(paths.base);
    }
  }
  if (timeoutError !== undefined) throw timeoutError;
  throw new Error("sandbox run ended without an exit or a named timeout");
}

async function selfTest(): Promise<void> {
  const options = {
    key: "self-test",
    imageSize: "64m",
    maxBytes: 64 * 1024 * 1024,
  } as const;
  const probe = [
    'import { closeSync, existsSync, openSync, statfsSync, writeFileSync, writeSync } from "node:fs";',
    'import { join } from "node:path";',
    "const root = process.env.HIVE_TEST_ROOT;",
    "const outside = process.env.HIVE_TEST_OUTSIDE_PATH;",
    "const max = BigInt(process.env.HIVE_TEST_ROOT_MAX_BYTES);",
    "const fs = statfsSync(root, { bigint: true });",
    "if (fs.bsize * fs.blocks > max) process.exit(3);",
    'writeFileSync(join(root, "positive-control"), "ok");',
    'const fd = openSync(join(root, "over-cap"), "w");',
    "const chunk = Buffer.alloc(1024 * 1024);",
    "let written = 0n;",
    "try { while (written <= max) written += BigInt(writeSync(fd, chunk)); process.exit(4); }",
    'catch (error) { if (error.code !== "ENOSPC") process.exit(5); }',
    "finally { closeSync(fd); }",
    'try { writeFileSync(join(outside, "escape"), "escape"); process.exit(6); }',
    'catch (error) { if (error.code !== "EPERM") process.exit(7); }',
    'if (existsSync(join(outside, "escape"))) process.exit(8);',
  ].join("\n");
  if ((await runInBoundedTestRoot(["bun", "-e", probe], options)) !== 0) {
    throw new Error("bounded test-root write/capacity/escape probe failed");
  }
  if (
    (await runInBoundedTestRoot(["bun", "-e", "process.exit(7)"], options)) !==
    7
  ) {
    throw new Error("bounded test-root failure probe did not preserve exit 7");
  }
  if (
    (await runInBoundedTestRoot(
      ["bun", "-e", 'process.kill(process.pid, "SIGKILL")'],
      options,
    )) === 0
  ) {
    throw new Error("bounded test-root kill probe unexpectedly passed");
  }

  const worktrees = Bun.spawnSync(
    ["git", "-C", REPO_ROOT, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  )
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((worktree) => existsSync(worktree));
  const roots: string[] = [];
  let arrivals = 0;
  let releaseBarrier: () => void = () => {};
  const barrier = new Promise<void>((resolveBarrier) => {
    releaseBarrier = resolveBarrier;
  });
  const beforeRun = async (root: string): Promise<void> => {
    roots.push(root);
    arrivals += 1;
    if (arrivals === 2) releaseBarrier();
    await barrier;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("concurrent invocations blocked each other")),
      10_000,
    );
    timeout.unref?.();
  });
  const concurrent = await Promise.race([
    Promise.all([
      runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(250)"], {
        ...options,
        cwd: worktrees[0] ?? REPO_ROOT,
        beforeRun,
      }),
      runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(250)"], {
        ...options,
        cwd: worktrees[1] ?? REPO_ROOT,
        beforeRun,
      }),
    ]),
    blocked,
  ]).finally(() => clearTimeout(timeout));
  if (concurrent.some((exitCode) => exitCode !== 0)) {
    throw new Error("concurrent bounded test-root probe failed");
  }
  if (roots.length !== 2 || roots[0] === roots[1]) {
    throw new Error("concurrent invocations did not receive unique roots");
  }

  const timeoutKeys = [
    "self-to-preserve",
    "self-green-clean",
    "self-fail-clean",
    "self-evict-cap",
    "self-cleanup-fail",
  ] as const;
  try {
    let preservedRoot = "";
    try {
      await runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(10_000)"], {
        ...options,
        key: "self-to-preserve",
        deadlineMs: 80,
        waitingFor: "a command that never finished",
        beforeRun(root) {
          writeFileSync(join(root, "existed"), "yes");
          preservedRoot = root;
        },
      });
      throw new Error("timeout path returned instead of throwing");
    } catch (error) {
      if (!(error instanceof SandboxTimeoutError)) throw error;
      if (
        error.message.split("\n")[0] !==
        "timed out after 80ms waiting for a command that never finished"
      ) {
        throw new Error(
          `timeout first line was ${error.message.split("\n")[0]}`,
        );
      }
      if (!error.message.includes(`preserved sandbox: ${preservedRoot}`)) {
        throw new Error("timeout did not cite the preserved sandbox path");
      }
      if (!existsSync(join(preservedRoot, "existed"))) {
        throw new Error(
          "timeout cleaned up the image it should have preserved",
        );
      }
    }

    let greenRoot = "";
    const green = await runInBoundedTestRoot(["bun", "-e", "process.exit(0)"], {
      ...options,
      key: "self-green-clean",
      beforeRun(root) {
        writeFileSync(join(root, "existed"), "yes");
        if (!existsSync(join(root, "existed"))) {
          throw new Error("green fixture never created the image");
        }
        greenRoot = root;
      },
    });
    if (green !== 0) throw new Error(`green run exited ${green}`);
    if (greenRoot.length === 0) throw new Error("green fixture did not run");
    if (existsSync(greenRoot)) {
      throw new Error("green run left the image on disk");
    }

    let failedRoot = "";
    const failed = await runInBoundedTestRoot(
      ["bun", "-e", "process.exit(7)"],
      {
        ...options,
        key: "self-fail-clean",
        beforeRun(root) {
          writeFileSync(join(root, "existed"), "yes");
          if (!existsSync(join(root, "existed"))) {
            throw new Error("failure fixture never created the image");
          }
          failedRoot = root;
        },
      },
    );
    if (failed !== 7) throw new Error(`named failure exited ${failed}`);
    if (failedRoot.length === 0) throw new Error("failure fixture did not run");
    if (existsSync(failedRoot)) {
      throw new Error("named failure left the image on disk");
    }

    let first = "";
    let second = "";
    try {
      await runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(10_000)"], {
        ...options,
        key: "self-evict-cap",
        deadlineMs: 80,
        waitingFor: "the first hung command",
        beforeRun(root) {
          first = root;
        },
      });
      throw new Error("first eviction timeout returned");
    } catch (error) {
      if (!(error instanceof SandboxTimeoutError)) throw error;
    }
    if (!existsSync(first)) throw new Error("first timeout did not preserve");
    try {
      await runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(10_000)"], {
        ...options,
        key: "self-evict-cap",
        deadlineMs: 80,
        waitingFor: "the second hung command",
        beforeRun(root) {
          second = root;
        },
      });
      throw new Error("second eviction timeout returned");
    } catch (error) {
      if (!(error instanceof SandboxTimeoutError)) throw error;
    }
    if (!existsSync(second)) throw new Error("second timeout did not preserve");
    if (first === second) throw new Error("eviction reused the same image");
    if (existsSync(first)) throw new Error("cap did not evict the first image");

    try {
      await runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(10_000)"], {
        ...options,
        key: "self-cleanup-fail",
        deadlineMs: 80,
        waitingFor: "a command that never finished",
      });
      throw new Error("cleanup-fail seed timeout returned");
    } catch (error) {
      if (!(error instanceof SandboxTimeoutError)) throw error;
    }
    try {
      await runInBoundedTestRoot(["bun", "-e", "await Bun.sleep(10_000)"], {
        ...options,
        key: "self-cleanup-fail",
        deadlineMs: 80,
        waitingFor: "a command that never finished",
        cleanup: async () => {
          throw new Error("cleanup exploded");
        },
      });
      throw new Error("cleanup-fail timeout returned");
    } catch (error) {
      if (!(error instanceof SandboxTimeoutError)) {
        throw new Error(
          `cleanup error replaced the timeout: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (error.message.includes("cleanup exploded")) {
        throw new Error("cleanup error leaked into the timeout message");
      }
    }
  } finally {
    await Promise.all(timeoutKeys.map((key) => releasePreservedSandbox(key)));
  }

  console.log(
    `bounded test root: write guard, cap, unique concurrent roots across ${Math.min(worktrees.length, 2)} worktrees, failure cleanup, and kill cleanup verified; timeout preserve/name 1, green cleanup 1, named-failure cleanup 1, cap eviction 1, cleanup-error-does-not-replace 1`,
  );
}

/**
 * Builds a missing or stale `hive-sessiond` before the suite starts, and
 * always prints which of the three states it found.
 *
 * This runner is where it belongs because it is the only way into the Bun
 * suite: test/test-root-preload.ts refuses a bare `bun test`, so package.json,
 * native/sessiond/test.sh and the main-health monitor all arrive here. The
 * sandbox denies writes outside its volume, so the build has to happen out
 * here in the parent, before the mount exists.
 *
 * The gate is not conditional on which tests were asked for. A flag to skip it
 * would be a way to reintroduce the failure it removes, and the cost of not
 * skipping is one `make -q` query, measured at 0.37s.
 */
function ensureSessiond(): void {
  const gate = Bun.spawnSync(
    [join(REPO_ROOT, "scripts", "native", "ensure-sessiond.sh")],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (gate.exitCode !== 0) process.exit(gate.exitCode);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const selfTestOnly = args.length === 1 && args[0] === "--self-test";
  if (!selfTestOnly) ensureSessiond();
  try {
    const exitCode = selfTestOnly
      ? await selfTest().then(() => 0)
      : await runInBoundedTestRoot(args[0] === "--" ? args.slice(1) : args, {
          key: "suite",
          imageSize: DEFAULT_IMAGE_SIZE,
          maxBytes: DEFAULT_MAX_BYTES,
        });
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SandboxTimeoutError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
