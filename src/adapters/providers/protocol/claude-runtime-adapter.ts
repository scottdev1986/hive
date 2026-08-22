import { definedFields } from "../../../shared/defined-fields";
import { errorMessage } from "../../../shared/error-message";
import { probeClaudeVersionDetached } from "../claude-cli";
import { terminateProcessGroup } from "./process-group";
import type {
  ProtocolProbe,
  ProviderRuntimeAdapter,
  ProviderSession,
  ProviderSpawn,
} from "./types";
import {
  type ClaudeProcessFactory,
  defaultProcessFactory,
} from "./claude-stream-process";
import { ClaudeStreamJsonSession } from "./claude-stream-session";

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

interface ClaudeRuntimeAdapterOptions {
  readonly processFactory?: ClaudeProcessFactory;
  readonly probeVersion?: (
    executable: string,
  ) => string | null | Promise<string | null>;
  readonly permissionTimeoutMs?: number;
  readonly terminateProcessGroup?: (
    processGroupId: number,
    graceMs: number,
  ) => Promise<void>;
}

function unavailableClaudeProbe(
  executable: string,
  version: string | null,
  reason: string,
): ProtocolProbe {
  const observedAt = new Date().toISOString();
  return {
    provider: "claude",
    source: "probe",
    observedAt,
    catalog: { status: "unavailable", reason },
    measurements: {},
    commands: [],
    executable,
    version,
    transport: "claude-stream-json",
    verdict: "incompatible",
    reason,
  };
}

export class ClaudeStreamJsonAdapter implements ProviderRuntimeAdapter {
  readonly id = "claude" as const;
  readonly transport = "claude-stream-json" as const;

  private readonly processFactory: ClaudeProcessFactory;
  private readonly versionProbe: (
    executable: string,
  ) => string | null | Promise<string | null>;
  private readonly permissionTimeoutMs: number;
  private readonly terminateChildGroup: (
    processGroupId: number,
    graceMs: number,
  ) => Promise<void>;

  constructor(options: ClaudeRuntimeAdapterOptions = {}) {
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.versionProbe = options.probeVersion ?? probeClaudeVersionDetached;
    this.permissionTimeoutMs =
      options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.terminateChildGroup =
      options.terminateProcessGroup ??
      (options.processFactory === undefined
        ? terminateProcessGroup
        : async () => undefined);
  }

  async probe(executable: string): Promise<ProtocolProbe> {
    const version = await this.versionProbe(executable);
    const session = new ClaudeStreamJsonSession(
      {
        provider: "claude",
        executable,
        argv: [],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      },
      version,
      this.processFactory,
      this.permissionTimeoutMs,
      this.terminateChildGroup,
    );
    try {
      await session.connect();
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
      return unavailableClaudeProbe(executable, version, errorMessage(error));
    } finally {
      await session.close();
    }
  }

  async connect(spawn: ProviderSpawn): Promise<ProviderSession> {
    const version = await this.versionProbe(spawn.executable);
    const session = new ClaudeStreamJsonSession(
      spawn,
      version,
      this.processFactory,
      this.permissionTimeoutMs,
      this.terminateChildGroup,
    );
    try {
      await session.connect();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}
