import { describe, expect, test } from "bun:test";
import {
  assertCodexWriterContained,
  CODEX_WRITER_CONTAINMENT_REASON,
  codexWriterContainment,
  CodexWriterContainedError,
} from "./codex-containment";

describe("codexWriterContainment", () => {
  test("refuses only Codex writers", () => {
    expect(codexWriterContainment("codex", false)).toBe(
      CODEX_WRITER_CONTAINMENT_REASON,
    );
    expect(codexWriterContainment("codex", true)).toBeNull();
    expect(codexWriterContainment("claude", false)).toBeNull();
    expect(codexWriterContainment("claude", true)).toBeNull();
    expect(codexWriterContainment("grok", false)).toBeNull();
    expect(codexWriterContainment("grok", true)).toBeNull();
  });

  test("assertCodexWriterContained throws a distinct typed error", () => {
    expect(() => assertCodexWriterContained("codex", false)).toThrow(
      CodexWriterContainedError,
    );
    try {
      assertCodexWriterContained("codex", false);
    } catch (error) {
      expect(error).toBeInstanceOf(CodexWriterContainedError);
      expect((error as Error).message).toBe(CODEX_WRITER_CONTAINMENT_REASON);
    }
    expect(() => assertCodexWriterContained("codex", true)).not.toThrow();
    expect(() => assertCodexWriterContained("claude", false)).not.toThrow();
  });
});
