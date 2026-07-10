import { z } from "zod";

export const HiveConfigSchema = z.object({
  terminal: z.enum(["iterm2", "terminal", "auto"]).default("auto"),
  headless: z.boolean().default(false),
  layout: z.enum(["auto", "off"]).default("auto"),
  codex: z.object({
    driver: z.enum(["tui", "app-server"]).default("tui"),
  }).default({ driver: "tui" }),
});

export type HiveConfig = z.infer<typeof HiveConfigSchema>;
