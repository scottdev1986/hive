import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const prototypeRoot = dirname(here);

const source = join(prototypeRoot, "swift", "hive-fsid.swift");
const binary = join(prototypeRoot, ".build", "hive-fsid");

let cached: string | null | undefined;

/**
 * Compile the Foundation helper on first use. Returns null when swiftc is absent,
 * which makes every bookmark-dependent scenario report `skipped` rather than pass
 * vacuously.
 */
export function ensureFsidHelper(): string | null {
  if (cached !== undefined) return cached;
  if (existsSync(binary)) {
    cached = binary;
    return cached;
  }
  try {
    mkdirSync(dirname(binary), { recursive: true });
    execFileSync("swiftc", ["-O", "-o", binary, source], { stdio: "ignore" });
    cached = binary;
  } catch {
    cached = null;
  }
  return cached;
}
