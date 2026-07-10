import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { ProviderLedger, Vendor } from "./types";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]!, process.argv[index + 1]!);
}
const vendor = args.get("--vendor") as Vendor;
const ledgerPath = args.get("--ledger")!;
const resume = args.get("--resume") === "true";

function save(ledger: ProviderLedger): void {
  const temporary = `${ledgerPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  const descriptor = openSync(temporary, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
  renameSync(temporary, ledgerPath);
}

function load(): ProviderLedger {
  if (existsSync(ledgerPath)) return JSON.parse(readFileSync(ledgerPath, "utf8"));
  return {
    vendor,
    vendorSessionId: `${vendor}-${randomUUID()}`,
    state: "idle",
    commandId: null,
    promptExecutions: 0,
    approvalExecutions: 0,
    toolExecutions: 0,
    approvalId: null,
    finalText: null,
  };
}

let ledger = load();
const emit = (type: string, providerEventId: string, payload: Record<string, unknown> = {}) => {
  process.stdout.write(`${JSON.stringify({ type, providerEventId, payload })}\n`);
};

function emitThroughApproval(): void {
  const commandId = ledger.commandId!;
  emit("session_started", `${commandId}:session`, {
    vendorSessionId: ledger.vendorSessionId,
    resumed: resume,
  });
  emit("turn_started", `${commandId}:turn`, {});
  emit("tool_started", `${commandId}:tool-start`, { tool: "fixture.write" });
  ledger.state = "pending_approval";
  ledger.approvalId = `${commandId}:approval`;
  save(ledger);
  emit("approval_requested", `${commandId}:approval-request`, {
    approvalId: ledger.approvalId,
    replayedPendingRequest: resume,
  });
}

function emitCompleted(): void {
  const commandId = ledger.commandId!;
  emit("session_started", `${commandId}:session`, {
    vendorSessionId: ledger.vendorSessionId,
    resumed: true,
  });
  emit("assistant_final", `${commandId}:final`, {
    text: ledger.finalText,
    recoveredFromVendorSession: true,
  });
  emit("turn_completed", `${commandId}:complete`, { status: "completed" });
}

if (resume) {
  if (ledger.state === "working" || ledger.state === "pending_approval") emitThroughApproval();
  if (ledger.state === "completed") emitCompleted();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "command") {
      if (ledger.commandId !== null) continue;
      ledger.commandId = String(message.commandId);
      ledger.promptExecutions += 1;
      ledger.state = "working";
      save(ledger);
      emitThroughApproval();
      continue;
    }
    if (message.type === "approval" && message.approvalId === ledger.approvalId) {
      if (ledger.state !== "pending_approval") continue;
      ledger.approvalExecutions += 1;
      if (message.decision === "approve") ledger.toolExecutions += 1;
      emit("tool_result", `${ledger.commandId}:tool-result`, {
        approved: message.decision === "approve",
      });
      ledger.finalText = `${vendor.toUpperCase()}_FIXTURE_COMPLETE`;
      ledger.state = "completed";
      save(ledger);
      emit("assistant_final", `${ledger.commandId}:final`, { text: ledger.finalText });
      emit("turn_completed", `${ledger.commandId}:complete`, { status: "completed" });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
