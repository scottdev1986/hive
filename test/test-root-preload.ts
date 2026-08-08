// Refuse `bun test` unless the suite runner has installed a unique bounded
// filesystem and a runtime write sandbox. Loading this through bunfig makes
// the ordinary local command fail closed instead of bypassing containment.

import {
  accessSync,
  constants,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const root = process.env.HIVE_TEST_ROOT;
if (root === undefined || root.length === 0) {
  throw new Error(
    "Hive tests require the bounded test root. Invoke `bun test` through `bun run scripts/test-sandbox.ts -- bun test ...`.",
  );
}
if (!isAbsolute(root) || !statSync(root).isDirectory()) {
  throw new Error(`HIVE_TEST_ROOT is not an absolute directory: ${root}`);
}

const resolvedRoot = realpathSync(root);
const expectedTmp = realpathSync(join(resolvedRoot, "tmp"));
const actualTmp = realpathSync(tmpdir());
if (actualTmp !== expectedTmp) {
  throw new Error(
    `TMPDIR escaped the bounded test root: expected ${expectedTmp}, got ${actualTmp}`,
  );
}

const maxBytes = Number(process.env.HIVE_TEST_ROOT_MAX_BYTES);
if (
  !Number.isSafeInteger(maxBytes) ||
  maxBytes <= 0 ||
  maxBytes > 1024 * 1024 * 1024
) {
  throw new Error("HIVE_TEST_ROOT_MAX_BYTES must be between 1 byte and 1 GiB");
}

const stats = statfsSync(resolvedRoot, { bigint: true });
if (stats.bsize * stats.blocks > BigInt(maxBytes)) {
  throw new Error(`HIVE_TEST_ROOT exceeds its ${maxBytes}-byte ceiling`);
}
accessSync(resolvedRoot, constants.W_OK);
const outside = process.env.HIVE_TEST_OUTSIDE_PATH;
if (outside === undefined || !isAbsolute(outside)) {
  throw new Error("HIVE_TEST_OUTSIDE_PATH must name an absolute path");
}
try {
  accessSync(outside, constants.W_OK);
  throw new Error("the test filesystem sandbox permits out-of-root writes");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
}
