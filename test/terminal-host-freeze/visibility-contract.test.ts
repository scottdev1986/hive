import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CreateRequest,
  SessionRef,
} from "../../src/daemon/session-host/terminal-host-contract";
import {
  TERMINAL_HOST_VISIBILITY_CONTRACT_VERSION,
  type VisibilityCreateResult,
  type VisibilityRequest,
  type VisibilitySourceIdentity,
} from "../../src/daemon/session-host/terminal-host-visibility-contract";
import {
  NEUTRAL_VISIBILITY_FIXTURE_VERSION,
  NeutralVisibilityHostFixture,
  VISIBILITY_LEASE_MILLISECONDS,
  type VisibilityFreezeFault,
} from "./neutral-visibility-fixture";

function terminal(key: string, idempotencyKey = `create-${key}`): CreateRequest {
  return {
    key,
    idempotencyKey,
    command: {
      executable: "/usr/bin/printf",
      arguments: ["neutral visibility fixture"],
      workingDirectory: "/tmp/neutral terminal",
      completeEnvironment: [{ name: "TERM", value: "xterm-256color" }],
      descriptorMap: [],
    },
    terminalProfile: {
      inputMode: "literal",
      echo: false,
      signalCharacters: true,
      softwareFlowControl: true,
      eofByte: 4,
      startByte: 17,
      stopByte: 19,
      hangupOnLastClose: true,
    },
    initialWindow: { columns: 80, rows: 24, widthPixels: 800, heightPixels: 480 },
  };
}

function source(
  sessionId: string,
  processId: number,
  startToken: string,
): VisibilitySourceIdentity {
  return { sessionId, process: { processId, startToken } };
}

function visibility(
  identity: VisibilitySourceIdentity,
  inventoryRevision: string,
): VisibilityRequest {
  return { source: identity, inventoryRevision };
}

function requireCreated(result: VisibilityCreateResult): Readonly<{
  session: SessionRef;
  lease: Extract<VisibilityCreateResult, { state: "created" }>["lease"];
}> {
  expect(result.state).toBe("created");
  if (result.state !== "created") throw new Error(`create was ${result.state}`);
  return { session: result.result.session, lease: result.lease };
}

async function assertExactLeaseBinding(host: NeutralVisibilityHostFixture): Promise<void> {
  const identity = source("source-l", 6101, "6101:100");
  host.publishSnapshot({
    source: identity,
    inventoryRevision: "1",
    representedSessionKeys: ["visible-l", "invalid-l-zero", "invalid-l-leading-zero"],
  });

  for (const [key, revision] of [
    ["invalid-l-zero", "0"],
    ["invalid-l-leading-zero", "01"],
  ] as const) {
    expect(await host.create({
      terminal: terminal(key),
      visibility: visibility(identity, revision),
    })).toMatchObject({
      state: "rejected",
      reason: "invalid-revision",
      completeness: "complete",
      createInvoked: false,
      session: null,
      lease: null,
    });
  }
  expect(await host.list()).toHaveLength(0);

  const { session, lease } = requireCreated(await host.create({
    terminal: terminal("visible-l"),
    visibility: visibility(identity, "1"),
  }));
  expect(lease).toMatchObject({
    session,
    source: identity,
    acceptedRevision: "1",
    state: "active",
  });
  expect(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt))
    .toBe(VISIBILITY_LEASE_MILLISECONDS);
}

