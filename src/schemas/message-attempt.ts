import { z } from "zod";
import { TerminalHostInputReceiptSchema } from "./session-protocol";

export const MessageAttemptOutcomeSchema = z.enum([
  "pending",
  "written",
  "foreground-changed",
  "input-busy",
  "timeout",
  "unknown",
]);

export const MessageAttemptSchema = z
  .strictObject({
    attemptId: z.string().uuid(),
    messageId: z.string().min(1),
    expectedProviderRunId: z.string().uuid(),
    terminalGeneration: z.number().int().positive(),
    expectedForeground: z
      .strictObject({
        pid: z.number().int().positive(),
        startToken: z.string().min(1),
        processGroupId: z.number().int().positive(),
      })
      .readonly(),
    attemptedAt: z.iso.datetime({ offset: true }),
    outcome: MessageAttemptOutcomeSchema,
    terminalReceipt: TerminalHostInputReceiptSchema.nullable(),
  })
  .readonly();

export type MessageAttempt = z.infer<typeof MessageAttemptSchema>;
export type MessageAttemptOutcome = z.infer<typeof MessageAttemptOutcomeSchema>;
