import { z } from "zod";
import type { Frame } from "./layout";
import { runOsascript } from "./osascript";

// NSScreen's visibleFrame excludes the menu bar and Dock. AppKit uses
// bottom-left-origin coordinates; AppleScript window bounds use top-left
// origin, so the y origin is flipped against the full frame before returning.
export const SCREEN_FRAME_SCRIPT = [
  'ObjC.import("AppKit");',
  "const screen = $.NSScreen.mainScreen;",
  "const full = screen.frame;",
  "const visible = screen.visibleFrame;",
  "JSON.stringify({",
  "  x: Math.round(visible.origin.x),",
  "  y: Math.round(full.size.height - visible.origin.y - visible.size.height),",
  "  width: Math.round(visible.size.width),",
  "  height: Math.round(visible.size.height),",
  "});",
].join("\n");

const ScreenFrameSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export function parseScreenFrame(output: string): Frame {
  try {
    return ScreenFrameSchema.parse(JSON.parse(output));
  } catch {
    throw new Error(`could not read screen frame: invalid output "${output}"`);
  }
}

export type ScreenFrameReader = () => Promise<Frame>;

export const readScreenFrame: ScreenFrameReader = async () =>
  parseScreenFrame(
    await runOsascript(SCREEN_FRAME_SCRIPT, "read screen frame", "JavaScript"),
  );
