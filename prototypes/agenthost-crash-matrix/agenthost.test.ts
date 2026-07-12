import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "./src/host";
import { BoundedWal, isoNow, WalOverflowError } from "./src/wal";
import type { HostConfig, ReconnectReport, WalRecord } from "./src/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenthost-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("bounded WAL", () => {
  test("repairs a torn final record and preserves monotonic semantic state", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "host.wal");
    const record: WalRecord = {
      kind: "EVENT",
      at: isoNow(),
      event: {
        sequence: 1,
        providerEventId: "provider:1",
        commandId: "command-1",
        brokerGeneration: 1,
        sessionEpoch: 0,
        observedAt: isoNow(),
        type: "turn_started",
        payload: {},
      },
    };
    writeFileSync(path, `${JSON.stringify(record)}\n{\"kind\":`);
    const wal = new BoundedWal(path, 4096);
    expect(wal.events()).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });

  test("compacts acknowledged events but refuses to discard unacknowledged boundaries", () => {
    const directory = temporaryDirectory();
    const wal = new BoundedWal(join(directory, "host.wal"), 1_000);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      wal.append({
        kind: "EVENT",
        at: isoNow(),
        event: {
          sequence,
          providerEventId: `event-${sequence}`,
          commandId: "command-1",
          brokerGeneration: 1,
          sessionEpoch: 0,
          observedAt: isoNow(),
          type: "tool_output",
          payload: { text: "x".repeat(40) },
        },
      });
    }
    wal.append({ kind: "ACK", at: isoNow(), highWaterMark: 3 });
    expect(() => wal.append({
      kind: "EVENT",
      at: isoNow(),
      event: {
        sequence: 4,
        providerEventId: "event-4",
        commandId: "command-1",
        brokerGeneration: 1,
        sessionEpoch: 0,
        observedAt: isoNow(),
        type: "tool_output",
        payload: { text: "y".repeat(300) },
      },
    })).not.toThrow();
    expect(wal.events().map((event) => event.sequence)).toEqual([4]);

    const tiny = new BoundedWal(join(directory, "tiny.wal"), 280);
    expect(() => tiny.append({
      kind: "EVENT",
      at: isoNow(),
      event: {
        sequence: 1,
        providerEventId: "too-large",
        commandId: "command-1",
        brokerGeneration: 1,
        sessionEpoch: 0,
        observedAt: isoNow(),
        type: "tool_output",
        payload: { text: "z".repeat(500) },
      },
    })).toThrow(WalOverflowError);
  });
});

describe("AgentHost", () => {
  test("fsyncs ACCEPTED before provider write and never duplicates command or approval", async () => {
    const directory = temporaryDirectory();
    const config: HostConfig = {
      tenantId: "tenant-test",
      authToken: "secret",
      vendor: "claude",
      socketPath: join(directory, "host.sock"),
      stateDir: join(directory, "state"),
      boundary: "after_accept_before_write",
      maxWalBytes: 64 * 1024,
    };
    const host = new AgentHost(config);
    await host.start();
    const command = {
      commandId: "command-1",
      brokerGeneration: 1,
      sessionEpoch: 0,
      prompt: "execute once",
    };
    void host.accept(command);
    await waitFor(() => host.report().inFlightPhase === "accepted", "ACCEPTED boundary");
    const beforeWrite = readFileSync(join(config.stateDir, "host.wal.jsonl"), "utf8");
    expect(beforeWrite).toContain('"kind":"ACCEPTED"');
    expect(beforeWrite).not.toContain("execute once");
    expect(() => readFileSync(join(config.stateDir, "provider-ledger.json"), "utf8")).toThrow();

    await host.accept(command);
    host.releaseBoundary();
    await waitFor(() => host.report().pendingApprovalId !== null, "approval request");
    const approvalId = host.report().pendingApprovalId!;
    await host.approve(approvalId, "approve");
    await host.approve(approvalId, "approve").catch(() => undefined);
    await waitFor(() => host.report().inFlightPhase === "terminal_durable", "terminal event");
    const ledger = JSON.parse(readFileSync(join(config.stateDir, "provider-ledger.json"), "utf8"));
    expect(ledger.promptExecutions).toBe(1);
    expect(ledger.approvalExecutions).toBe(1);
    expect(ledger.toolExecutions).toBe(1);
    const report: ReconnectReport = host.report();
    expect(report.childIdentity?.processGroupId).toBe(report.childIdentity?.pid);
    expect(report.vendorSessionId).toStartWith("claude-");
    expect(report.lastAcceptedCommand).toMatchObject({ commandId: "command-1" });
    expect(report.lastEventSequence).toBeGreaterThan(0);
    host.acknowledge(report.lastEventSequence);
    expect(host.report().replay).toEqual([]);
    await host.shutdown();
  });

  test("never replays an accepted approval whose provider outcome is missing", async () => {
    const directory = temporaryDirectory();
    const stateDir = join(directory, "state");
    const config: HostConfig = {
      tenantId: "tenant-test",
      authToken: "secret",
      vendor: "codex",
      socketPath: join(directory, "host.sock"),
      stateDir,
      boundary: "during_tool_approval",
      maxWalBytes: 64 * 1024,
    };
    const wal = new BoundedWal(join(stateDir, "host.wal.jsonl"), config.maxWalBytes);
    wal.append({
      kind: "ACCEPTED",
      at: isoNow(),
      command: { commandId: "command-approval", brokerGeneration: 1, sessionEpoch: 0 },
    });
    wal.append({ kind: "COMMAND_WRITTEN", at: isoNow(), commandId: "command-approval" });
    wal.append({
      kind: "EVENT",
      at: isoNow(),
      event: {
        sequence: 1,
        providerEventId: "approval-request",
        commandId: "command-approval",
        brokerGeneration: 1,
        sessionEpoch: 0,
        observedAt: isoNow(),
        type: "approval_requested",
        payload: { approvalId: "approval-1" },
      },
    });
    wal.append({
      kind: "APPROVAL_WRITTEN",
      at: isoNow(),
      approvalId: "approval-1",
      decision: "approve",
    });
    writeFileSync(join(stateDir, "provider-ledger.json"), `${JSON.stringify({
      vendor: "codex",
      vendorSessionId: "codex-session",
      state: "pending_approval",
      commandId: "command-approval",
      promptExecutions: 1,
      approvalExecutions: 0,
      toolExecutions: 0,
      approvalId: "approval-1",
      finalText: null,
    })}\n`);

    const recovered = new AgentHost(config);
    await recovered.start();
    expect(recovered.report().inFlightPhase).toBe("unknown_outcome");
    expect(recovered.report().replay.at(-1)?.type).toBe("UNKNOWN_OUTCOME");
    const ledger = JSON.parse(readFileSync(join(stateDir, "provider-ledger.json"), "utf8"));
    expect(ledger.approvalExecutions).toBe(0);
    expect(ledger.toolExecutions).toBe(0);
    await recovered.shutdown();
  });
});
