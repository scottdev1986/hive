export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export function safeJsonParse(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Re-parse an already-decoded value so callers get a JsonValue instead of unknown. */
export function requireJsonValue(value: unknown, label: string): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} was not JSON`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} was not JSON`);
  }
  const parsed = safeJsonParse(serialized);
  if (parsed === undefined) {
    throw new Error(`${label} was not JSON`);
  }
  return parsed;
}
