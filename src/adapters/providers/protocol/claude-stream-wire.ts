// Decodes shared scalar fields from Claude's untrusted stream-json records.

import { createHash } from "node:crypto";
import { isRecord } from "../../../shared/is-record";
import type { VendorCommand } from "./types";

export type JsonObject = Record<string, unknown>;

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function accountFingerprint(account: unknown): string | undefined {
  if (!isRecord(account)) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(account))
    .digest("hex")
    .slice(0, 16);
}

export function commandFrom(value: unknown): VendorCommand | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    description:
      typeof value.description === "string" ? value.description : null,
    ...(typeof value.argumentHint === "string"
      ? { argumentHint: value.argumentHint }
      : {}),
  };
}
