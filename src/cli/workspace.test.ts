import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceNotInstalledError, launchWorkspace, resolveWorkspaceApp } from "./workspace";

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
    await launchWorkspace({ root, open: async (app) => (opened.push(app), 0) });
    expect(opened).toEqual([join(root, "current", "HiveWorkspace.app")]);
  });

  test("passes the project directory to the app", async () => {
    install("0.0.7");
    const dirs: string[] = [];
    await launchWorkspace({
      root,
      cwd: "/Users/scott/Projects/hive",
      open: async (_app, dir) => (dirs.push(dir), 0),
    });
    expect(dirs).toEqual(["/Users/scott/Projects/hive"]);
  });

  test("with no release installed it refuses rather than launching a dev build", async () => {
    // The requirement, pinned: no symlink into workspace/.build, no `swift run`,
    // no environment variable that quietly prefers a debug bundle.
    expect(resolveWorkspaceApp(root)).toEqual(null);

    let opened = false;
    const promise = launchWorkspace({ root, open: async () => (opened = true, 0) });
    await expect(promise).rejects.toThrow(WorkspaceNotInstalledError);
    expect(opened).toEqual(false);
  });

  test("the refusal names the installer, not a build command", async () => {
    const error = await launchWorkspace({ root }).catch((cause: unknown) => cause);
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
