/** Copies only defined properties so callers can build optional fields without a conditional empty-object spread. */
export function definedFields<T extends object>(
  fields: T,
): {
  [K in keyof T]?: T[K];
} {
  const result: { [K in keyof T]?: T[K] } = {};
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] !== undefined) {
      result[key] = fields[key];
    }
  }
  return result;
}
