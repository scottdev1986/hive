import { describe, expect, test } from "bun:test";
import {
  MAIL_DEFERRAL_SECONDS,
  MAIL_REASON_MAX_LENGTH,
  MailCompleteRequestSchema,
  MailItemSchema,
  MailPublishRequestSchema,
} from "../../src/schemas/mail";

const common = {
  recipient: "ada",
  itemId: "mit_1",
  handlerId: "ada-turn-1",
};

describe("MailCompleteRequestSchema", () => {
  test("retry timing belongs only to deferred settlements", () => {
    expect(
      MailCompleteRequestSchema.parse({
        ...common,
        disposition: "completed",
      }),
    ).toEqual({ ...common, disposition: "completed", reason: null });
    expect(
      MailCompleteRequestSchema.safeParse({
        ...common,
        disposition: "completed",
        retryAfterSeconds: 30,
      }).success,
    ).toBe(false);
    const deferred = MailCompleteRequestSchema.parse({
      ...common,
      disposition: "deferred",
    });
    expect(deferred).toMatchObject({
      retryAfterSeconds: MAIL_DEFERRAL_SECONDS,
    });
  });
});

describe("MailPublishRequestSchema", () => {
  const base = {
    from: "hive-quota",
    to: "queen",
    lane: "work" as const,
    body: "kimi 401",
    idempotencyKey: "q1",
  };

  test("conditionId and condition must arrive together", () => {
    expect(MailPublishRequestSchema.parse(base).conditionId).toBe(null);
    expect(
      MailPublishRequestSchema.parse({
        ...base,
        conditionId: "quota:kimi:live-probe",
        condition: "HTTP 401",
      }).conditionId,
    ).toBe("quota:kimi:live-probe");
    expect(
      MailPublishRequestSchema.safeParse({
        ...base,
        conditionId: "quota:kimi:live-probe",
      }).success,
    ).toBe(false);
  });
});

describe("MailCompleteRequestSchema", () => {
  test("bounds a reason without blocking settlement", () => {
    const parsed = MailCompleteRequestSchema.parse({
      ...common,
      disposition: "rejected",
      reason: "x".repeat(MAIL_REASON_MAX_LENGTH + 1),
    });
    expect(parsed.reason).toBe("x".repeat(MAIL_REASON_MAX_LENGTH));
  });
});

describe("mail persistence timestamps", () => {
  const item = {
    itemId: "mit_1",
    recipient: "ada",
    sender: "queen",
    lane: "control",
    topic: "general",
    body: "Check the result",
    seq: 1,
    state: "available",
    mergedCount: 1,
    attempts: 0,
    recipientGeneration: null,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
    expiresAt: null,
    notBefore: null,
  };

  test("rejects timestamp-shaped garbage", () => {
    expect(MailItemSchema.safeParse(item).success).toBe(true);
    expect(
      MailItemSchema.safeParse({
        ...item,
        createdAt: "not-a-timestamp-value",
      }).success,
    ).toBe(false);
  });
});
