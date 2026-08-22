import { isJsonValue } from "./is-record";

export type JsonObject = { [key: string]: JsonValue | undefined };

export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;

export function safeJsonParse(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse of well-formed JSON text yields a JSON value. The catch
    // branch already dropped anything that did not parse.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

export function notJson(label: string): never {
  throw new Error(`${label} was not JSON`);
}

/** Parse an untrusted value into JsonValue at an I/O boundary. */
export function requireJsonValue<T>(value: T, label: string): JsonValue {
  if (!isJsonValue(value)) notJson(label);
  return value;
}
