import { describe, expect, test } from "bun:test";
import {
  assertCodexWriterContained,
  CODEX_WRITER_CONTAINMENT_REASON,
  codexWriterContainment,
  CodexWriterContainedError,
} from "./codex-containment";

describe("codexWriterContainment", () => {
  test("admits a Codex writer only on the brokered app-server driver", () => {
    expect(codexWriterContainment("codex", false, "app-server")).toBeNull();
    // The TUI cannot broker a mutation: its hooks fail open and the writer owns
    // the hook scripts.
    expect(codexWriterContainment("codex", false, "tui")).toBe(
      CODEX_WRITER_CONTAINMENT_REASON,
    );
    // An unknown driver is not permission.
    expect(codexWriterContainment("codex", false, null)).toBe(
      CODEX_WRITER_CONTAINMENT_REASON,
    );
  });

  test("never refuses a reader, on any driver", () => {
    // A reader cannot mutate, so there is nothing to contain.
    for (const driver of ["app-server", "tui", null] as const) {
      expect(codexWriterContainment("codex", true, driver)).toBeNull();
    }
  });

  test("never refuses another vendor", () => {
    // The driver is a Codex concept; it must not leak into anyone else's gate.
    for (const driver of ["app-server", "tui", null] as const) {
      expect(codexWriterContainment("claude", false, driver)).toBeNull();
      expect(codexWriterContainment("claude", true, driver)).toBeNull();
      expect(codexWriterContainment("grok", false, driver)).toBeNull();
      expect(codexWriterContainment("grok", true, driver)).toBeNull();
    }
  });

  test("the refusal names no version, so a build can never read as permission", () => {
    // Writer safety is structural. If this text ever starts citing a version
    // floor, someone has turned bootstrap compatibility back into authority.
    expect(CODEX_WRITER_CONTAINMENT_REASON).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test("assertCodexWriterContained throws a distinct typed error", () => {
    expect(() => assertCodexWriterContained("codex", false, "tui")).toThrow(
      CodexWriterContainedError,
    );
    try {
      assertCodexWriterContained("codex", false, null);
    } catch (error) {
      expect(error).toBeInstanceOf(CodexWriterContainedError);
      expect((error as Error).message).toBe(CODEX_WRITER_CONTAINMENT_REASON);
    }
    expect(() => assertCodexWriterContained("codex", false, "app-server"))
      .not.toThrow();
    expect(() => assertCodexWriterContained("codex", true, "tui")).not.toThrow();
    expect(() => assertCodexWriterContained("claude", false, null)).not.toThrow();
  });
});
