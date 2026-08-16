import { describe, expect, test } from "bun:test";
import {
  preservedSandboxPointer,
  runInBoundedTestRoot,
  SandboxTimeoutError,
} from "../../scripts/test-sandbox";

describe("sandbox timeout message shape", () => {
  test("the first line names the deadline and what it waited for", () => {
    const error = new SandboxTimeoutError(
      80,
      "a command that never finished",
      "/tmp/hv-xxxx/m",
    );
    expect(error.message.split("\n")[0]).toBe(
      "timed out after 80ms waiting for a command that never finished",
    );
    expect(error.message).toContain("preserved sandbox: /tmp/hv-xxxx/m");
    expect(error.message).not.toContain("Expected true");
    expect(error.message).not.toContain("Received false");
  });

  test("a deadline without waitingFor is refused before a volume is created", async () => {
    await expect(
      runInBoundedTestRoot(["bun", "-e", "process.exit(0)"], {
        key: "no-label",
        imageSize: "64m",
        maxBytes: 64 * 1024 * 1024,
        deadlineMs: 80,
      }),
    ).rejects.toThrow("a named deadline requires waitingFor");
  });

  test("the preservation pointer is keyed so a second timeout can evict", () => {
    expect(preservedSandboxPointer("suite")).toContain("hv-timeout");
    expect(preservedSandboxPointer("suite")).toContain("suite");
    expect(preservedSandboxPointer("suite")).not.toBe(
      preservedSandboxPointer("self-test"),
    );
  });
});
