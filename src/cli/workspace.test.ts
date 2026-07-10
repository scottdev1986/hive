import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceNotInstalledError,
  launchWorkspace,
  resolveWorkspaceApp,
  runWorkspace,
  type LaunchDeps,
} from "./workspace";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-workspace-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An installed release: a version directory with an app, and `current` at it. */
function install(version: string): string {
  const app = join(root, "versions", version, "HiveWorkspace.app", "Contents", "MacOS");
  mkdirSync(app, { recursive: true });
  symlinkSync(join("versions", version), join(root, "current"));
  return join(root, "versions", version, "HiveWorkspace.app");
}

describe("hive opens the installed release Workspace", () => {
  test("resolves the app through the active version symlink", () => {
    install("0.0.7");
    expect(resolveWorkspaceApp(root)).toEqual(join(root, "current", "HiveWorkspace.app"));
  });

  test("activating a release activates its Workspace in the same rename", async () => {
    // The CLI and the app live in one version directory, so they cannot skew.
    install("0.0.7");
    const opened: string[] = [];
    await launchWorkspace({
      root,
      open: async (app) => (opened.push(app), 0),
    });
    expect(opened).toEqual([join(root, "current", "HiveWorkspace.app")]);
  });

  test("with no session it launches the app with no args (placeholder window)", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      open: async (_app, args) => (argLists.push(args), 0),
    });
    expect(argLists).toEqual([[]]);
  });

  test("with a session it hands the app the project, port, and hive binary", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      open: async (_app, args) => (argLists.push(args), 0),
      session: { cwd: "/tmp/proj", port: 4567, hivePath: "/opt/hive/bin/hive" },
    });
    expect(argLists).toEqual([[
      "--project", "/tmp/proj",
      "--port", "4567",
      "--hive", "/opt/hive/bin/hive",
    ]]);
  });

  test("--hive defaults to this very process, never PATH lookup", async () => {
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      open: async (_app, args) => (argLists.push(args), 0),
      session: { cwd: "/tmp/proj", port: 4567 },
    });
    expect(argLists).toEqual([[
      "--project", "/tmp/proj",
      "--port", "4567",
      "--hive", process.execPath,
    ]]);
  });

  test("with no release installed it refuses rather than launching a dev build", async () => {
    // The requirement, pinned: no symlink into workspace/.build, no `swift run`,
    // no environment variable that quietly prefers a debug bundle.
    expect(resolveWorkspaceApp(root)).toEqual(null);

    let opened = false;
    const promise = launchWorkspace({
      root,
      open: async () => (opened = true, 0),
    });
    await expect(promise).rejects.toThrow(WorkspaceNotInstalledError);
    expect(opened).toEqual(false);
  });

  test("the refusal names the installer, not a build command", async () => {
    const error = await launchWorkspace({ root })
      .catch((cause: unknown) => cause);
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
      resolveRoot: (cwd) => (resolved.push(cwd), "/repo/root"),
      start: async (deps) => {
        started.push(deps.cwd);
        return { port: 4483, cwd: "/repo/root" };
      },
      checkUpdate: async () => {
        // startSession already prints the start notice; a second, forced
        // check here would print it twice.
        throw new Error("the forced update check must not run in-project");
      },
      launch: async (deps) => (launches.push(deps), 0),
    });
    expect(resolved).toEqual(["/repo/root/some/subdir"]);
    expect(started).toEqual(["/repo/root"]);
    expect(launches).toEqual([{ session: { cwd: "/repo/root", port: 4483 } }]);
  });

  test("outside a repo it offers an available update, then launches standalone", async () => {
    const launches: LaunchDeps[] = [];
    const lines: string[] = [];
    await runWorkspace({
      resolveRoot: () => null,
      checkUpdate: async () => ({
        state: "update-available", current: "0.0.3", latest: "0.0.4",
        securityCritical: false, stale: false,
      }),
      write: (line) => lines.push(line),
      launch: async (deps) => (launches.push(deps), 0),
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
      launch: async () => ((launched = true), 0),
    });
    expect(lines).toEqual([]);
    expect(launched).toEqual(true);
  });
});
