import { describe, expect, test } from "bun:test";
import { probeProcessLiveness } from "../../src/adapters/process-liveness";

describe("probeProcessLiveness", () => {
  test("this process is live", () => {
    expect(probeProcessLiveness(process.pid)).toBe("live");
  });

  test("an impossible pid is dead", () => {
    expect(probeProcessLiveness(Number.MAX_SAFE_INTEGER)).toBe("dead");
  });
});
