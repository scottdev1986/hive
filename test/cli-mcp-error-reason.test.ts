import { describe, expect, test } from "bun:test";
import { toolErrorReason } from "../src/cli/mcp";

describe("MCP CLI error decoding", () => {
  test("preserves plain-text server failures", () => {
    expect(
      toolErrorReason(
        [{ type: "text", text: "succession awaits attestation" }],
        "hive_quota_status",
      ),
    ).toBe("succession awaits attestation");
  });

  test("extracts structured reason envelopes", () => {
    expect(
      toolErrorReason(
        [{ type: "text", text: '{"reason":"lease expired"}' }],
        "hive_mail_complete",
      ),
    ).toBe("lease expired");
  });
});
