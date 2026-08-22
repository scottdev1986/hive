import { isAbsolute } from "node:path";
import { isRecord, isString } from "../../shared/is-record";
import type { JsonObject, JsonValue } from "../../shared/json";

export const DAEMON_STARTUP_PREFIX = "Hive daemon ready: ";

export interface DaemonStartupAnnouncement {
  readonly engineBuildId: string;
  readonly binaryPath: string;
  readonly sourceHash: string;
}

export function formatDaemonStartupAnnouncement(
  announcement: DaemonStartupAnnouncement,
): string {
  return `${DAEMON_STARTUP_PREFIX}${JSON.stringify(announcement)}`;
}

export function parseDaemonStartupAnnouncement(
  line: string,
): DaemonStartupAnnouncement | null {
  if (!line.startsWith(DAEMON_STARTUP_PREFIX)) return null;
  try {
    const value: JsonValue = JSON.parse(
      line.slice(DAEMON_STARTUP_PREFIX.length),
    );
    if (!isRecord(value)) return null;
    // SAFETY: The surrounding code already established this contract.
    const announcement = value as JsonObject;
    if (
      !isString(announcement.engineBuildId) ||
      !/^[0-9a-f]{64}$/.test(announcement.engineBuildId) ||
      !isString(announcement.binaryPath) ||
      !isAbsolute(announcement.binaryPath) ||
      !isString(announcement.sourceHash) ||
      !/^[0-9a-f]{64}$/.test(announcement.sourceHash)
    )
      return null;
    return {
      engineBuildId: announcement.engineBuildId,
      binaryPath: announcement.binaryPath,
      sourceHash: announcement.sourceHash,
    };
  } catch {
    return null;
  }
}
