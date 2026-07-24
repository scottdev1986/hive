export function required<T>(
  value: T | null | undefined,
  message = "Expected test value to exist",
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
