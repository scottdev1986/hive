import { describe, expect, test } from "bun:test";
import {
  FakeProviderAdapter,
  fakeCapabilities,
} from "../src/adapters/providers/protocol/fake-driver";
import {
  capabilityFinding,
  capabilitySupport,
  type NormalizedProviderEvent,
  steadyStateUnknowns,
  unprovenBaseline,
} from "../src/adapters/providers/protocol/types";
import {
  BASELINE_CAPABILITIES,
  type MeasuredProviderCapabilities,
  OPTIONAL_CAPABILITIES,
} from "../src/schemas/capability";

function capabilitiesWith(
  measured: MeasuredProviderCapabilities["measured"],
): MeasuredProviderCapabilities {
  return { ...fakeCapabilities(), measured };
}

describe("measured provider capabilities", () => {
  test("an unwritten capability reads unknown, never unsupported", () => {
    const capabilities = capabilitiesWith({});

    expect(capabilitySupport(capabilities, "questions")).toBe("unknown");
    expect(capabilitySupport(capabilities, "prompt")).toBe("unknown");
  });

  test("a written capability reads back, so the reader can see a positive", () => {
    const capabilities = capabilitiesWith({
      questions: "supported",
      fork: "unsupported",
    });

    expect(capabilitySupport(capabilities, "questions")).toBe("supported");
    expect(capabilitySupport(capabilities, "fork")).toBe("unsupported");
  });

  test("silence fails the baseline matrix rather than passing it", () => {
    expect(unprovenBaseline(capabilitiesWith({}))).toEqual(
      BASELINE_CAPABILITIES,
    );
  });

  test("every baseline row must be measured supported to pass", () => {
    for (const missing of BASELINE_CAPABILITIES) {
      // SAFETY: The test owns this value and its fields.
      const measured = Object.fromEntries(
        BASELINE_CAPABILITIES.filter((name) => name !== missing).map((name) => [
          name,
          "supported",
        ]),
      ) as MeasuredProviderCapabilities["measured"];

      expect(unprovenBaseline(capabilitiesWith(measured))).toEqual([missing]);
    }
  });

  test("a fully measured fake passes the baseline", () => {
    expect(unprovenBaseline(fakeCapabilities())).toEqual([]);
  });

  test("an optional gap never fails the baseline", () => {
    const capabilities = fakeCapabilities();
    expect(capabilitySupport(capabilities, "fork")).toBe("unknown");
    expect(unprovenBaseline(capabilities)).toEqual([]);
  });
});

