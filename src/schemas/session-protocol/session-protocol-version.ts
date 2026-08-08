import { z } from "zod";

export const SESSION_PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const SESSION_PROTOCOL_MINOR_RANGE = {
  min: SESSION_PROTOCOL_VERSION.minor,
  max: SESSION_PROTOCOL_VERSION.minor,
} as const;

export const ProtocolMinorSchema = z.number().int().min(0).max(255);
export const SelectedProtocolSchema = z
  .strictObject({
    major: z.literal(SESSION_PROTOCOL_VERSION.major),
    minor: ProtocolMinorSchema,
  })
  .readonly();
