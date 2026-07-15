import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("hive init command boundary", () => {
  test("initializes repository state without starting a daemon", async () => {
    const repo = await mkdtemp(join(tmpdir(), "hive-init-command-repo-"));
    const home = await mkdtemp(join(tmpdir(), "hive-init-command-home-"));
    roots.push(repo, home);
    git(repo, ["init"]);
    await writeFile(join(repo, "README.md"), "# Empty test repository\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init", "--no-gpg-sign"]);

    const commandEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
    };
    delete commandEnv["HIVE_HOME"];
    const child = Bun.spawn(
      [process.execPath, CLI, "init", "--no-graphify"],
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
    const defaultHome = join(home, ".hive");
    expect(existsSync(join(defaultHome, "daemon.lock"))).toBe(false);
    expect(existsSync(join(defaultHome, "daemon.pid"))).toBe(false);
    expect(existsSync(join(defaultHome, "daemon.port"))).toBe(false);

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
