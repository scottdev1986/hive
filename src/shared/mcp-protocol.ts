export const HIVE_MCP_PROTOCOL_VERSION = "2026-07-28" as const;

// A daemon's role-scoped tool catalog is immutable for its lifetime. Keep the hint short enough that replacing the daemon cannot leave a client on a stale catalog for long, while avoiding a full list round-trip before every call.
export const HIVE_MCP_CATALOG_CACHE_TTL_MS = 30_000;

export const HIVE_MCP_VERSION_NEGOTIATION = {
  mode: { pin: HIVE_MCP_PROTOCOL_VERSION },
} as const;
