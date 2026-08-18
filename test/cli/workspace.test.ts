import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchDeps,
  launchWorkspace,
  resolveWorkspaceApp,
  runWorkspace,
  WorkspaceNotInstalledError,
  workspaceOpenArguments,
  workspaceOrchestratorArguments,
} from "../../src/cli/workspace";
import { getHiveHome } from "../../src/hive-home/home";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";

let root: string;
const testProjectIdentity = () => ({ id: "project-uuid", name: "root" });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-workspace-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An installed release: a version directory with an app, and `current` at it. */
function install(version: string): string {
  const app = join(
    root,
    "versions",
    version,
    "HiveWorkspace.app",
    "Contents",
    "MacOS",
  );
  mkdirSync(app, { recursive: true });
  symlinkSync(join("versions", version), join(root, "current"));
  return join(root, "versions", version, "HiveWorkspace.app");
}

describe("hive opens the installed release Workspace", () => {
  test("passes PATH and the private temp directory into a separate app", () => {
    expect(
      workspaceOpenArguments(
        "/Applications/HiveWorkspace.app",
        ["--orchestrator", "codex"],
        "/usr/local/tools/bin:/Users/me/.local/bin:/usr/bin",
        "/var/folders/user/T/",
        "1",
      ),
    ).toEqual([
      "-n",
      "-a",
      "/Applications/HiveWorkspace.app",
      "--env",
      "PATH=/usr/local/tools/bin:/Users/me/.local/bin:/usr/bin",
      "--env",
      "TMPDIR=/var/folders/user/T/",
      "--env",
      "HIVE_QA=1",
      "--args",
      "--orchestrator",
      "codex",
    ]);
  });

  test("an instance launch keeps the app's stderr instead of discarding it", () => {
    // `open` discards stderr by default; the app's NSLog is the only record of
    // pane-renderer attach failures and bounded give-up. Keep it on the instance.
    expect(
      workspaceOpenArguments(
        "/Applications/HiveWorkspace.app",
        ["--project", "/repo", "--instance-home", "/tmp/hv-abc123"],
        "/usr/bin",
        "/var/folders/user/T/",
      ),
    ).toEqual([
      "-n",
      "-a",
      "/Applications/HiveWorkspace.app",
      "--env",
      "PATH=/usr/bin",
      "--env",
      "TMPDIR=/var/folders/user/T/",
      "--stderr",
      "/tmp/hv-abc123/workspace.log",
      "--args",
      "--project",
      "/repo",
      "--instance-home",
      "/tmp/hv-abc123",
    ]);
  });

  test("resolves the app through the active version symlink", () => {
    install("0.0.7");
    expect(resolveWorkspaceApp(root)).toEqual(
      join(root, "current", "HiveWorkspace.app"),
    );
  });

  test("activating a release activates its Workspace in the same rename", async () => {
    // The CLI and the app live in one version directory, so they cannot skew.
    install("0.0.7");
    const opened: string[] = [];
    await launchWorkspace({
      root,
      open: async (app) => {
        opened.push(app);
        return 0;
      },
    });
    expect(opened).toEqual([join(root, "current", "HiveWorkspace.app")]);
  });

  test("with no session it launches the app with no args (placeholder window)", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      startOrchestrator: async () => {},
      open: async (_app, args) => {
        argLists.push(args);
        return 0;
      },
    });
    expect(argLists).toEqual([[]]);
  });

  test("with a session it hands the app the project, port, and hive binary", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      startOrchestrator: async () => {},
      open: async (_app, args) => {
        argLists.push(args);
        return 0;
      },
      session: {
        cwd: "/tmp/proj",
        port: 4567,
        projectId: "project-uuid",
        projectName: "proj",
        hivePath: "/opt/hive/bin/hive",
      },
    });
    expect(argLists).toEqual([
      [
        "--project",
        "/tmp/proj",
        "--project-id",
        "project-uuid",
        "--project-name",
        "proj",
        "--port",
        "4567",
        "--instance-id",
        hiveInstanceSuffix(),
        "--instance-home",
        getHiveHome(),
        "--hive",
        "/opt/hive/bin/hive",
      ],
    ]);
  });

  test("starts the selected orchestrator outside the app", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    const starts: NonNullable<LaunchDeps["session"]>[] = [];
    await launchWorkspace({
      root,
      startOrchestrator: async (session) => {
        starts.push(session);
      },
      open: async (_app, args) => {
        argLists.push(args);
        return 0;
      },
      session: {
        cwd: "/tmp/proj",
        port: 4567,
        projectId: "project-uuid",
        projectName: "proj",
        hivePath: "/opt/hive/bin/hive",
        orchestrator: "codex",
      },
    });
    expect(argLists).toEqual([
      [
        "--project",
        "/tmp/proj",
        "--project-id",
        "project-uuid",
        "--project-name",
        "proj",
        "--port",
        "4567",
        "--instance-id",
        hiveInstanceSuffix(),
        "--instance-home",
        getHiveHome(),
        "--hive",
        "/opt/hive/bin/hive",
      ],
    ]);
    expect(starts.map((session) => session.orchestrator)).toEqual(["codex"]);
  });

  test("the backend launch boundary owns all five provider spellings", () => {
    for (const orchestrator of [
      "claude",
      "codex",
      "grok",
      "kimi",
      "opencode",
    ] as const) {
      expect(
        workspaceOrchestratorArguments({
          cwd: "/repo",
          port: 4483,
          projectId: "project-uuid",
          projectName: "repo",
          orchestrator,
        }),
      ).toContain(orchestrator);
    }
    expect(
      workspaceOrchestratorArguments({
        cwd: "/repo",
        port: 4483,
        projectId: "project-uuid",
        projectName: "repo",
      }),
    ).toContain("claude");
  });

  test("--hive defaults to this very process, never PATH lookup", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      startOrchestrator: async () => {},
      open: async (_app, args) => {
        argLists.push(args);
        return 0;
      },
      session: {
        cwd: "/tmp/proj",
        port: 4567,
        projectId: "project-uuid",
        projectName: "proj",
      },
    });
    expect(argLists).toEqual([
      [
        "--project",
        "/tmp/proj",
        "--project-id",
        "project-uuid",
        "--project-name",
        "proj",
        "--port",
        "4567",
        "--instance-id",
        hiveInstanceSuffix(),
        "--instance-home",
        getHiveHome(),
        "--hive",
        process.execPath,
      ],
    ]);
  });

  test("with no release installed it refuses rather than launching a dev build", async () => {
    // The requirement, pinned: no symlink into workspace/.build, no `swift run`,
    // no environment variable that quietly prefers a debug bundle.
    expect(resolveWorkspaceApp(root)).toEqual(null);

    let opened = false;
    const promise = launchWorkspace({
      root,
      open: async () => {
        opened = true;
        return 0;
      },
    });
    await expect(promise).rejects.toThrow(WorkspaceNotInstalledError);
    expect(opened).toEqual(false);
  });

  test("the refusal names the installer, not a build command", async () => {
    const error = await launchWorkspace({ root }).catch(
      (cause: unknown) => cause,
    );
    const message = (error as Error).message;
    expect(message).toContain("install.sh");
    expect(message).not.toContain("swift run");
    expect(message).not.toContain("bun run");
  });

  test("a dangling current symlink is not installed", () => {
    symlinkSync(join("versions", "0.0.7"), join(root, "current"));
    expect(resolveWorkspaceApp(root)).toEqual(null);
  });
});

