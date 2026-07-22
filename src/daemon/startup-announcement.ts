import { isAbsolute } from "node:path";

export const DAEMON_STARTUP_PREFIX = "Hive daemon ready: ";

export interface DaemonStartupAnnouncement {
  readonly engineBuildId: string;
  readonly binaryPath: string;
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
    const value: unknown = JSON.parse(line.slice(DAEMON_STARTUP_PREFIX.length));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const announcement = value as Record<string, unknown>;
    if (
      typeof announcement.engineBuildId !== "string" ||
      !/^[0-9a-f]{64}$/.test(announcement.engineBuildId) ||
      typeof announcement.binaryPath !== "string" ||
      !isAbsolute(announcement.binaryPath)
    ) return null;
    return {
      engineBuildId: announcement.engineBuildId,
      binaryPath: announcement.binaryPath,
    };
  } catch {
    return null;
  }
}
