import { z } from "zod";

export const HiveConfigSchema = z.object({
  terminal: z.enum(["iterm2", "terminal", "auto"]).default("auto"),
  headless: z.boolean().default(false),
  layout: z.enum(["auto", "off"]).default("auto"),
  codex: z.object({
    driver: z.enum(["tui", "app-server"]).default("tui"),
  }).default({ driver: "tui" }),
  // Claude Code's Channels research preview. "auto" uses it when the installed
  // CLI is new enough and falls back to tmux injection otherwise; "off" pins
  // every Claude session to the fallback.
  channels: z.enum(["auto", "off"]).default("auto"),
});

export type HiveConfig = z.infer<typeof HiveConfigSchema>;
