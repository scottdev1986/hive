import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SESSION_PROTOCOL_PATHS } from "../../src/schemas/session-protocol";

const REPO = join(import.meta.dir, "../..");

describe("SESSION_PROTOCOL_PATHS", () => {
  test("every listed path exists in the repository", () => {
    const missing = Object.entries(SESSION_PROTOCOL_PATHS)
      .filter(([, relative]) => !existsSync(join(REPO, relative)))
      .map(([key, relative]) => `${key}: ${relative}`);
    expect(missing).toEqual([]);
  });
});
