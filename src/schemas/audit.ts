import { z } from "zod";

export const AuditRowSchema = z.object({
  at: z.string().min(1),
  route: z.string().min(1),
  action: z.string().nullable(),
  callerSubject: z.string().nullable(),
  callerRole: z.string().nullable(),
  capabilityId: z.string().nullable(),
  requestedSubject: z.string().nullable(),
  epoch: z.number().int().nullable(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().nullable(),
});

export type AuditRow = z.infer<typeof AuditRowSchema>;
