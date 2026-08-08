/** Narrow an unknown value to a plain object record. Arrays and null are rejected so callers can safely index string keys. Owned here so every layer imports one implementation instead of a local copy. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
