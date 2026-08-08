/**
 * Durable provider resume: the conversation identity survives a crash because
 * it was written down when the vendor issued it. Provider, transport, and
 * workspace bind the ref; a marketing version does not override the protocol.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DurableSessionRecord,
  decideResume,
  openProviderSession,
  readStoredSession,
} from "../src/adapters/providers/protocol/durable-session";
import {
  FakeProviderAdapter,
  fakeCapabilities,
} from "../src/adapters/providers/protocol/fake-driver";
import type { ProviderSpawn } from "../src/adapters/providers/protocol/types";
import type { MeasuredProviderCapabilities } from "../src/schemas/capability";
import { tempRootAsync } from "./temp-root";

async function paneDirectory(): Promise<string> {
  return tempRootAsync("hive-durable-resume-");
}

function spawnInto(cwd: string): ProviderSpawn {
  return {
    provider: "claude",
    executable: "/fake/provider",
    argv: [],
    cwd,
    env: {},
  };
}

function capabilities(
  overrides: {
    version?: string;
    cwd?: string;
    transport?: MeasuredProviderCapabilities["runtime"]["transport"];
    provider?: MeasuredProviderCapabilities["provider"];
    sessionRecovery?: "supported" | "unsupported";
  } = {},
): MeasuredProviderCapabilities {
  const base = fakeCapabilities();
  return {
    ...base,
    provider: overrides.provider ?? base.provider,
    runtime: {
      ...base.runtime,
      version: overrides.version ?? base.runtime.version,
      workingDirectory: overrides.cwd ?? base.runtime.workingDirectory,
      transport: overrides.transport ?? base.runtime.transport,
    },
    measured: {
      ...base.measured,
      sessionRecovery: overrides.sessionRecovery ?? "supported",
    },
  };
}

function storedRecord(
  identity: Partial<DurableSessionRecord["identity"]> = {},
  vendorSessionId = "conversation-from-before-the-crash",
): DurableSessionRecord {
  const live = capabilities();
  return {
    schemaVersion: 1,
    identity: {
      provider: live.provider,
      transport: live.runtime.transport,
      version: live.runtime.version,
      cwd: live.runtime.workingDirectory,
      ...identity,
    },
    session: { vendorSessionId, replayedHistory: false },
    recordedAt: "2026-08-02T00:00:00.000Z",
  };
}

describe("durable session ref", () => {
  test("a first start creates a session and records the ref it was given", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    const adapter = new FakeProviderAdapter(capabilities({ cwd: pane }));

    const opened = await openProviderSession(adapter, spawnInto(pane), store);

    expect(opened.decision.outcome).toBe("no-stored-session");
    expect(opened.vendorSession.vendorSessionId).toBe("fake-session-1");

    const stored = await readStoredSession(store);
    expect(stored.state).toBe("present");
    if (stored.state !== "present") return;
    expect(stored.record.session.vendorSessionId).toBe("fake-session-1");
    expect(stored.record.identity).toEqual({
      provider: "claude",
      transport: "fake",
      version: "0.0.0-fake",
      cwd: pane,
    });
  });

  test("a restart resumes the recorded conversation through the protocol", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(
      store,
      JSON.stringify(storedRecord({ cwd: pane }), null, 2),
    );
    const adapter = new FakeProviderAdapter(capabilities({ cwd: pane }));

    const opened = await openProviderSession(adapter, spawnInto(pane), store);

    expect(opened.decision).toEqual({
      outcome: "resume",
      vendorSessionId: "conversation-from-before-the-crash",
    });
    // The fake echoes a resumed id and mints a new one for newSession, so this
    // is the conversation from the record and not a replacement for it.
    expect(opened.vendorSession.vendorSessionId).toBe(
      "conversation-from-before-the-crash",
    );
    expect(opened.vendorSession.replayedHistory).toBe(true);
  });

  test("the resumed id comes from the record alone — the pane holds no vendor artifacts", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(
      store,
      JSON.stringify(storedRecord({ cwd: pane }), null, 2),
    );
    const adapter = new FakeProviderAdapter(capabilities({ cwd: pane }));

    const opened = await openProviderSession(adapter, spawnInto(pane), store);

    expect(opened.decision.outcome).toBe("resume");
    expect(await readdir(pane)).toEqual(["session.json"]);
  });

  test("a rewritten record keeps the resumed ref, not the one it replaced", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(
      store,
      JSON.stringify(
        storedRecord({ cwd: pane }, "first-conversation"),
        null,
        2,
      ),
    );
    const adapter = new FakeProviderAdapter(capabilities({ cwd: pane }));

    await openProviderSession(
      adapter,
      spawnInto(pane),
      store,
      () => "2026-08-02T12:00:00.000Z",
    );

    const record = JSON.parse(
      await readFile(store, "utf8"),
    ) as DurableSessionRecord;
    expect(record.session.vendorSessionId).toBe("first-conversation");
    expect(record.session.replayedHistory).toBe(true);
    expect(record.recordedAt).toBe("2026-08-02T12:00:00.000Z");
  });
});

describe("resume eligibility", () => {
  test("a version change leaves compatibility to the provider protocol", () => {
    const decision = decideResume(
      { state: "present", record: storedRecord({ version: "0.0.0-fake" }) },
      capabilities({ version: "9.9.9-upgraded" }),
    );
    expect(decision).toEqual({
      outcome: "resume",
      vendorSessionId: "conversation-from-before-the-crash",
    });
  });

  test("a version change resumes and records the currently observed version", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(
      store,
      JSON.stringify(
        storedRecord({ cwd: pane, version: "0.0.0-fake" }),
        null,
        2,
      ),
    );
    const adapter = new FakeProviderAdapter(
      capabilities({ cwd: pane, version: "9.9.9-upgraded" }),
    );

    const opened = await openProviderSession(adapter, spawnInto(pane), store);

    expect(opened.decision.outcome).toBe("resume");
    expect(opened.vendorSession.vendorSessionId).toBe(
      "conversation-from-before-the-crash",
    );
    expect(opened.vendorSession.replayedHistory).toBe(true);

    const stored = await readStoredSession(store);
    expect(stored.state).toBe("present");
    if (stored.state !== "present") return;
    expect(stored.record.identity.version).toBe("9.9.9-upgraded");
  });

  test("a different transport, provider, or working directory refuses", () => {
    for (const [field, live] of [
      ["transport", capabilities({ transport: "acp" })],
      ["provider", capabilities({ provider: "codex" })],
      ["cwd", capabilities({ cwd: "/somewhere/else" })],
    ] as const) {
      const decision = decideResume(
        { state: "present", record: storedRecord() },
        live,
      );
      expect(decision.outcome).toBe("refused");
      if (decision.outcome !== "refused") continue;
      expect(decision.reason).toContain(field);
    }
  });

  test("a runtime proven not to recover sessions refuses", () => {
    const decision = decideResume(
      { state: "present", record: storedRecord() },
      capabilities({ sessionRecovery: "unsupported" }),
    );
    expect(decision.outcome).toBe("refused");
    if (decision.outcome !== "refused") return;
    expect(decision.reason).toContain("sessionRecovery");
  });

  test("an unreadable record refuses instead of reading as a first run", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(store, '{"schemaVersion": 1, "identi');

    const stored = await readStoredSession(store);
    expect(stored.state).toBe("unreadable");
    expect(decideResume(stored, capabilities()).outcome).toBe("refused");
  });

  test("a record from a future schema refuses", async () => {
    const pane = await paneDirectory();
    const store = join(pane, "session.json");
    await writeFile(
      store,
      JSON.stringify({ ...storedRecord(), schemaVersion: 2 }),
    );

    const stored = await readStoredSession(store);
    expect(stored.state).toBe("unreadable");
    if (stored.state !== "unreadable") return;
    expect(stored.detail).toContain("schemaVersion 2");
  });

  test("a missing record is a first run, not a refusal", async () => {
    const pane = await paneDirectory();
    const stored = await readStoredSession(join(pane, "session.json"));
    expect(stored.state).toBe("absent");
    expect(decideResume(stored, capabilities()).outcome).toBe(
      "no-stored-session",
    );
  });
});
