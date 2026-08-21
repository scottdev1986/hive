import { definedFields } from "../../../shared/defined-fields";
import { errorMessage } from "../../../shared/error-message";
import { systemClock } from "../../../shared/clock";
import type {
  ProtocolProbe,
  ProviderRuntimeAdapter,
  ProviderSpawn,
} from "../protocol/types";
import {
  type CodexAppServerWireFactory,
  spawnCodexAppServerWire,
} from "./jsonl-rpc";
import { processEnvironment, readInstalledVersion } from "./process";
import { CodexAppServerSession } from "./session";
import { CodexAppServerIncompatibleError, initializeWire } from "./wire";

interface CodexAppServerDependencies {
  readonly wireFactory?: CodexAppServerWireFactory;
  readonly readVersion?: (executable: string) => Promise<string | null>;
  readonly now?: () => Date;
  readonly approvalTimeoutMs?: number;
}

function unavailableCodexProbe(
  executable: string,
  version: string | null,
  reason: string,
): ProtocolProbe {
  const observedAt = new Date().toISOString();
  return {
    provider: "codex",
    source: "probe",
    observedAt,
    catalog: { status: "unavailable", reason },
    measurements: {},
    commands: [],
    executable,
    version,
    transport: "codex-app-server",
    verdict: "incompatible",
    reason,
  };
}

export class CodexAppServerAdapter implements ProviderRuntimeAdapter {
  readonly id = "codex" as const;
  readonly transport = "codex-app-server" as const;

  private readonly wireFactory: CodexAppServerWireFactory;
  private readonly readVersion: (executable: string) => Promise<string | null>;
  private readonly now: () => Date;
  private readonly approvalTimeoutMs: number;

  constructor(dependencies: CodexAppServerDependencies = {}) {
    this.wireFactory = dependencies.wireFactory ?? spawnCodexAppServerWire;
    this.readVersion = dependencies.readVersion ?? readInstalledVersion;
    this.now = dependencies.now ?? systemClock;
    this.approvalTimeoutMs = dependencies.approvalTimeoutMs ?? 5 * 60_000;
  }

  async probe(executable: string): Promise<ProtocolProbe> {
    const version = await this.readVersion(executable);
    let session: CodexAppServerSession | null = null;
    try {
      session = await this.connect({
        provider: "codex",
        executable,
        argv: [],
        cwd: process.cwd(),
        env: processEnvironment(),
      });
      const snapshot = await session.snapshot();
      return {
        ...snapshot,
        source: "probe",
        executable,
        version,
        transport: this.transport,
        verdict:
          snapshot.catalog.status === "ok" ? "compatible" : "incompatible",
        ...definedFields({
          reason:
            snapshot.catalog.status === "ok"
              ? undefined
              : snapshot.catalog.reason,
        }),
      };
    } catch (error) {
      return unavailableCodexProbe(executable, version, errorMessage(error));
    } finally {
      await session?.close();
    }
  }

  async connect(spawn: ProviderSpawn): Promise<CodexAppServerSession> {
    if (spawn.provider !== "codex") {
      throw new CodexAppServerIncompatibleError(
        `cannot connect provider ${spawn.provider}`,
      );
    }
    const version = await this.readVersion(spawn.executable);
    const wire = await this.wireFactory({
      executable: spawn.executable,
      argv: spawn.argv,
      cwd: spawn.cwd,
      env: spawn.env,
    });
    try {
      const handshake = await initializeWire(wire);
      return new CodexAppServerSession(
        spawn,
        wire,
        handshake,
        version,
        this.wireFactory,
        this.now,
        this.approvalTimeoutMs,
      );
    } catch (error) {
      await wire.close();
      throw error;
    }
  }
}

export const codexAppServerAdapter = new CodexAppServerAdapter();