describe("bare hive opens the project you're in", () => {
  test("in a repo it runs the session boundary and launches against it", async () => {
    const resolved: string[] = [];
    const started: (string | undefined)[] = [];
    const launches: LaunchDeps[] = [];
    await runWorkspace({
      cwd: "/repo/root/some/subdir",
      resolveRoot: (cwd) => {
        resolved.push(cwd);
        return "/repo/root";
      },
      isInitialized: () => true,
      projectIdentity: testProjectIdentity,
      start: async (deps) => {
        started.push(deps.cwd);
        return { port: 4483, cwd: "/repo/root" };
      },
      checkUpdate: async () => {
        // startSession already prints the start notice; a second, forced
        // check here would print it twice.
        throw new Error("the forced update check must not run in-project");
      },
      launch: async (deps) => {
        launches.push(deps);
        return 0;
      },
    });
    expect(resolved).toEqual(["/repo/root/some/subdir"]);
    expect(started).toEqual(["/repo/root"]);
    expect(launches).toEqual([
      {
        session: {
          cwd: "/repo/root",
          port: 4483,
          projectId: "project-uuid",
          projectName: "root",
        },
      },
    ]);
  });

  test("hive and all five vendor commands share one session boundary", async () => {
    for (const orchestrator of [
      undefined,
      "claude",
      "codex",
      "grok",
      "kimi",
      "opencode",
    ] as const) {
      const launches: LaunchDeps[] = [];
      let starts = 0;
      await runWorkspace({
        ...(orchestrator === undefined ? {} : { orchestrator }),
        cwd: "/repo/root/subdir",
        resolveRoot: () => "/repo/root",
        isInitialized: () => true,
        projectIdentity: testProjectIdentity,
        start: async () => {
          starts += 1;
          return { port: 4483, cwd: "/repo/root" };
        },
        launch: async (deps) => {
          launches.push(deps);
          return 0;
        },
      });
      expect(starts).toBe(1);
      expect(launches).toEqual([
        {
          session: {
            cwd: "/repo/root",
            port: 4483,
            projectId: "project-uuid",
            projectName: "root",
            ...(orchestrator === undefined ? {} : { orchestrator }),
          },
        },
      ]);
    }
  });

  test("a repo that never ran init is announced and initialized first", async () => {
    const lines: string[] = [];
    const inits: string[] = [];
    const order: string[] = [];
    await runWorkspace({
      cwd: "/repo/root",
      resolveRoot: () => "/repo/root",
      isInitialized: () => false,
      projectIdentity: testProjectIdentity,
      init: async (root) => {
        inits.push(root);
        order.push("init");
      },
      start: async () => {
        order.push("start");
        return { port: 4483, cwd: "/repo/root" };
      },
      write: (line) => lines.push(line),
      launch: async () => 0,
    });
    expect(inits).toEqual(["/repo/root"]);
    expect(order).toEqual(["init", "start"]);
    expect(lines.join("\n")).toContain("No Hive here yet");
  });

  test("an init failure is reported and does not stop the launch", async () => {
    const lines: string[] = [];
    let launched = false;
    await runWorkspace({
      cwd: "/repo/root",
      resolveRoot: () => "/repo/root",
      isInitialized: () => false,
      projectIdentity: testProjectIdentity,
      init: async () => {
        throw new Error("disk full");
      },
      start: async () => ({ port: 4483, cwd: "/repo/root" }),
      write: (line) => lines.push(line),
      launch: async () => {
        launched = true;
        return 0;
      },
    });
    expect(lines.join("\n")).toContain("disk full");
    expect(launched).toBe(true);
  });

  test("outside a repo it offers an available update, then launches standalone", async () => {
    const launches: LaunchDeps[] = [];
    const lines: string[] = [];
    await runWorkspace({
      resolveRoot: () => null,
      checkUpdate: async () => ({
        state: "update-available",
        current: "0.0.3",
        latest: "0.0.4",
        securityCritical: false,
        stale: false,
      }),
      write: (line) => lines.push(line),
      launch: async (deps) => {
        launches.push(deps);
        return 0;
      },
    });
    expect(lines.join("\n")).toContain("hive 0.0.4 available");
    expect(launches).toEqual([{}]);
  });

  test("outside a repo a failed update check is silent and still launches", async () => {
    let launched = false;
    const lines: string[] = [];
    await runWorkspace({
      resolveRoot: () => null,
      checkUpdate: async () => {
        throw new Error("offline");
      },
      write: (line) => lines.push(line),
      launch: async () => {
        launched = true;
        return 0;
      },
    });
    expect(lines).toEqual([]);
    expect(launched).toEqual(true);
  });

  test("outside a repo a resolved 'could not check' now announces, unlike a thrown error", async () => {
    // The pair with the test above is the point: a THROWN checkUpdate still
    // launches silent (never-block, preserved). A RESOLVED unavailable state
    // is not a thrown error — it is checkForUpdate's honest "I looked and
    // could not tell", and this path now says so out loud, same as the
    // in-repo path's start notice already does. Pinning this is what stops a
    // future revert of the printStartNotice delegation from going unnoticed:
    // no other test asserted this state used to be silent here.
    let launched = false;
    const lines: string[] = [];
    await runWorkspace({
      resolveRoot: () => null,
      checkUpdate: async () => ({
        state: "unavailable",
        current: "0.0.3",
        reason: "offline",
      }),
      write: (line) => lines.push(line),
      launch: async () => {
        launched = true;
        return 0;
      },
    });
    expect(lines.join("\n")).toContain("could not check for updates (offline)");
    expect(launched).toEqual(true);
  });

  test("outside a repo, a staged native download says so — not just 'available'", async () => {
    // `detectInstallMethod` keys off `process.execPath`, which a test runner
    // can never point inside a staged version directory; the "native"
    // install method is the one leg of this notice no dependency injection
    // reaches, so this is the one test in the suite that swaps the module.
    const paths = await import("../../src/update-service/paths");
    const originalDetectInstallMethod = paths.detectInstallMethod;
    mock.module("../../src/update-service/paths", () => ({
      ...paths,
      detectInstallMethod: () => "native" as const,
    }));
    const installRootDir = mkdtempSync(
      join(tmpdir(), "hive-workspace-staged-"),
    );
    const originalInstallRoot = process.env.HIVE_INSTALL_ROOT;
    process.env.HIVE_INSTALL_ROOT = installRootDir;
    mkdirSync(join(installRootDir, "versions", "0.0.4"), { recursive: true });
    writeFileSync(join(installRootDir, "versions", "0.0.4", "hive"), "");
    const lines: string[] = [];
    try {
      await runWorkspace({
        resolveRoot: () => null,
        checkUpdate: async () => ({
          state: "update-available",
          current: "0.0.3",
          latest: "0.0.4",
          securityCritical: false,
          stale: false,
        }),
        write: (line) => lines.push(line),
        launch: async () => 0,
      });
    } finally {
      if (originalInstallRoot === undefined) {
        delete process.env.HIVE_INSTALL_ROOT;
      } else {
        process.env.HIVE_INSTALL_ROOT = originalInstallRoot;
      }
      rmSync(installRootDir, { recursive: true, force: true });
      mock.module("../../src/update-service/paths", () => ({
        ...paths,
        detectInstallMethod: originalDetectInstallMethod,
      }));
    }
    expect(lines.join("\n")).toContain("downloaded");
  });
});
