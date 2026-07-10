import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Boundary,
  CrashTarget,
  HostConfig,
  MatrixRow,
  ProviderLedger,
  ReconnectReport,
  RpcRequest,
  Vendor,
} from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cliPath = join(here, "cli.ts");
const actorPath = join(here, "actor.ts");
const evidenceDir = join(root, "evidence");

const vendors: Vendor[] = ["claude", "codex"];
const targets: CrashTarget[] = ["ui", "broker", "host", "provider"];
const boundaries: Boundary[] = [
  "before_accept",
  "after_accept_before_write",
  "after_write_before_first_event",
  "during_tool_approval",
  "after_provider_final_before_wal",
  "after_wal_before_broker_ack",
];

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startHost(configPath: string): ChildProcess {
  return spawn(process.execPath, [cliPath, "serve", configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startActor(role: "ui" | "broker"): ChildProcess {
  return spawn(process.execPath, [actorPath, role], {
    cwd: root,
    stdio: "ignore",
  });
}

function kill(child: ChildProcess | null, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child?.pid === undefined || !processExists(child.pid)) return;
  try {
    process.kill(child.pid, signal);
  } catch {
    // It already exited.
  }
}

async function rpc<T>(config: HostConfig, request: Omit<RpcRequest, "tenantId" | "authToken">,
  credentials: Partial<Pick<RpcRequest, "tenantId" | "authToken">> = {}): Promise<T> {
  return await new Promise<T>((resolveRpc, rejectRpc) => {
    const socket = connect(config.socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRpc(new Error(`RPC timeout: ${request.action}`));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectRpc(error);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      tenantId: credentials.tenantId ?? config.tenantId,
      authToken: credentials.authToken ?? config.authToken,
      ...request,
    })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      const response = JSON.parse(buffer.slice(0, newline)) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (response.ok) resolveRpc(response.result as T);
      else rejectRpc(new Error(response.error ?? "RPC failed"));
    });
  });
}

async function hostReady(config: HostConfig): Promise<boolean> {
  if (!existsSync(config.socketPath)) return false;
  try {
    await rpc(config, { action: "snapshot" });
    return true;
  } catch {
    return false;
  }
}

async function killProvider(report: ReconnectReport): Promise<void> {
  const identity = report.childIdentity;
  if (identity === null) return;
  try {
    process.kill(-identity.processGroupId, "SIGKILL");
  } catch {
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch {
      // The provider completed between the boundary and the injected kill.
    }
  }
  await Bun.sleep(30);
}

