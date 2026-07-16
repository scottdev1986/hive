import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TmuxAdapter, type TmuxRunner } from "../../adapters/tmux";
import { SessionLocatorSchema } from "../../schemas/session-protocol";
import type { SessionSpec, TerminalGeometry } from "./contract";
import {
  LegacyUnboundTmuxSessionsError,
  mintTmuxSessionLocator,
  TmuxSessionHost,
} from "./tmux-host";

const geometry: TerminalGeometry = {
  columns: 90,
  rows: 30,
  widthPx: 900,
  heightPx: 600,
  cellWidthPx: 10,
  cellHeightPx: 20,
};

function fixture() {
  let present = false;
  const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
  const run: TmuxRunner = async (args, _socket, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    switch (args[0]) {
      case "has-session":
        return present
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "can't find session", exitCode: 1 };
      case "new-session":
        present = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      case "kill-session":
        present = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      case "display-message":
        return { stdout: "90\t30\t4\t5\t1\n", stderr: "", exitCode: 0 };
      case "capture-pane":
        return { stdout: "first\nsecond\nthird", stderr: "", exitCode: 0 };
      case "list-clients":
      case "list-panes":
        return { stdout: "", stderr: "", exitCode: 0 };
      case "list-sessions":
        return {
          stdout: present ? "hive-maya\n" : "",
          stderr: "",
          exitCode: 0,
        };
      default:
        return { stdout: "", stderr: "", exitCode: 0 };
    }
  };
  const adapter = new TmuxAdapter("test", {
    run,
    sleep: async () => {},
    enterDelayMs: 0,
  });
  const host = new TmuxSessionHost({
    adapter,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
  const locator = mintTmuxSessionLocator(
    "instance-a",
    { kind: "agent", agentId: "agent-maya" },
    1,
    Date.parse("2026-07-16T12:00:00.000Z"),
  );
  host.bind(locator, "hive-maya", { capabilityEpoch: 4 });
  const spec: SessionSpec = {
    schemaVersion: 1,
    locator,
    provider: "codex",
    toolSessionId: null,
    cwd: "/tmp/hive-maya",
    argv: ["codex", "--model", "gpt-5"],
    environment: {},
    expectedExecutable: "codex",
    readOnly: false,
    capabilityEpoch: 4,
    geometry,
    launchGrantId: "launch-1",
    launchGrantRevision: 1,
  };
  return { host, locator, spec, calls };
}

describe("TmuxSessionHost", () => {
  test("routes lifecycle, capture, resize, and automated input through an exact locator", async () => {
    const { host, locator, spec, calls } = fixture();
    const created = await host.create(spec, new Uint8Array());
    expect(created.created).toBe(true);
    expect(created.inspection).toEqual(expect.objectContaining({
      locator,
      presence: "present",
      complete: false,
      executableVerified: false,
    }));

    const capture = await host.capture(locator, {
      include: "visible-text",
      maxRows: 2,
    });
    expect(capture).toEqual(expect.objectContaining({
      text: "second\nthird",
      truncated: true,
      columns: 90,
      rows: 30,
    }));
    expect(capture.sha256).toBe(
      createHash("sha256").update("second\nthird").digest("hex"),
    );

    const bytes = new TextEncoder().encode("review this");
    const input = {
      transactionId: "tx-1",
      idempotencyKey: "idem-1",
      messageId: "msg-1",
      recipientGeneration: 1,
      capabilityEpoch: 4,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      providerStrategy: "normal",
      submit: "return" as const,
    };
    const receipt = await host.writeAutomated(locator, input);
    expect(receipt.state).toBe("written");
    expect(await host.writeAutomated(locator, input)).toBe(receipt);
    expect(calls.filter((call) => call.args[0] === "load-buffer")).toHaveLength(1);

    await host.resize(locator, { ...geometry, columns: 100 });
    expect(calls.some((call) => call.args[0] === "resize-window")).toBe(true);
    const terminated = await host.terminate(locator, {
      mode: "immediate",
      reason: "test",
      requestId: "term-1",
    });
    expect(terminated.state).toBe("terminated");
    expect((await host.inspect(locator)).presence).toBe("lost");
  });

  test("marks tmux-only attach and visibility semantics as degraded evidence", async () => {
    const { host, locator, spec } = fixture();
    await host.create(spec, new Uint8Array());
    const attachment = await host.compatibilityAttach(locator, {
      viewerId: "viewer-1",
      geometry,
      operations: ["view", "human-input", "resize"],
    });
    expect(attachment).toEqual(expect.objectContaining({
      tmuxSession: "hive-maya",
      socketName: "test",
    }));
    expect(attachment.grant).toEqual(expect.objectContaining({
      endpoint: "tmux-compatibility",
      token: "",
      engineBuildId: "tmux-build-unknown",
    }));
    expect(await host.renewVisibility(locator, {
      workspaceSessionId: "workspace-1",
      workspacePid: 10,
      workspaceStartToken: "start",
      openTerminalRevision: "7",
    })).toEqual(expect.objectContaining({
      state: "active",
      openTerminalRevision: "7",
    }));
  });

  test("reports live sessions without bindings as typed legacy unknowns", async () => {
    const { host, spec } = fixture();
    await host.create(spec, new Uint8Array());
    const detailed = await host.listDetailed("another-instance");
    expect(detailed).toEqual({
      inspections: [],
      legacyUnbound: [expect.objectContaining({
        tmuxSession: "hive-maya",
        locator: null,
        presence: "unknown",
        complete: false,
        diagnosticIds: ["TMUX_LEGACY_UNBOUND"],
      })],
      complete: false,
    });
    expect(host.list("another-instance")).rejects.toBeInstanceOf(
      LegacyUnboundTmuxSessionsError,
    );
  });

  test("mints schema-valid random UUIDv7 locators", () => {
    const first = mintTmuxSessionLocator(
      "instance-a",
      { kind: "root" },
      1,
      Date.parse("2026-07-16T12:00:00.000Z"),
    );
    const second = mintTmuxSessionLocator(
      "instance-a",
      { kind: "root" },
      1,
      Date.parse("2026-07-16T12:00:00.000Z"),
    );
    expect(SessionLocatorSchema.parse(first)).toEqual(first);
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});
