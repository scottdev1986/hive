import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  daemonInstanceLiveness,
  type DaemonInstanceLiveness,
} from "./lifecycle";
import { machineHiveHome } from "./instances";
import { hiveInstanceSuffix, resolveHiveHome } from "./tmux-sessions";

const MachineMutationPurposeSchema = z.enum([
  "update",
  "rollback",
  "machine-uninstall",
]);

export type MachineMutationPurpose = z.infer<
  typeof MachineMutationPurposeSchema
>;

export type MachineOperationKind = "spawn" | "landing";

export type ProcessIdentityState =
  | { state: "live"; startedAt: string }
  | { state: "dead" }
  | { state: "unknown" };

export interface MachineMutationLease {
  release(): void;
}

export interface MachineOperation {
  release(): void;
}

const LeaseRowSchema = z.object({
  token: z.string().min(1),
  purpose: MachineMutationPurposeSchema,
  holderPid: z.number().int().positive(),
  holderStartedAt: z.string().min(1),
  acquiredAt: z.string().min(1),
});

type LeaseRow = z.infer<typeof LeaseRowSchema>;

const OperationRowSchema = z.object({
  token: z.string().min(1),
  kind: z.enum(["spawn", "landing"]),
  instanceId: z.string().min(1),
  instanceHome: z.string().min(1),
  holderPid: z.number().int().positive(),
  holderStartedAt: z.string().min(1),
  startedAt: z.string().min(1),
});

type OperationRow = z.infer<typeof OperationRowSchema>;

export function getMachineMutationDatabasePath(): string {
  return join(machineHiveHome(), "mutation.db");
}

async function processIdentity(pid: number): Promise<ProcessIdentityState> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const startedAt = stdout.trim().replace(/\s+/g, " ");
  if (exitCode === 0 && startedAt !== "") {
    return { state: "live", startedAt };
  }
  try {
    process.kill(pid, 0);
    return { state: "unknown" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? { state: "dead" } : { state: "unknown" };
  }
}

export interface MachineMutationCoordinatorOptions {
  path?: string;
  instanceId?: string;
  instanceHome?: string;
  processPid?: number;
  processIdentity?: (pid: number) => Promise<ProcessIdentityState>;
  instanceLiveness?: (
    hiveHome: string,
    instanceId: string,
  ) => Promise<DaemonInstanceLiveness>;
}

export class MachineMutationCoordinator {
  private readonly database: Database;
  private readonly path: string;
  private readonly instanceId: string;
  private readonly instanceHome: string;
  private readonly processPid: number;
  private readonly identifyProcess: (
    pid: number,
  ) => Promise<ProcessIdentityState>;
  private readonly instanceLiveness: (
    hiveHome: string,
    instanceId: string,
  ) => Promise<DaemonInstanceLiveness>;

