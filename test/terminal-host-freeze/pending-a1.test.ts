import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const candidateSource = () => readFile(resolve(
  import.meta.dir,
  "../../native/sessiond/src/pty_host.zig",
), "utf8");

describe("pending A1 real-sessiond discriminators", () => {
  test.failing("pending A1 / B: launch failure preserves semantic layer and OS code", async () => {
    const source = await candidateSource();
    expect(source).toContain("pub const LaunchFailureEvidence = struct");
    expect(source).toMatch(/layer:\s*LaunchFailureLayer/);
    expect(source).toMatch(/os_code:\s*\?/);
  });

  test.failing("pending A1 / C: transferable descriptor map and arbitrary-inheritable-fd closure", async () => {
    const source = await candidateSource();
    expect(source).toMatch(/descriptor_map:\s*\[\]const/);
    expect(source).toMatch(/close(Unmapped|Inherited).*Descriptors/);
  });

  test("pending A1 / D: resize returns ordered revision and applied geometry readback", async () => {
    const source = await candidateSource();
    expect(source).toContain("pub const ResizeReceipt = struct");
    expect(source).toMatch(/revision:\s*u64/);
    expect(source).toContain("TIOCGWINSZ");
  });
});
