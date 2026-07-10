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
      port: 4483,
      open: async (app) => (opened.push(app), 0),
    });
    expect(opened).toEqual([join(root, "current", "HiveWorkspace.app")]);
  });

  test("hands the app the project, the live port, and the launching CLI", async () => {
    // The app must attach to the daemon this launch just brought up and spawn
    // helpers from the same build — never guess a port or PATH-resolve `hive`.
    install("0.0.7");
    const argLists: (readonly string[])[] = [];
    await launchWorkspace({
      root,
      cwd: "/Users/scott/Projects/hive",
      port: 4483,
      hivePath: "/opt/hive/current/hive",
      open: async (_app, args) => (argLists.push(args), 0),
    });
    expect(argLists).toEqual([[
      "--project", "/Users/scott/Projects/hive",
      "--port", "4483",
      "--hive", "/opt/hive/current/hive",
    ]]);
  });

  test("the forwarded CLI defaults to the running binary itself", async () => {
    install("0.0.7");
    let args: readonly string[] = [];
    await launchWorkspace({
      root,
      port: 4483,
      open: async (_app, forwarded) => ((args = forwarded), 0),
    });
    expect(args).toContain("--hive");
    expect(args[args.indexOf("--hive") + 1]).toEqual(process.execPath);
  });

  test("with no release installed it refuses rather than launching a dev build", async () => {
    // The requirement, pinned: no symlink into workspace/.build, no `swift run`,
    // no environment variable that quietly prefers a debug bundle.
    expect(resolveWorkspaceApp(root)).toEqual(null);

    let opened = false;
    const promise = launchWorkspace({
      root,
      port: 4483,
      open: async () => (opened = true, 0),
    });
    await expect(promise).rejects.toThrow(WorkspaceNotInstalledError);
    expect(opened).toEqual(false);
  });

  test("the refusal names the installer, not a build command", async () => {
    const error = await launchWorkspace({ root, port: 4483 })
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

describe("bare hive runs the session boundary before the app", () => {
  test("launches against exactly the port the start boundary produced", async () => {
    const launches: LaunchDeps[] = [];
    let started = 0;
    await runWorkspace({
      start: async () => {
        started += 1;
        return { port: 45_017, cwd: "/Users/scott/Projects/hive" };
      },
      launch: async (deps) => (launches.push(deps), 0),
    });
    expect(started).toEqual(1);
    expect(launches).toEqual([
      { cwd: "/Users/scott/Projects/hive", port: 45_017 },
    ]);
  });

  test("a start failure never launches the app", async () => {
    // The failure mode from the field test, inverted: an app with no daemon
    // behind it must be impossible to reach from bare `hive`.
    let launched = false;
    const promise = runWorkspace({
      start: async () => {
        throw new Error("daemon failed to start");
      },
      launch: async () => ((launched = true), 0),
    });
    await expect(promise).rejects.toThrow("daemon failed to start");
    expect(launched).toEqual(false);
  });
});
