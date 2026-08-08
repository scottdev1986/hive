import { describe, expect, test } from "bun:test";
import {
  agentHeaderText,
  type PaneIdentity,
} from "../src/cli/agent-ui/agent-ui-exports";
import { initialView } from "../src/cli/agent-ui/view-state";
import { createAgentUiHarness } from "./agent-ui-harness";

const VENDORS: readonly (PaneIdentity & {
  readonly mark: string;
})[] = [
  {
    agentName: "maya",
    vendorName: "Claude Code",
    vendorId: "claude",
    model: "claude-opus-5",
    effort: "xhigh",
    mark: "✻",
  },
  {
    agentName: "mia",
    vendorName: "Codex",
    vendorId: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    mark: "◎",
  },
  {
    agentName: "isla",
    vendorName: "Grok",
    vendorId: "grok",
    model: "grok-4.5",
    effort: "high",
    mark: "𝕏",
  },
  {
    agentName: "ethan",
    vendorName: "Kimi Code",
    vendorId: "kimi",
    model: "kimi-code/k3",
    effort: "max",
    mark: "K",
  },
  {
    agentName: "noah",
    vendorName: "OpenCode",
    vendorId: "opencode",
    model: "opencode/default",
    mark: "▣",
  },
];

describe("vendor identity in the terminal header", () => {
  test("all supported vendors have distinct compact terminal marks", () => {
    expect(new Set(VENDORS.map((vendor) => vendor.mark)).size).toBe(
      VENDORS.length,
    );
    for (const vendor of VENDORS) {
      const header = agentHeaderText(initialView(), vendor);
      expect(header.split("\n")[0]).toStartWith(`${vendor.mark} `);
      expect(header).toContain(vendor.agentName);
      expect(header).toContain(vendor.model);
    }
  });

  test("an unknown vendor gets a visible fallback tile", () => {
    const header = agentHeaderText(initialView(), {
      agentName: "someone",
      vendorName: "Future Vendor",
      vendorId: "future",
      model: "x",
    });

    expect(header.split("\n")[0]).toStartWith("◆ ");
    expect(header).not.toContain("Future Vendor");
  });

  test("an absent effort is omitted instead of invented", () => {
    const kimi = VENDORS[3];
    const opencode = VENDORS[4];
    if (kimi === undefined || opencode === undefined) {
      throw new Error("vendor fixtures missing");
    }
    const withEffort = agentHeaderText(initialView(), kimi);
    const withoutEffort = agentHeaderText(initialView(), opencode);

    expect(withEffort).toContain("kimi-code/k3 · max");
    expect(withoutEffort).toContain("opencode/default");
    expect(withoutEffort).not.toContain("opencode/default · ");
  });

  test("the pane shows provider identity in the banner and live status in the footer", async () => {
    const codex = VENDORS[1];
    if (codex === undefined) throw new Error("Codex fixture missing");
    const harness = await createAgentUiHarness({ identity: codex });
    try {
      await harness.testRenderer.flush();
      const frame = harness.testRenderer.captureCharFrame();

      expect(frame).toContain("◎");
      expect(frame).not.toContain("CODEX");
      expect(frame).not.toContain("OPENAI");
      expect(frame).toContain("mia");
      expect(frame).toContain("Ask Codex");
      expect(frame).toContain("gpt-5.6-sol");
      expect(frame).toContain("xhigh");
      expect(frame).toContain("context");
      expect(frame).toContain("connecting");
      expect(frame).not.toContain("AGENT");
      expect(frame).not.toContain("MODEL");

      const spans = harness.testRenderer
        .captureSpans()
        .lines.flatMap((line) => line.spans);
      const brand = spans.find((span) => span.text.includes("◎"));
      const vendor = spans.find((span) => span.text.includes("Codex"));
      const model = spans.find((span) => span.text.includes("gpt-5.6-sol"));
      expect(brand).toBeDefined();
      expect(brand?.fg.toString()).not.toBe(vendor?.fg.toString());
      expect(model?.fg.toString()).not.toBe(vendor?.fg.toString());
    } finally {
      await harness.close();
    }
  });
});
