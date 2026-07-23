import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphifyPin } from "../adapters/graphify";

const CLI = join(import.meta.dir, "../cli.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function installFakeGraphify(home: string): Promise<void> {
  const directory = join(home, "tools", "graphify", graphifyPin());
  await mkdir(directory, { recursive: true });
  const source = [
    `#!${process.execPath}`,
    'import { mkdirSync } from "node:fs";',
    'if (process.argv[2] === "--help") process.exit(0);',
    'if (process.argv[2] !== "extract") process.exit(2);',
    'const root = process.argv[3];',
    'mkdirSync(`${root}/graphify-out`, { recursive: true });',
    'await Bun.write(`${root}/graphify-out/graph.json`, \'{"nodes":[],"links":[]}\\n\');',
    'console.log("[graphify extract] wrote graphify-out/graph.json: 0 nodes, 0 edges, 0 communities");',
    "",
  ].join("\n");
  for (const name of ["graphify", "graphify-mcp"]) {
    const path = join(directory, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
}

describe("hive init command boundary", () => {
  test("initializes required Graphify and repository state without starting a daemon", async () => {
    const repo = await mkdtemp(join(tmpdir(), "hive-init-command-repo-"));
    const home = await mkdtemp(join(tmpdir(), "hive-init-command-home-"));
    roots.push(repo, home);
    git(repo, ["init"]);
    await writeFile(join(repo, "README.md"), "# Empty test repository\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init", "--no-gpg-sign"]);
    const defaultHome = join(home, ".hive");
    await installFakeGraphify(defaultHome);

    const commandEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
    };
    delete commandEnv["HIVE_HOME"];
    const child = Bun.spawn(
      [process.execPath, CLI, "init"],
      {
        cwd: repo,
        env: commandEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(join(defaultHome, "daemon.lock"))).toBe(false);
    expect(existsSync(join(defaultHome, "daemon.pid"))).toBe(false);
    expect(existsSync(join(defaultHome, "daemon.port"))).toBe(false);
    expect(existsSync(join(repo, "graphify-out", "graph.json"))).toBe(true);

    const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
    for (const entry of [
      ".hive/memory/",
      ".hive/worktrees/",
      "graphify-out/",
      ".graphifyignore",
    ]) {
      expect(gitignore).toContain(entry);
    }
    const ignored = Bun.spawnSync([
      "git",
      "-C",
      repo,
      "check-ignore",
      "--no-index",
      ".hive/memory/probe",
      ".hive/worktrees/probe",
      "graphify-out/probe",
      ".graphifyignore",
    ]);
    expect(ignored.exitCode).toBe(0);
    expect(ignored.stdout.toString().trim().split("\n")).toHaveLength(4);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("graphify-out/");
    expect(exclude).not.toContain(".graphifyignore");

    const startModule = join(import.meta.dir, "start.ts");
    const initModule = join(import.meta.dir, "init.ts");
    const dbModule = join(import.meta.dir, "../daemon/db.ts");
    const launch = Bun.spawn([process.execPath, "-e", `
      const { startSession } = await import(${JSON.stringify(startModule)});
      const { isRepoInitialized } = await import(${JSON.stringify(initModule)});
      const { getHiveHome } = await import(${JSON.stringify(dbModule)});
      const session = await startSession({
        cwd: ${JSON.stringify(repo)},
        checkUpdate: async () => { throw new Error("offline"); },
        repairProjectConfig: async () => {},
        ensureDaemon: async () => {},
        ensurePort: async () => 45123,
        write: () => {},
      });
      console.log(JSON.stringify({
        home: getHiveHome(),
        initialized: isRepoInitialized(${JSON.stringify(repo)}),
        session,
      }));
    `], {
      cwd: repo,
      env: commandEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [launchExit, launchOut, launchError] = await Promise.all([
      launch.exited,
      new Response(launch.stdout).text(),
      new Response(launch.stderr).text(),
    ]);
    expect(launchExit).toBe(0);
    expect(launchError).toBe("");
    const selected = JSON.parse(launchOut) as {
      home: string;
      initialized: boolean;
      session: { cwd: string; port: number };
    };
    expect(selected.home.startsWith(join(defaultHome, "instances", "run-")))
      .toBe(true);
    expect(selected.initialized).toBe(true);
    expect(selected.session).toEqual({ cwd: repo, port: 45123 });
  });
});
