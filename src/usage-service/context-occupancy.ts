import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findLatestGrokSessionDirectory } from "../adapters/providers/grok-cli";
import { isNumber, isRecord } from "../shared/is-record";
import type { JsonValue } from "../shared/json";

/** Context-occupancy arithmetic and probes: the one owner of how a vendor's token readings become the "context N%" every Hive surface shows. Three vendor postures exist, and each is handled here or provably cannot be: - Claude states its own percent (`get_context_usage`), so there is nothing to derive — the adapter passes the vendor's number through. - Codex and ACP vendors state occupied tokens and a window; the division lives here, not in the adapters. - Grok states occupancy only in its own signals.json (ACP carries billing tokens, which measured 15,214 billed against 4,851 resident for one turn, so occupancy cannot be derived from the wire). The file probe lives here. */

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Occupied tokens against a stated window, as a percent. Null is unknown — a missing window or a windowless reading never becomes a zero. */
export function percentOfWindow(
  occupiedTokens: number | null,
  window: number | null,
): number | null {
  if (occupiedTokens === null || window === null || window <= 0) return null;
  return (occupiedTokens / window) * 100;
}

export function formatContextPercent(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

/** Grok's own occupancy percent from signals.json. ACP never states occupancy (only the window size). Resident tokens divided by that window is a different number from Grok's own reading, so this probe is retained under finding 14 until the vendor exposes occupancy on the wire. Null is unknown, never zero. */
export async function readGrokContextOccupancy(
  worktreePath: string,
  toolSessionId: string | undefined,
  home?: string,
): Promise<number | null> {
  if (toolSessionId === undefined) return null;
  const directory = await findLatestGrokSessionDirectory(
    worktreePath,
    toolSessionId,
    home,
  );
  if (directory === null) return null;
  try {
    const signals: JsonValue = JSON.parse(
      await readFile(join(directory, "signals.json"), "utf8"),
    );
    if (isRecord(signals) && isNumber(signals.contextWindowUsage)) {
      return clampPct(
        // SAFETY: The surrounding code already established this contract.
        (signals as { contextWindowUsage: number }).contextWindowUsage,
      );
    }
  } catch {}
  return null;
}
