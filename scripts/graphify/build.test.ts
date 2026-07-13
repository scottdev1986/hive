import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const buildScript = await Bun.file(join(import.meta.dir, "build.sh")).text();

describe("the graphify artifact smoke test", () => {
  test("uses an isolated port and always cleans up its process and fixture", () => {
    expect(buildScript).not.toContain("port=8973");
    expect(buildScript).toContain("bind((\"127.0.0.1\", 0))");
    expect(buildScript).toContain("trap cleanup EXIT");
    expect(buildScript).toContain('rm -rf "$tmp"');
  });
});
