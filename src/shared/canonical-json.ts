import { isNumber, isRecord } from "./is-record";
import type { JsonObject } from "./json";

export function canonicalJson<T>(value: T): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value) || Array.isArray(value)) {
    // SAFETY: The surrounding code already established this contract.
    const entries = Object.entries(value as JsonObject)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  if (isNumber(value) && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON requires finite numbers");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("canonical JSON received a non-JSON value");
  }
  return encoded;
}
