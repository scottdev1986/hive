import { readFileSync } from "node:fs";
import { serve } from "./host";
import type { HostConfig } from "./types";

if (process.argv[2] !== "serve" || process.argv[3] === undefined) {
  throw new Error("usage: bun run src/cli.ts serve <config.json>");
}
const config = JSON.parse(readFileSync(process.argv[3], "utf8")) as HostConfig;
await serve(config);
