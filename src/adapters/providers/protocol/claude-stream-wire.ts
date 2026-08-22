import { createHash } from "node:crypto";
import { definedFields } from "../../../shared/defined-fields";
import { isFiniteNumber, isRecord, isString } from "../../../shared/is-record";
import type { JsonObject } from "../../../shared/json";
import type { VendorCommand } from "./types";

export type { JsonObject };

export function asString<T>(value: T | undefined): string | null {
  return isString(value) ? value : null;
}

export function asNumber<T>(value: T | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

export function accountFingerprint<T>(account: T): string | undefined {
  if (!isRecord(account)) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(account))
    .digest("hex")
    .slice(0, 16);
}

export function commandFrom<T>(value: T): VendorCommand | null {
  if (!isRecord(value) || !isString(value.name)) return null;
  return {
    name: value.name,
    description: asString(value.description),
    ...definedFields({
      argumentHint: asString(value.argumentHint) ?? undefined,
    }),
  };
}
