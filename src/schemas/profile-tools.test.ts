// Soundness of the profile-tool wire result schemas: the shapes must reject
// exactly the malformed results a buggy implementation could otherwise emit —
// a content file with both/neither content and omission, an opaque refusal
// carrying leaked fields, an unknown status.
import { describe, expect, test } from "bun:test";
import {
  ProfileInventoryContentFileSchema,
  ProfileInventoryResultSchema,
  ProfileReprofileResultSchema,
  ProfileSubmitOutcomeSchema,
} from "./profile-tools";

describe("a content file carries exactly one of content or omitted", () => {
  test("content alone parses", () => {
    expect(ProfileInventoryContentFileSchema.safeParse({ path: "a.ts", content: "x" }).success).toBe(true);
  });
  test("omitted alone parses", () => {
    expect(ProfileInventoryContentFileSchema.safeParse({ path: "a", omitted: "binary" }).success).toBe(true);
  });
  test("both together is rejected", () => {
    expect(ProfileInventoryContentFileSchema.safeParse({ path: "a", content: "x", omitted: "binary" }).success).toBe(false);
  });
  test("neither is rejected", () => {
    expect(ProfileInventoryContentFileSchema.safeParse({ path: "a" }).success).toBe(false);
  });
});

describe("the inventory result is a closed discriminated union", () => {
  test("catalog, content, denied, and unauthorized all parse", () => {
    expect(ProfileInventoryResultSchema.safeParse({ status: "catalog", entries: [], nextCursor: null }).success).toBe(true);
    expect(ProfileInventoryResultSchema.safeParse({ status: "content", files: [] }).success).toBe(true);
    expect(ProfileInventoryResultSchema.safeParse({ status: "denied", code: "stale-run", message: "moved" }).success).toBe(true);
    expect(ProfileInventoryResultSchema.safeParse({ status: "unauthorized" }).success).toBe(true);
  });
  test("the opaque refusal may carry nothing but its status", () => {
    // A code or message on the unauthorized branch is exactly the leak the
    // split exists to prevent, so the strict shape rejects it.
    expect(ProfileInventoryResultSchema.safeParse({ status: "unauthorized", code: "stale-run" }).success).toBe(false);
    expect(ProfileInventoryResultSchema.safeParse({ status: "unauthorized", message: "x" }).success).toBe(false);
  });
  test("a denied result must name a real operational code", () => {
    expect(ProfileInventoryResultSchema.safeParse({ status: "denied", code: "unauthorized", message: "x" }).success).toBe(false);
  });
  test("an unknown status is rejected", () => {
    expect(ProfileInventoryResultSchema.safeParse({ status: "whatever" }).success).toBe(false);
  });
});

describe("the submit outcome is a closed discriminated union", () => {
  test("accepted, unauthorized, and rejected all parse", () => {
    expect(ProfileSubmitOutcomeSchema.safeParse({ status: "accepted" }).success).toBe(true);
    expect(ProfileSubmitOutcomeSchema.safeParse({ status: "unauthorized" }).success).toBe(true);
    expect(ProfileSubmitOutcomeSchema.safeParse({
      status: "rejected",
      lifecycle: "failed",
      rejections: [{ code: "missing-path", message: "gone", at: "docs.primary.path" }],
    }).success).toBe(true);
  });
  test("the opaque refusal cannot smuggle a lifecycle", () => {
    expect(ProfileSubmitOutcomeSchema.safeParse({ status: "unauthorized", lifecycle: "profiling" }).success).toBe(false);
  });
  test("a rejection requires a lifecycle and rejections", () => {
    expect(ProfileSubmitOutcomeSchema.safeParse({ status: "rejected" }).success).toBe(false);
  });
});

describe("the reprofile result is a strict shape", () => {
  test("started and coalesced parse with a run id", () => {
    expect(ProfileReprofileResultSchema.safeParse({ status: "started", runId: "r1" }).success).toBe(true);
    expect(ProfileReprofileResultSchema.safeParse({ status: "coalesced", runId: "r1" }).success).toBe(true);
  });
  test("an unknown status or missing run id is rejected", () => {
    expect(ProfileReprofileResultSchema.safeParse({ status: "queued", runId: "r1" }).success).toBe(false);
    expect(ProfileReprofileResultSchema.safeParse({ status: "started" }).success).toBe(false);
  });
});
