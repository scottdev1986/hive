import { z } from "zod";

export const AssignmentStateSchema = z.enum([
  "active",
  "in_progress",
  "blocked",
  "reported_complete",
  "accepted",
]);

export type AssignmentState = z.infer<typeof AssignmentStateSchema>;

export const AssignmentReportStateSchema = z.enum([
  "in_progress",
  "complete",
  "blocked",
]);

export type AssignmentReportState = z.infer<
  typeof AssignmentReportStateSchema
>;

const AssignmentSummaryItemSchema = z.string().min(1).max(300);

/** Bounded progress evidence. The state beside it is authoritative; no caller
 * parses these strings to decide whether an assignment is finished. */
export const AssignmentSummarySchema = z.strictObject({
  done: z.array(AssignmentSummaryItemSchema).max(8).default([]),
  remaining: z.array(AssignmentSummaryItemSchema).max(8).default([]),
  blockers: z.array(AssignmentSummaryItemSchema).max(8).default([]),
});

export type AssignmentSummary = z.infer<typeof AssignmentSummarySchema>;

export const AssignmentRecordSchema = z.strictObject({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  taskDescription: z.string(),
  processIncarnation: z.number().int().nonnegative(),
  state: AssignmentStateSchema,
  summary: AssignmentSummarySchema.nullable(),
  generation: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reportedAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  acceptedBy: z.string().min(1).nullable(),
});

export type AssignmentRecord = z.infer<typeof AssignmentRecordSchema>;

export const AssignmentStatusViewSchema = AssignmentRecordSchema.pick({
  id: true,
  processIncarnation: true,
  state: true,
  summary: true,
  generation: true,
  updatedAt: true,
});

export type AssignmentStatusView = z.infer<
  typeof AssignmentStatusViewSchema
>;
