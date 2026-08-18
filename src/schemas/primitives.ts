import { z } from "zod";
import { formatlessString } from "./wire-schema";

export const DECIMAL_UINT64_PATTERN = "^(?:0|[1-9][0-9]{0,19})$";
export const DecimalUint64Schema = z
  .string()
  .regex(new RegExp(DECIMAL_UINT64_PATTERN))
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "must fit in an unsigned 64-bit integer",
  )
  .meta({ description: "unsigned 64-bit integer encoded as a decimal string" });

export const SafeUintSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const PositiveGenerationSchema = SafeUintSchema.min(1);
export const Rfc3339UtcMillisecondsSchema = formatlessString(
  z.iso.datetime({ offset: false, precision: 3 }),
);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const Secret256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const TaggedSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const UUID_V7_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function domainUuidV7Schema(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${escapeRegExp(prefix)}_${UUID_V7_BODY}$`));
}
