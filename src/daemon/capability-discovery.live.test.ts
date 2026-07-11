import { describe, expect, test } from "bun:test";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
} from "./capability-discovery";
import { CapabilityRecordSchema } from "../schemas/capability";

/**
 * Drives the real, signed-in CLIs. Skipped unless HIVE_LIVE_CAPABILITIES=1,
 * because it needs authenticated `claude` and `codex` binaries on PATH:
 *
 *   HIVE_LIVE_CAPABILITIES=1 bun test src/daemon/capability-discovery.live.test.ts
 *
 * Both probes are session-free: Claude gets one `initialize` control frame and
 * no user message; Codex gets `initialize` + `model/list` + `account/read` and
 * never a thread or a turn. Neither spends a prompt, which is what makes it safe
 * to point this test at a live account — and that property is what it exists to
 * keep true.
 */

const live = process.env.HIVE_LIVE_CAPABILITIES === "1";
const suite = live ? describe : describe.skip;

suite("live capability discovery", () => {
  test("claude initialize returns a usable, provenance-stamped menu", async () => {
    const result = await new ClaudeCapabilityProbe().read();
    if (result.status !== "ok") {
      throw new Error(`claude discovery unavailable: ${result.reason}`);
    }
    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      expect(() => CapabilityRecordSchema.parse(record)).not.toThrow();
      expect(record.provider).toBe("claude");
      // The launch flag must never receive the context-window variant.
      expect(record.launchToken).not.toContain("[");
      // A real CLI build, not the "unknown" placeholder.
      expect(record.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(record.accountFingerprint).not.toContain("@");
    }
  }, 60_000);

  test("codex model/list returns the account-visible catalog", async () => {
    const result = await new CodexCapabilityProbe().read();
    if (result.status !== "ok") {
      throw new Error(`codex discovery unavailable: ${result.reason}`);
    }
    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      expect(() => CapabilityRecordSchema.parse(record)).not.toThrow();
      expect(record.provider).toBe("codex");
      expect(record.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(record.accountFingerprint).not.toContain("@");
    }
    // `includeHidden` is requested, so the vendor's internal entries arrive
    // flagged rather than silently absent. That is what lets Hive decline to
    // route them instead of taking a stale manifest's word about them.
    const hidden = result.records.filter((record) =>
      record.hidden.state === "known" && record.hidden.value === true
    );
    expect(hidden.length).toBeGreaterThan(0);
  }, 60_000);
});