  constructor(options: MachineMutationCoordinatorOptions = {}) {
    this.path = options.path ?? getMachineMutationDatabasePath();
    this.instanceId = options.instanceId ?? hiveInstanceSuffix();
    this.instanceHome = options.instanceHome ?? resolveHiveHome();
    this.processPid = options.processPid ?? process.pid;
    this.identifyProcess = options.processIdentity ?? processIdentity;
    this.instanceLiveness = options.instanceLiveness ?? daemonInstanceLiveness;
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new Database(this.path, { create: true });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS machine_mutation_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        token TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL,
        holderPid INTEGER NOT NULL CHECK(holderPid > 0),
        holderStartedAt TEXT NOT NULL,
        acquiredAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS machine_operations (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('spawn', 'landing')),
        instanceId TEXT NOT NULL,
        instanceHome TEXT NOT NULL,
        holderPid INTEGER NOT NULL CHECK(holderPid > 0),
        holderStartedAt TEXT NOT NULL,
        startedAt TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  async acquireLease(
    purpose: MachineMutationPurpose,
  ): Promise<MachineMutationLease> {
    const parsedPurpose = MachineMutationPurposeSchema.parse(purpose);
    const owner = await this.identifyProcess(this.processPid);
    if (owner.state !== "live") {
      throw new Error(
        `Cannot start machine ${parsedPurpose}: Hive cannot establish this process's identity, so a crashed lease could not be reclaimed safely.`,
      );
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const operations = this.readOperations();
      const deadTokens: string[] = [];
      for (const operation of operations) {
        const liveness = await this.operationHolderState(operation);
        if (liveness === "dead") {
          deadTokens.push(operation.token);
          continue;
        }
        if (liveness === "unknown") {
          throw new Error(
            `Cannot start machine ${parsedPurpose}: Hive cannot verify the ${operation.kind} operation in instance ${operation.instanceId} at ${operation.instanceHome}; refusing the mutation. Restore or stop that daemon, then retry.`,
          );
        }
        throw new Error(
          `Cannot start machine ${parsedPurpose}: ${operation.kind} in Hive instance ${operation.instanceId} is in progress. Wait for it to finish, then retry.`,
        );
      }
      if (deadTokens.length > 0) {
        this.immediate(() => {
          const remove = this.database.query(
            "DELETE FROM machine_operations WHERE token = ?",
          );
          const find = this.database.query(
            "SELECT 1 FROM machine_operations WHERE token = ?",
          );
          for (const token of deadTokens) {
            remove.run(token);
            if (find.get(token) !== null) {
              throw new Error(
                `Dead machine operation ${token} at ${this.path} was not reclaimed`,
              );
            }
          }
        });
      }

      const token = crypto.randomUUID();
      const acquiredAt = new Date().toISOString();
      const result = this.immediate(():
        | { acquired: true }
        | { acquired: false; lease: LeaseRow | null } => {
        const lease = this.readLease();
        if (lease !== null) return { acquired: false, lease };
        if (this.readOperations().length > 0) {
          return { acquired: false, lease: null };
        }
        this.database.query(`
          INSERT INTO machine_mutation_lease (
            id, token, purpose, holderPid, holderStartedAt, acquiredAt
          ) VALUES (1, ?, ?, ?, ?, ?)
        `).run(
          token,
          parsedPurpose,
          this.processPid,
          owner.startedAt,
          acquiredAt,
        );
        return { acquired: true };
      });
      if (result.acquired) return this.leaseHandle(token);
      if (result.lease === null) continue;

      const holder = await this.leaseHolderState(result.lease);
      if (holder === "dead") {
        this.deleteLease(result.lease.token);
        continue;
      }
      if (holder === "unknown") {
        throw new Error(
          `Cannot start machine ${parsedPurpose}: Hive cannot verify lease holder pid ${result.lease.holderPid} for machine ${result.lease.purpose}; refusing the mutation. Inspect ${this.path} and the holder process, then retry.`,
        );
      }
      throw new Error(
        `Cannot start machine ${parsedPurpose}: machine ${result.lease.purpose} is already in progress (pid ${result.lease.holderPid}). Wait for it to finish, then retry.`,
      );
    }
    throw new Error(
      `Cannot start machine ${parsedPurpose}: spawn or landing state kept changing. Retry after current Hive operations settle.`,
    );
  }

  async beginOperation(kind: MachineOperationKind): Promise<MachineOperation> {
    const owner = await this.identifyProcess(this.processPid);
    if (owner.state !== "live") {
      throw new Error(
        `Hive cannot establish this daemon's process identity; refusing ${kind}.`,
      );
    }
    const token = crypto.randomUUID();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lease = this.immediate(() => {
        const current = this.readLease();
        if (current !== null) return current;
        this.database.query(`
          INSERT INTO machine_operations (
            token, kind, instanceId, instanceHome, holderPid,
            holderStartedAt, startedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          token,
          kind,
          this.instanceId,
          this.instanceHome,
          this.processPid,
          owner.startedAt,
          new Date().toISOString(),
        );
        return null;
      });
      if (lease === null) return this.operationHandle(token);

      const holder = await this.leaseHolderState(lease);
      if (holder === "dead") {
        this.deleteLease(lease.token);
        continue;
      }
      const action = kind === "spawn" ? "agent spawn" : "landing";
      if (holder === "unknown") {
        throw new Error(
          `Hive cannot verify whether machine ${lease.purpose} lease holder pid ${lease.holderPid} is still running; refusing ${action}. Inspect ${this.path}, then retry.`,
        );
      }
      throw new Error(
        `Hive is refusing ${action} while machine ${lease.purpose} is in progress (pid ${lease.holderPid}). Retry after it completes.`,
      );
    }
    throw new Error(
      `Hive could not begin ${kind}: machine mutation state kept changing. Retry after the current mutation settles.`,
    );
  }

  private immediate<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  private readLease(): LeaseRow | null {
    const row = this.database.query(`
      SELECT token, purpose, holderPid, holderStartedAt, acquiredAt
      FROM machine_mutation_lease WHERE id = 1
    `).get();
    if (row === null) return null;
    const parsed = LeaseRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `Machine mutation lease at ${this.path} is unreadable; refusing to proceed.`,
      );
    }
    return parsed.data;
  }

  private readOperations(): OperationRow[] {
    const rows = this.database.query(`
      SELECT token, kind, instanceId, instanceHome, holderPid, holderStartedAt,
             startedAt
      FROM machine_operations ORDER BY startedAt, token
    `).all();
    const parsed = z.array(OperationRowSchema).safeParse(rows);
    if (!parsed.success) {
      throw new Error(
        `Machine operation state at ${this.path} is unreadable; refusing to proceed.`,
      );
    }
    return parsed.data;
  }

  private async leaseHolderState(
    lease: LeaseRow,
  ): Promise<"live" | "dead" | "unknown"> {
    let identity: ProcessIdentityState;
    try {
      identity = await this.identifyProcess(lease.holderPid);
    } catch {
      return "unknown";
    }
    if (identity.state !== "live") return identity.state;
    return identity.startedAt === lease.holderStartedAt ? "live" : "dead";
  }

  private async operationHolderState(
    operation: OperationRow,
  ): Promise<"live" | "dead" | "unknown"> {
    let instance: DaemonInstanceLiveness;
    try {
      instance = await this.instanceLiveness(
        operation.instanceHome,
        operation.instanceId,
      );
    } catch {
      instance = "unknown";
    }
    if (instance === "dead") return "dead";
    if (instance === "unknown") return "unknown";

    let processState: ProcessIdentityState;
    try {
      processState = await this.identifyProcess(operation.holderPid);
    } catch {
      return "unknown";
    }
    if (processState.state !== "live") return processState.state;
    return processState.startedAt === operation.holderStartedAt ? "live" : "dead";
  }

  private deleteLease(token: string): void {
    this.immediate(() => {
      this.database.query(
        "DELETE FROM machine_mutation_lease WHERE token = ?",
      ).run(token);
      const standing = this.database.query(
        "SELECT 1 FROM machine_mutation_lease WHERE token = ?",
      ).get(token);
      if (standing !== null) {
        throw new Error(`Dead machine mutation lease ${token} was not reclaimed`);
      }
    });
  }

  private leaseHandle(token: string): MachineMutationLease {
    return {
      release: () => {
        this.immediate(() => {
          this.database.query(
            "DELETE FROM machine_mutation_lease WHERE token = ?",
          ).run(token);
          const standing = this.database.query(
            "SELECT 1 FROM machine_mutation_lease WHERE token = ?",
          ).get(token);
          if (standing !== null) {
            throw new Error(`Machine mutation lease ${token} was not released`);
          }
        });
      },
    };
  }

  private operationHandle(token: string): MachineOperation {
    return {
      release: () => {
        this.immediate(() => {
          this.database.query(
            "DELETE FROM machine_operations WHERE token = ?",
          ).run(token);
          const standing = this.database.query(
            "SELECT 1 FROM machine_operations WHERE token = ?",
          ).get(token);
          if (standing !== null) {
            throw new Error(`Machine operation ${token} was not released`);
          }
        });
      },
    };
  }
}

export async function acquireMachineMutationLease(
  purpose: MachineMutationPurpose,
): Promise<MachineMutationLease> {
  const coordinator = new MachineMutationCoordinator();
  try {
    const lease = await coordinator.acquireLease(purpose);
    let released = false;
    return {
      release: () => {
        if (released) return;
        lease.release();
        released = true;
        coordinator.close();
      },
    };
  } catch (error) {
    coordinator.close();
    throw error;
  }
}
