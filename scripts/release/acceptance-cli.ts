#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatAcceptance,
  type ReadEvidence,
  renderAcceptance,
} from "./cutover-acceptance";

const ROOT = "docs/evidence/protocol-terminal";

const readEvidence: ReadEvidence = (relativePath) => {
  const path = join(ROOT, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const report = renderAcceptance(readEvidence);
console.log(formatAcceptance(report));
writeFileSync(
  join(ROOT, "acceptance.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.exit(report.verdict === "pass" ? 0 : 1);
