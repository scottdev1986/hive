import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isString } from "../../../shared/is-record";
import type {
  CapabilityProvider,
  MeasuredProviderCapabilities,
  ProviderTransport,
} from "../../../schemas/capability";
import {
  capabilityFinding,
  type ProviderRuntimeAdapter,
  type ProviderSession,
  type ProviderSpawn,
  type SessionStart,
  type VendorSessionRef,
} from "./types";
import { errorMessage, isErrnoCode } from "../../../shared/error-message";
import { systemNowIso } from "../../../shared/clock";

/** The adapter a stored ref is bound to. Every field is read from the connected session's own measurements, never from Hive configuration: it has to describe the binary that actually answered. */
export interface AdapterIdentity {
  readonly provider: CapabilityProvider;
  readonly transport: ProviderTransport;
  readonly version: string;
  readonly cwd: string;
}

export interface DurableSessionRecord {
  readonly schemaVersion: 1;
  readonly identity: AdapterIdentity;
  readonly session: VendorSessionRef;
  readonly recordedAt: string;
}

export type StoredSession =
  | { readonly state: "absent" }
  /** Present but not usable. Kept distinct from absent: a record Hive wrote and cannot now read is a fault to report, not a first run. */
  | { readonly state: "unreadable"; readonly detail: string }
  | { readonly state: "present"; readonly record: DurableSessionRecord };

export type ResumeDecision =
  | { readonly outcome: "resume"; readonly vendorSessionId: string }
  | { readonly outcome: "no-stored-session" }
  | { readonly outcome: "refused"; readonly reason: string };

export function adapterIdentity(
  capabilities: MeasuredProviderCapabilities,
): AdapterIdentity {
  return {
    provider: capabilities.provider,
    transport: capabilities.runtime.transport,
    version: capabilities.runtime.version,
    cwd: capabilities.runtime.workingDirectory,
  };
}

/** Whether the stored conversation may be resumed on the adapter that just connected. Every refusal names both sides, because the user's next question is always which one moved. */
export function decideResume(
  stored: StoredSession,
  capabilities: MeasuredProviderCapabilities,
): ResumeDecision {
  if (stored.state === "absent") return { outcome: "no-stored-session" };
  if (stored.state === "unreadable") {
    return {
      outcome: "refused",
      reason: `stored session ref is unreadable: ${stored.detail}`,
    };
  }
  const live = adapterIdentity(capabilities);
  const was = stored.record.identity;
  for (const field of ["provider", "transport", "cwd"] as const) {
    if (was[field] !== live[field]) {
      return {
        outcome: "refused",
        reason: `stored session was created on ${field} ${was[field]}; the connected runtime reports ${live[field]}`,
      };
    }
  }
  // A runtime that has been proven not to recover sessions cannot be asked to. `unknown` is not such a proof: several adapters only measure recovery by performing one, so refusing on unknown would refuse every first resume.
  const recovery = capabilityFinding(capabilities, "sessionRecovery");
  if (recovery.state === "unsupported" || recovery.state === "not-reported") {
    return {
      outcome: "refused",
      reason: `the connected runtime does not support sessionRecovery (${recovery.state})`,
    };
  }
  return {
    outcome: "resume",
    vendorSessionId: stored.record.session.vendorSessionId,
  };
}

export async function readStoredSession(path: string): Promise<StoredSession> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { state: "absent" };
    }
    return {
      state: "unreadable",
      detail: errorMessage(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      state: "unreadable",
      detail: errorMessage(error),
    };
  }
  // SAFETY: The surrounding code already established this contract.
  const record = parsed as Partial<DurableSessionRecord>;
  if (record.schemaVersion !== 1) {
    return {
      state: "unreadable",
      detail: `unsupported schemaVersion ${String(record.schemaVersion)}`,
    };
  }
  if (
    record.identity === undefined ||
    !isString(record.session?.vendorSessionId)
  ) {
    return { state: "unreadable", detail: "missing identity or session ref" };
  }
  // SAFETY: The surrounding code already established this contract.
  return { state: "present", record: record as DurableSessionRecord };
}

/** Written through a rename so a crash mid-write leaves either the previous record or none — never a half one, which the reader would have to refuse. */
export async function writeStoredSession(
  path: string,
  record: DurableSessionRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.writing`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporary, path);
}

export interface OpenedProviderSession {
  readonly session: ProviderSession;
  readonly vendorSession: VendorSessionRef;
  readonly decision: ResumeDecision;
}

export async function openProviderSession(
  adapter: ProviderRuntimeAdapter,
  spawn: ProviderSpawn,
  storePath: string,
  now: () => string = systemNowIso,
  start: Omit<SessionStart, "cwd"> = {},
): Promise<OpenedProviderSession> {
  const stored = await readStoredSession(storePath);
  const session = await adapter.connect(spawn);
  const decision = decideResume(stored, session.capabilities);
  const vendorSession =
    decision.outcome === "resume"
      ? await session.resumeSession({
          vendorSessionId: decision.vendorSessionId,
          style: "load",
        })
      : await session.newSession({ cwd: spawn.cwd, ...start });
  await writeStoredSession(storePath, {
    schemaVersion: 1,
    identity: adapterIdentity(session.capabilities),
    session: vendorSession,
    recordedAt: now(),
  });
  return { session, vendorSession, decision };
}