async function assertFreshRevision(host: NeutralVisibilityHostFixture): Promise<void> {
  const identity = source("source-m", 6102, "6102:100");
  host.publishSnapshot({
    source: identity,
    inventoryRevision: "1",
    representedSessionKeys: ["visible-m-first"],
  });
  requireCreated(await host.create({
    terminal: terminal("visible-m-first"),
    visibility: visibility(identity, "1"),
  }));

  host.publishSnapshot({
    source: identity,
    inventoryRevision: "2",
    representedSessionKeys: ["visible-m-first", "visible-m-equal", "visible-m-stale"],
  });
  requireCreated(await host.create({
    terminal: terminal("visible-m-equal"),
    visibility: visibility(identity, "2"),
  }));
  const replayed = await host.create({
    terminal: terminal("visible-m-stale"),
    visibility: visibility(identity, "1"),
  });
  expect(replayed).toMatchObject({
    state: "rejected",
    reason: "stale-revision",
    currentRevision: "2",
    createInvoked: false,
  });
  const future = await host.create({
    terminal: terminal("visible-m-future"),
    visibility: visibility(identity, "3"),
  });
  expect(future).toMatchObject({ state: "rejected", reason: "unverified-revision" });
}

async function assertExactLiveSource(host: NeutralVisibilityHostFixture): Promise<void> {
  const current = source("source-n", 6103, "6103:original");
  host.publishSnapshot({ source: current, inventoryRevision: "1", representedSessionKeys: ["visible-n"] });
  const reusedPid = source("source-n", 6103, "6103:reused");
  const mismatch = await host.create({
    terminal: terminal("visible-n"),
    visibility: visibility(reusedPid, "1"),
  });
  expect(mismatch).toMatchObject({
    state: "rejected",
    reason: "source-identity-mismatch",
    createInvoked: false,
  });

  host.setSourceLive(current.sessionId, false);
  const dead = await host.create({
    terminal: terminal("visible-n-dead"),
    visibility: visibility(current, "1"),
  });
  expect(dead).toMatchObject({ state: "rejected", reason: "source-not-live" });
}

async function assertRenewalRequiresCurrentRepresentation(
  host: NeutralVisibilityHostFixture,
): Promise<void> {
  const identity = source("source-o", 6104, "6104:100");
  host.publishSnapshot({ source: identity, inventoryRevision: "1", representedSessionKeys: ["visible-o"] });
  const { session } = requireCreated(await host.create({
    terminal: terminal("visible-o"),
    visibility: visibility(identity, "1"),
  }));
  expect(await host.renewVisibility({ session, visibility: visibility(identity, "1") }))
    .toMatchObject({ state: "active", lease: { acceptedRevision: "1" } });

  host.publishSnapshot({ source: identity, inventoryRevision: "2", representedSessionKeys: ["visible-o"] });
  expect(await host.renewVisibility({ session, visibility: visibility(identity, "2") }))
    .toMatchObject({ state: "active", lease: { acceptedRevision: "2" } });

  host.publishSnapshot({ source: identity, inventoryRevision: "3", representedSessionKeys: [] });
  expect(await host.renewVisibility({ session, visibility: visibility(identity, "3") }))
    .toMatchObject({
      state: "rejected",
      reason: "session-not-represented",
      renewed: false,
    });
}

async function assertExpiryTearsDownExactTree(host: NeutralVisibilityHostFixture): Promise<void> {
  const identity = source("source-p", 6105, "6105:100");
  host.publishSnapshot({ source: identity, inventoryRevision: "1", representedSessionKeys: ["visible-p"] });
  const createRequest = {
    terminal: terminal("visible-p"),
    visibility: visibility(identity, "1"),
  } as const;
  const { session } = requireCreated(await host.create(createRequest));
  host.setSourceLive(identity.sessionId, false);
  expect(await host.renewVisibility({ session, visibility: visibility(identity, "1") }))
    .toMatchObject({ state: "rejected", reason: "source-not-live", renewed: false });

  await host.advance(VISIBILITY_LEASE_MILLISECONDS - 1);
  expect(host.currentLease(session)?.state).toBe("active");
  expect((await host.inspect(session)).lifecycle).toBe("running");
  await host.advance(1);
  expect(host.currentLease(session)).toMatchObject({
    state: "expired",
    teardown: { state: "terminated", completeness: "complete" },
  });
  expect(host.expiryResult(session)).toMatchObject({
    state: "terminated",
    reap: { authority: "direct-parent", reaped: true, completeness: "complete" },
    survivors: [],
    completeness: "complete",
  });
  expect(await host.inspect(session)).toMatchObject({
    lifecycle: "exited",
    descendants: [],
    survivors: [],
  });
  const replayed = requireCreated(await host.create(createRequest));
  expect(replayed.session).toEqual(session);
  expect(replayed.lease.state).toBe("expired");
}

