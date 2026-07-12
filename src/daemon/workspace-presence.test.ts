import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_PRESENCE_TTL_MS,
  WorkspacePresence,
} from "./workspace-presence";

describe("WorkspacePresence", () => {
  test("is a lease: granted, renewed, and expiring on its own", () => {
    let now = 0;
    const presence = new WorkspacePresence(() => now);
    expect(presence.isPresent()).toEqual(false);

    presence.markPresent();
    expect(presence.isPresent()).toEqual(true);

    // Renewal pushes expiry forward from *now*, not from the first grant.
    now = 10_000;
    presence.markPresent();
    now = 10_000 + WORKSPACE_PRESENCE_TTL_MS - 1;
    expect(presence.isPresent()).toEqual(true);

    // A crashed app never clears; the TTL is what reverts the daemon.
    now = 10_000 + WORKSPACE_PRESENCE_TTL_MS;
    expect(presence.isPresent()).toEqual(false);
  });

  test("clear surrenders the lease immediately", () => {
    let now = 0;
    const presence = new WorkspacePresence(() => now);
    presence.markPresent();
    presence.clear();
    expect(presence.isPresent()).toEqual(false);
  });

  test("one workspace's clean exit does not surrender another's lease", () => {
    let now = 0;
    const presence = new WorkspacePresence(() => now);
    // The user's real app, and an agent's test app verifying UI work.
    presence.markPresent("real-app");
    presence.markPresent("test-app");

    // The test app quits cleanly. The user is still sitting in front of his
    // workspace: the daemon must not open a Terminal.app window over it.
    presence.clear("test-app");
    expect(presence.isPresent()).toEqual(true);

    // And the real app's lease still expires on its own if it dies — the
    // fallback to external viewers must survive this fix.
    presence.markPresent("real-app");
    now += WORKSPACE_PRESENCE_TTL_MS;
    expect(presence.isPresent()).toEqual(false);
  });

  test("presence lapses only when the last workspace is gone", () => {
    let now = 0;
    const presence = new WorkspacePresence(() => now);
    presence.markPresent("first");
    presence.markPresent("second");

    presence.clear("first");
    expect(presence.isPresent()).toEqual(true);
    presence.clear("second");
    expect(presence.isPresent()).toEqual(false);
  });
});
