import { describe, expect, test } from "bun:test";
import {
  ToolDiffProjectionCache,
  projectToolChanges,
} from "../src/cli/agent-ui/unified-diff";
import {
  applyProviderEvent,
  initialView,
} from "../src/cli/agent-ui/view-state";

const CHANGE = {
  path: "src/app.ts",
  oldText: "const value = 1;\n",
  newText: "const value = 2;\n",
} as const;

describe("tool diff projection", () => {
  test("computes a diff and its stats from one projection", () => {
    const projection = projectToolChanges([CHANGE]);

    expect(projection.stats).toEqual({ files: 1, added: 1, removed: 1 });
    expect(projection.changes[0]?.diff).toContain("+const value = 2;");
  });

  test("content-identical payloads hit the cache", () => {
    const cache = new ToolDiffProjectionCache();
    const first = cache.project("call-1", [CHANGE]);
    const repeated = cache.project("call-1", [{ ...CHANGE }]);
    const changed = cache.project("call-1", [
      { ...CHANGE, newText: "const value = 3;\n" },
    ]);

    expect(repeated).toBe(first);
    expect(changed).not.toBe(first);
    cache.clear();
  });

  test("a large payload is pending before its worker projection is ready", async () => {
    let ready: (toolCallId: string) => void = () => {};
    const completed = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const cache = new ToolDiffProjectionCache(ready);
    const oldText = Array.from(
      { length: 1_200 },
      (_, index) => `old line ${index}`,
    ).join("\n");
    const newText = Array.from(
      { length: 1_200 },
      (_, index) => `new line ${index}`,
    ).join("\n");
    const changes = [{ path: "large.txt", oldText, newText }];

    expect(cache.project("call-large", changes)).toEqual({
      status: "pending",
    });
    expect(await completed).toBe("call-large");
    const projected = cache.project("call-large", changes);
    expect(projected.status).toBe("ready");
    if (projected.status === "ready") {
      expect(projected.projection.stats).toEqual({
        files: 1,
        added: 1_200,
        removed: 1_200,
      });
    }
    cache.clear();
  });

  test("an identical provider update preserves the tool entry identity", () => {
    const started = applyProviderEvent(initialView(), {
      kind: "tool-started",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "Edit",
      detail: "src/app.ts",
      changes: [CHANGE],
      sequence: 1,
      occurredAt: "1970-01-01T00:00:00.000Z",
      raw: {},
    });
    const repeated = applyProviderEvent(started, {
      kind: "tool-updated",
      turnId: "turn-1",
      toolCallId: "call-1",
      detail: "src/app.ts",
      changes: [{ ...CHANGE }],
      sequence: 2,
      occurredAt: "1970-01-01T00:00:00.001Z",
      raw: {},
    });

    expect(repeated.transcript).toBe(started.transcript);
    expect(repeated.transcript[0]).toBe(started.transcript[0]);
  });
});