async function assertExpirySweepIsolatesTerminationErrors(): Promise<void> {
  const host = new NeutralVisibilityHostFixture();
  const identity = source("source-p-sweep", 6110, "6110:100");
  host.publishSnapshot({
    source: identity,
    inventoryRevision: "1",
    representedSessionKeys: ["visible-p-failed-launch", "visible-p-running"],
  });
  const failedTerminal = terminal("visible-p-failed-launch");
  const failed = requireCreated(await host.create({
    terminal: {
      ...failedTerminal,
      command: { ...failedTerminal.command, executable: "missing:command" },
    },
    visibility: visibility(identity, "1"),
  }));
  const running = requireCreated(await host.create({
    terminal: terminal("visible-p-running"),
    visibility: visibility(identity, "1"),
  }));

  await expect(host.advance(VISIBILITY_LEASE_MILLISECONDS)).resolves.toBeUndefined();
  expect(host.expiryResult(failed.session)).toMatchObject({
    state: "unknown",
    completeness: "unknown",
    reap: { authority: "unavailable", reaped: false, completeness: "unknown" },
  });
  expect(host.currentLease(failed.session)).toMatchObject({
    state: "expired",
    teardown: { state: "unknown", completeness: "unknown" },
  });
  expect(host.expiryResult(running.session)).toMatchObject({
    state: "terminated",
    completeness: "complete",
  });
  expect(host.currentLease(running.session)).toMatchObject({
    state: "expired",
    teardown: { state: "terminated", completeness: "complete" },
  });
  expect((await host.inspect(running.session)).lifecycle).toBe("exited");
  expect(await host.create({
    terminal: terminal("visible-p-failed-launch", "unreconciled-generation"),
    visibility: visibility(identity, "1"),
  })).toMatchObject({
    state: "rejected",
    reason: "duplicate-session-owner",
    createInvoked: false,
  });
}

async function assertIncompleteEvidenceStaysUnknown(
  host: NeutralVisibilityHostFixture,
): Promise<void> {
  const identity = source("source-q", 6106, "6106:100");
  host.publishSnapshot({
    source: identity,
    inventoryRevision: "1",
    representedSessionKeys: [],
    completeness: "partial",
  });
  expect(await host.create({
    terminal: terminal("visible-q"),
    visibility: visibility(identity, "1"),
  })).toMatchObject({
    state: "unknown",
    completeness: "partial",
    createInvoked: false,
    session: null,
    lease: null,
  });
  expect(await host.list()).toHaveLength(0);
}

async function assertDuplicateOwnershipFailsClosed(
  host: NeutralVisibilityHostFixture,
): Promise<void> {
  const first = source("source-r-one", 6107, "6107:100");
  const second = source("source-r-two", 6108, "6108:100");
  host.publishSnapshot({ source: first, inventoryRevision: "1", representedSessionKeys: ["visible-r"] });
  host.publishSnapshot({ source: second, inventoryRevision: "1", representedSessionKeys: ["visible-r"] });
  requireCreated(await host.create({
    terminal: terminal("visible-r", "create-visible-r-one"),
    visibility: visibility(first, "1"),
  }));
  expect(await host.create({
    terminal: terminal("visible-r", "create-visible-r-same-source"),
    visibility: visibility(first, "1"),
  })).toMatchObject({
    state: "rejected",
    reason: "duplicate-session-owner",
    createInvoked: false,
  });
  expect(await host.create({
    terminal: terminal("visible-r", "create-visible-r-two"),
    visibility: visibility(second, "1"),
  })).toMatchObject({
    state: "rejected",
    reason: "duplicate-session-owner",
    createInvoked: false,
  });
}