describe("the fake provider driver", () => {
  test("delivers emitted events in order with monotonic sequences", async () => {
    const adapter = new FakeProviderAdapter();
    const session = await adapter.connect({
      provider: "claude",
      executable: "/fake/provider",
      argv: [],
      cwd: "/fake/cwd",
      env: {},
    });

    const received: NormalizedProviderEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events) {
        received.push(event);
        if (event.kind === "turn-idle") break;
      }
    })();

    const driver = adapter.session;
    if (driver === null) throw new Error("connect did not expose a session");
    driver.emit({ kind: "runtime-ready" });
    driver.emit({ kind: "turn-started", turnId: "t1" });
    driver.emit({ kind: "message-delta", turnId: "t1", text: "hello" });
    driver.emit({ kind: "turn-idle", turnId: "t1" });

    await reader;

    expect(received.map((event) => event.kind)).toEqual([
      "runtime-ready",
      "turn-started",
      "message-delta",
      "turn-idle",
    ]);
    expect(received.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(received[0]?.raw).toEqual({ fake: "runtime-ready" });
  });

  test("records submissions and reports the outcome the test chose", async () => {
    const adapter = new FakeProviderAdapter();
    await adapter.connect({
      provider: "claude",
      executable: "/fake/provider",
      argv: [],
      cwd: "/fake/cwd",
      env: {},
    });
    const driver = adapter.session;
    if (driver === null) throw new Error("connect did not expose a session");

    const ref = await driver.newSession({ cwd: "/fake/cwd" });
    driver.submitOutcome = "unknown";
    const receipt = await driver.submit({
      session: ref,
      clientInputId: "input-1",
      text: "ship it",
    });

    expect(receipt).toEqual({
      clientInputId: "input-1",
      outcome: "unknown",
      turnId: null,
    });
    expect(driver.submissions).toEqual([
      {
        clientInputId: "input-1",
        text: "ship it",
        vendorSessionId: ref.vendorSessionId,
      },
    ]);
  });

  test("load replays history and resume does not", async () => {
    const adapter = new FakeProviderAdapter();
    await adapter.connect({
      provider: "claude",
      executable: "/fake/provider",
      argv: [],
      cwd: "/fake/cwd",
      env: {},
    });
    const driver = adapter.session;
    if (driver === null) throw new Error("connect did not expose a session");

    expect(
      await driver.resumeSession({ vendorSessionId: "v1", style: "load" }),
    ).toEqual({ vendorSessionId: "v1", replayedHistory: true });
    expect(
      await driver.resumeSession({ vendorSessionId: "v1", style: "resume" }),
    ).toEqual({ vendorSessionId: "v1", replayedHistory: false });
  });

  test("closing ends the event stream", async () => {
    const adapter = new FakeProviderAdapter();
    const session = await adapter.connect({
      provider: "claude",
      executable: "/fake/provider",
      argv: [],
      cwd: "/fake/cwd",
      env: {},
    });
    await session.close();

    const received: NormalizedProviderEvent[] = [];
    for await (const event of session.events) received.push(event);

    expect(received).toEqual([]);
    expect(adapter.session?.closed).toBe(true);
  });
});

describe("proven absence versus ignorance", () => {
  test("a datum nobody measured or researched is a steady-state unknown", () => {
    const capabilities = capabilitiesWith({});

    expect(capabilityFinding(capabilities, "contextUsage")).toEqual({
      state: "unknown",
    });
    expect(steadyStateUnknowns(capabilities)).toContain("contextUsage");
  });

  test("a researched absence is a finding with its citation, not an unknown", () => {
    const capabilities: MeasuredProviderCapabilities = {
      ...fakeCapabilities(),
      absences: {
        contextUsage: {
          reason: "Kimi does not report context usage",
          citation: "docs/evidence/protocol-terminal/kimi/conformance.json",
        },
      },
    };

    expect(capabilityFinding(capabilities, "contextUsage")).toEqual({
      state: "not-reported",
      absence: {
        reason: "Kimi does not report context usage",
        citation: "docs/evidence/protocol-terminal/kimi/conformance.json",
      },
    });
    expect(steadyStateUnknowns(capabilities)).not.toContain("contextUsage");
  });

  test("a fully measured, fully researched vendor has zero steady-state unknowns", () => {
    const absences = Object.fromEntries(
      OPTIONAL_CAPABILITIES.map((name) => [
        name,
        { reason: `fake does not report ${name}`, citation: "fixture" },
      ]),
    );
    const capabilities: MeasuredProviderCapabilities = {
      ...fakeCapabilities(),
      absences,
    };

    expect(steadyStateUnknowns(capabilities)).toEqual([]);
  });

  test("a measured capability outranks an absence claim for the same datum", () => {
    const capabilities: MeasuredProviderCapabilities = {
      ...fakeCapabilities(),
      absences: {
        prompt: { reason: "claimed absent", citation: "stale note" },
      },
    };

    expect(capabilityFinding(capabilities, "prompt")).toEqual({
      state: "supported",
    });
  });

  test("the baseline reader is unchanged, so adapters built against it still pass", () => {
    expect(unprovenBaseline(fakeCapabilities())).toEqual([]);
    expect(capabilitySupport(fakeCapabilities(), "prompt")).toBe("supported");
  });
});
