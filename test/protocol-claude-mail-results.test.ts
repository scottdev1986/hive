import { describe, expect, test } from "bun:test";
import { claudeMailResultOutput } from "../src/adapters/providers/protocol/claude-tool-calls";

const claim = JSON.stringify({
  itemId: "mit-1",
  sender: "bram",
  lane: "work",
  body: "Runtime echo for story 905.",
});

describe("Claude Code mail results", () => {
  test("a claimed or polled message body is relayed as tool output", () => {
    expect(
      claudeMailResultOutput("mcp__hive__hive_mail_claim", [
        { type: "text", text: claim },
      ]),
    ).toBe(claim);
    expect(claudeMailResultOutput("mcp__hive__hive_mail_poll", claim)).toBe(
      claim,
    );
  });

  test("every other tool's successful result stays out of the pane", () => {
    expect(
      claudeMailResultOutput("Read", [{ type: "text", text: "file body" }]),
    ).toBeNull();
    expect(
      claudeMailResultOutput("mcp__hive__hive_mail_publish", [
        { type: "text", text: '{"itemId":"mit-2"}' },
      ]),
    ).toBeNull();
    expect(
      claudeMailResultOutput("mcp__hive__hive_task_get", [
        { type: "text", text: "{}" },
      ]),
    ).toBeNull();
  });

  test("an empty result relays nothing", () => {
    expect(claudeMailResultOutput("mcp__hive__hive_mail_claim", [])).toBeNull();
    expect(
      claudeMailResultOutput("mcp__hive__hive_mail_claim", "  "),
    ).toBeNull();
  });
});
