import { z } from "zod";

export const HiveConfigSchema = z.object({
  terminal: z.enum(["iterm2", "terminal", "auto"]).default("auto"),
  headless: z.boolean().default(false),
  layout: z.enum(["auto", "off"]).default("auto"),
});

export type HiveConfig = z.infer<typeof HiveConfigSchema>;
