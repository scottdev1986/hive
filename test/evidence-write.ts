import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Whether this run may rewrite checked-in evidence.
 *
 * Off unless asked. A live conformance test that rewrote its evidence on every
 * ordinary `bun test` made a routine full-suite run republish other agents'
 * files — fresher timestamps, different live-run contents — and `git add -A`
 * then swept them into whoever happened to commit next. Reading and asserting
 * against the installed vendor is unchanged; only the writing is gated, so a
 * bare run still proves everything it proved before.
 */
export const evidenceWritesEnabled = (): boolean =>
  process.env.HIVE_WRITE_EVIDENCE === "1";

/**
 * Writes evidence only when this run was asked to, and says which it did.
 *
 * The return value is the point: a caller that logs it makes the skip visible,
 * so a run that captured nothing cannot be mistaken for a run that captured
 * the same thing again.
 */
export function writeEvidenceFile(
  path: string,
  contents: string,
): "written" | "skipped" {
  if (!evidenceWritesEnabled()) return "skipped";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return "written";
}