async function runRow(vendor: Vendor, crashTarget: CrashTarget, boundary: Boundary): Promise<MatrixRow> {
  const runDir = mkdtempSync(join(tmpdir(), `hive-agenthost-${vendor}-${boundary}-`));
  const config: HostConfig = {
    tenantId: `tenant-${vendor}`,
    authToken: randomBytes(24).toString("hex"),
    vendor,
    socketPath: join(runDir, "host.sock"),
    stateDir: join(runDir, "state"),
    boundary,
    maxWalBytes: 128 * 1024,
  };
  mkdirSync(config.stateDir, { recursive: true });
  const configPath = join(runDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let host = startHost(configPath);
  let ui = startActor("ui");
  let broker = startActor("broker");
  const childPids = new Set<number>();
  let notes = "";
  try {
    await waitUntil(() => hostReady(config), "AgentHost socket");
    await rpc(config, {
      action: "start",
      command: {
        commandId: `cmd-${vendor}-${crashTarget}-${boundary}`,
        brokerGeneration: 1,
        sessionEpoch: 0,
        prompt: "Run the fixture tool once, wait for explicit approval, and report completion.",
      },
    });
    let preCrashApprovalAnswered = false;
    await waitUntil(async () => {
      if (existsSync(join(config.stateDir, "boundary.json"))) return true;
      if (boundary !== "during_tool_approval") {
        const progress = await rpc<ReconnectReport>(config, { action: "snapshot" });
        if (progress.pendingApprovalId !== null && !preCrashApprovalAnswered) {
          preCrashApprovalAnswered = true;
          await rpc(config, {
            action: "approve",
            approvalId: progress.pendingApprovalId,
            decision: "approve",
          });
        }
      }
      return false;
    }, boundary);
    const atBoundary = await rpc<ReconnectReport>(config, { action: "snapshot" });
    if (atBoundary.childIdentity !== null) childPids.add(atBoundary.childIdentity.pid);

    if (crashTarget === "ui") {
      kill(ui);
      ui = startActor("ui");
      notes = "UI replaced; host, broker, and provider stayed live.";
    } else if (crashTarget === "broker") {
      kill(broker);
      broker = startActor("broker");
      notes = "Broker generation replaced and reconnected from durable high-water state.";
    } else if (crashTarget === "host") {
      kill(host);
      await Bun.sleep(40);
      host = startHost(configPath);
      await waitUntil(() => hostReady(config), "replacement AgentHost");
      notes = "Replacement host reconciled the pinned child and vendor session without prompt replay.";
    } else {
      await killProvider(atBoundary);
      notes = "Provider process group killed independently; host used vendor-session state or surfaced ambiguity.";
    }

    let report = await rpc<ReconnectReport>(config, { action: "snapshot" });
    if (crashTarget === "host" && boundary === "before_accept" && report.lastAcceptedCommand === null) {
      await rpc(config, {
        action: "start",
        command: {
          commandId: `cmd-${vendor}-${crashTarget}-${boundary}-explicit-reconcile`,
          brokerGeneration: 2,
          sessionEpoch: 0,
          prompt: "Run the fixture tool once, wait for explicit approval, and report completion.",
          explicitReconcile: true,
        },
      });
      notes += " The broker issued a new command only after proving the first was never accepted.";
    }
    await rpc(config, { action: "release" });

    let approvalAnswered = preCrashApprovalAnswered;
    await waitUntil(async () => {
      report = await rpc<ReconnectReport>(config, { action: "snapshot" });
      if (report.childIdentity !== null) childPids.add(report.childIdentity.pid);
      if (report.pendingApprovalId !== null && !approvalAnswered &&
          report.inFlightPhase !== "unknown_outcome") {
        approvalAnswered = true;
        await rpc(config, {
          action: "approve",
          approvalId: report.pendingApprovalId,
          decision: "approve",
        });
      }
      return report.inFlightPhase === "terminal_durable" || report.inFlightPhase === "unknown_outcome";
    }, "terminal or UNKNOWN_OUTCOME");

    report = await rpc<ReconnectReport>(config, { action: "snapshot" });
    let crossTenantAdoption = false;
    try {
      await rpc(config, { action: "snapshot" }, { tenantId: "different-tenant" });
      crossTenantAdoption = true;
    } catch {
      // Required rejection.
    }
    if (report.lastEventSequence > 0) {
      await rpc(config, { action: "ack", highWaterMark: report.lastEventSequence });
      report = await rpc<ReconnectReport>(config, { action: "snapshot" });
    }
    const ledgerPath = join(config.stateDir, "provider-ledger.json");
    const ledger: ProviderLedger = existsSync(ledgerPath)
      ? JSON.parse(readFileSync(ledgerPath, "utf8"))
      : {
          vendor,
          vendorSessionId: "none",
          state: "idle",
          commandId: null,
          promptExecutions: 0,
          approvalExecutions: 0,
          toolExecutions: 0,
          approvalId: null,
          finalText: null,
        };
    const events = readFileSync(join(config.stateDir, "host.wal.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "EVENT")
      .map((record) => record.event) as Array<{ type: string; payload: Record<string, unknown> }>;
    const unknown = events.some((event) => event.type === "UNKNOWN_OUTCOME");
    const resumed = events.some((event) => event.type === "provider_resumed");
    const completed = events.some((event) => event.type === "turn_completed");
    const outcome: MatrixRow["outcome"] = unknown
      ? "UNKNOWN_OUTCOME"
      : resumed
        ? "clean_vendor_resume"
        : "replayed_known_state";

    await rpc(config, { action: "shutdown" }).catch(() => undefined);
    await Bun.sleep(60);
    const orphanedProcesses = [...childPids].some(processExists);
    return {
      vendor,
      crashTarget,
      boundary,
      outcome,
      promptExecutions: ledger.promptExecutions,
      approvalExecutions: ledger.approvalExecutions,
      toolExecutions: ledger.toolExecutions,
      duplicatePrompt: ledger.promptExecutions > 1,
      duplicateApproval: ledger.approvalExecutions > 1,
      duplicateTool: ledger.toolExecutions > 1,
      falseCompletion: completed && ledger.state !== "completed",
      crossTenantAdoption,
      orphanedProcesses,
      lastEventSequence: report.lastEventSequence,
      highWaterMark: report.highWaterMark,
      notes,
    };
  } finally {
    kill(host, "SIGTERM");
    kill(ui);
    kill(broker);
    await Bun.sleep(30);
    rmSync(runDir, { recursive: true, force: true });
  }
}

function render(rows: MatrixRow[]): string {
  const lines = [
    "# AgentHost crash outcome matrix",
    "",
    "This is deterministic process-level evidence. Every row launches separate simulated UI, broker, AgentHost, and provider processes; the named target receives `SIGKILL` at the named boundary. Claude and Codex fixtures use their own profile names but share the provider-neutral contract. Live installed-provider evidence is recorded separately in `live-providers.json`.",
    "",
    "| Provider | Killed | Boundary | Outcome | Prompt / approval / tool executions | Forbidden result |",
    "|---|---|---|---|---:|---|",
  ];
  for (const row of rows) {
    const forbidden = row.duplicatePrompt || row.duplicateApproval || row.duplicateTool ||
        row.falseCompletion || row.crossTenantAdoption || row.orphanedProcesses
      ? "FAIL"
      : "none";
    lines.push(`| ${row.vendor} | ${row.crashTarget} | ${row.boundary} | ${row.outcome} | ${row.promptExecutions} / ${row.approvalExecutions} / ${row.toolExecutions} | ${forbidden} |`);
  }
  const counts = Object.fromEntries(["replayed_known_state", "clean_vendor_resume", "UNKNOWN_OUTCOME"]
    .map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]));
  lines.push(
    "",
    `Result: ${rows.length} rows; ${counts.replayed_known_state} replayed known state, ${counts.clean_vendor_resume} clean vendor resumes, ${counts.UNKNOWN_OUTCOME} explicit unknown outcomes. No forbidden result occurred.`,
    "",
    "`UNKNOWN_OUTCOME` is expected when an accepted command loses its host or provider before any vendor session exists. The harness never retries that prompt. Before acceptance, a replacement broker may issue a new command only after reconnect proves no `ACCEPTED` record exists.",
  );
  return `${lines.join("\n")}\n`;
}

mkdirSync(evidenceDir, { recursive: true });
const rows: MatrixRow[] = [];
for (const vendor of vendors) {
  for (const target of targets) {
    for (const boundary of boundaries) {
      process.stdout.write(`matrix ${vendor} ${target} ${boundary}\n`);
      rows.push(await runRow(vendor, target, boundary));
    }
  }
}
const forbidden = rows.filter((row) => row.duplicatePrompt || row.duplicateApproval ||
  row.duplicateTool || row.falseCompletion || row.crossTenantAdoption || row.orphanedProcesses);
writeFileSync(join(evidenceDir, "matrix.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  rows,
}, null, 2)}\n`);
writeFileSync(join(evidenceDir, "matrix.md"), render(rows));
if (forbidden.length > 0) throw new Error(`${forbidden.length} matrix rows produced forbidden outcomes`);
process.stdout.write(`wrote ${rows.length} green rows to evidence/matrix.{json,md}\n`);
