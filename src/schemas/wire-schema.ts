import { z } from "zod";

export function opaqueString(validator: z.ZodType<string>) {
  return z.string().refine((value) => validator.safeParse(value).success);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (kind === "object") {
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as object).every(isJsonValue)
    );
  }
  return false;
}

export const JsonValueSchema: z.ZodType<unknown> = z
  .unknown()
  .refine(isJsonValue, "must be a JSON-serializable value");
