import { z } from "zod";

export const ApprovalKindSchema = z.enum(["tool-permission", "land-rearm"]);

export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalSchema = z.strictObject({
  id: z.string().min(1),
  agentName: z.string().min(1),
  kind: ApprovalKindSchema.default("tool-permission"),
  description: z.string(),
  status: z.enum(["pending", "approved", "denied", "stale"]),
  createdAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type Approval = z.infer<typeof ApprovalSchema>;
