import { z } from "zod";

/**
 * Applies string validation without emitting JSON Schema `format` metadata.
 * Moonshot's MFJS validator rejects those annotations in MCP tool schemas.
 */
export function formatlessString(validator: z.ZodType<string>) {
  return z.string().refine((value) => validator.safeParse(value).success);
}
