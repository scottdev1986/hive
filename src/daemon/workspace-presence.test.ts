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
});