async function assertRenewalFencesSessionGeneration(
  host: NeutralVisibilityHostFixture,
): Promise<void> {
  const identity = source("source-s", 6109, "6109:100");
  host.publishSnapshot({ source: identity, inventoryRevision: "1", representedSessionKeys: ["visible-s"] });
  const { session } = requireCreated(await host.create({
    terminal: terminal("visible-s"),
    visibility: visibility(identity, "1"),
  }));
  expect(await host.renewVisibility({
    session: { ...session, incarnation: "reused-generation" },
    visibility: visibility(identity, "1"),
  })).toMatchObject({
    state: "rejected",
    reason: "session-generation-mismatch",
    renewed: false,
  });
}

describe("terminal-host visibility extension shape freeze", () => {
  test("contract and fixture versions are exact", () => {
    expect(TERMINAL_HOST_VISIBILITY_CONTRACT_VERSION).toBe("1.0.0");
    expect(NEUTRAL_VISIBILITY_FIXTURE_VERSION).toBe("1.0.0");
  });

  test("the extension vocabulary is project-neutral and has no implementation knobs", async () => {
    const sourceText = await readFile(resolve(
      import.meta.dir,
      "../../src/daemon/session-host/terminal-host-visibility-contract.ts",
    ), "utf8");
    for (const forbidden of [
      "Hive", "Workspace", "agent", "provider", "worktree", "pane", "tmux", "sessiond",
      "kill", "proc_pidinfo", "socket", "heartbeat", "renderer",
    ]) expect(sourceText).not.toContain(forbidden);
  });
});

describe("neutral visibility fixture freeze L–S with mutation controls", () => {
  const cases: readonly [
    string,
    (host: NeutralVisibilityHostFixture) => Promise<void>,
    VisibilityFreezeFault,
  ][] = [
    ["L exact binding and positive revision", assertExactLeaseBinding, "accept-invalid-revision"],
    ["M fresh revision and replay rejection", assertFreshRevision, "accept-stale-revision"],
    ["N live PID plus exact start-token identity", assertExactLiveSource, "ignore-source-identity"],
    ["O equal/later renewal requires current representation", assertRenewalRequiresCurrentRepresentation, "renew-absent-session"],
    ["P bounded expiry tears down the exact process tree", assertExpiryTearsDownExactTree, "never-expire"],
    ["Q incomplete evidence stays unknown", assertIncompleteEvidenceStaysUnknown, "claim-incomplete-evidence"],
    ["R duplicate source ownership fails closed", assertDuplicateOwnershipFailsClosed, "allow-duplicate-owner"],
    ["S renewal fences the exact session generation", assertRenewalFencesSessionGeneration, "ignore-session-generation"],
  ];

  for (const [name, assertion, fault] of cases) {
    test(`${name}: semantic passes and its deliberate violation goes red`, async () => {
      await assertion(new NeutralVisibilityHostFixture());
      await expect(assertion(new NeutralVisibilityHostFixture(fault))).rejects.toBeDefined();
    });
  }

  test("P: one throwing expiry teardown becomes unknown and does not skip later leases", async () => {
    await assertExpirySweepIsolatesTerminationErrors();
  });

  test("create rejections are sticky for one idempotency pair", async () => {
    const host = new NeutralVisibilityHostFixture();
    const identity = source("source-sticky", 6111, "6111:100");
    host.publishSnapshot({
      source: identity,
      inventoryRevision: "2",
      representedSessionKeys: ["visible-sticky"],
    });
    const rejected = await host.create({
      terminal: terminal("visible-sticky", "sticky-idempotency"),
      visibility: visibility(identity, "1"),
    });
    expect(rejected).toMatchObject({ state: "rejected", reason: "stale-revision" });
    expect(await host.create({
      terminal: terminal("visible-sticky", "sticky-idempotency"),
      visibility: visibility(identity, "2"),
    })).toEqual(rejected);
    expect((await host.create({
      terminal: terminal("visible-sticky", "corrected-idempotency"),
      visibility: visibility(identity, "2"),
    })).state).toBe("created");
  });
});
