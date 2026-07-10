import { describe, expect, test } from "bun:test";
import { parseScreenFrame, SCREEN_FRAME_SCRIPT } from "./screen";

describe("screen frame reading", () => {
  test("the probe converts AppKit's bottom-left origin to top-left", () => {
    expect(SCREEN_FRAME_SCRIPT).toContain('ObjC.import("AppKit")');
    expect(SCREEN_FRAME_SCRIPT).toContain("visibleFrame");
    expect(SCREEN_FRAME_SCRIPT).toContain(
      "full.size.height - visible.origin.y - visible.size.height",
    );
  });

  test("parses well-formed probe output", () => {
    expect(parseScreenFrame('{"x":0,"y":33,"width":1728,"height":1084}'))
      .toEqual({ x: 0, y: 33, width: 1728, height: 1084 });
  });

  test("rejects malformed or degenerate probe output", () => {
    expect(() => parseScreenFrame("")).toThrow("could not read screen frame");
    expect(() => parseScreenFrame("null")).toThrow(
      "could not read screen frame",
    );
    expect(() => parseScreenFrame('{"x":0,"y":0,"width":0,"height":1080}'))
      .toThrow("could not read screen frame");
    expect(() => parseScreenFrame('{"x":0,"y":0,"width":1920}')).toThrow(
      "could not read screen frame",
    );
  });
});
