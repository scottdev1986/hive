import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistAutonomy, upsertAutonomy } from "../../src/config/autonomy";

describe("upsertAutonomy", () => {
  test("an empty file becomes exactly the assignment", () => {
    expect(upsertAutonomy("", "sandboxed")).toEqual('autonomy = "sandboxed"\n');
  });

  test("an existing top-level key is replaced in place", () => {
    const text = ['routingManifest = "off"', 'autonomy = "dangerous"', ""].join("\n");
    expect(upsertAutonomy(text, "sandboxed")).toEqual(
      ['routingManifest = "off"', 'autonomy = "sandboxed"', ""].join("\n"),
    );
  });

  test("comments and unknown-to-this-edit keys survive the write", () => {
    const text = [
      "# my hive config",
      'routingManifest = "off"',
      "",
      "[codex]",
      'driver = "app-server"',
      "",
    ].join("\n");
    const result = upsertAutonomy(text, "dangerous");
    expect(result).toContain("# my hive config");
    expect(result).toContain('routingManifest = "off"');
    expect(result).toContain('driver = "app-server"');
    expect(result.startsWith('autonomy = "dangerous"\n')).toEqual(true);
  });

  test("an autonomy key inside a table is not the top-level key", () => {
    const text = ["[codex]", 'autonomy = "whatever"', ""].join("\n");
    const result = upsertAutonomy(text, "sandboxed");
    // Inserted at the top, above the table, so it parses as top-level.
    const parsed = Bun.TOML.parse(result) as Record<string, unknown>;
    expect(parsed.autonomy).toEqual("sandboxed");
    expect(result).toContain('autonomy = "whatever"');
  });

  test("refuses to produce text that does not parse back to the value", () => {
    // An unterminated string makes the whole result unparseable.
    expect(() => upsertAutonomy('broken = "unterminated', "sandboxed"))
      .toThrow("refusing to write config");
  });
});

describe("persistAutonomy", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test("creates the file when absent and round-trips through a re-read", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-autonomy-"));
    roots.push(root);
    const path = join(root, "config.toml");
    await persistAutonomy("dangerous", path);
    const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(parsed.autonomy).toEqual("dangerous");
    // Flip it back: the same file updates rather than doubling the key.
    await persistAutonomy("sandboxed", path);
    const text = await readFile(path, "utf8");
    expect(text.match(/autonomy/g)).toHaveLength(1);
    expect((Bun.TOML.parse(text) as Record<string, unknown>).autonomy)
      .toEqual("sandboxed");
  });

  test("concurrent writes resolve in request order and leave no staging file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-autonomy-concurrent-"));
    roots.push(root);
    const path = join(root, "config.toml");

    await Promise.all([
      persistAutonomy("dangerous", path),
      persistAutonomy("sandboxed", path),
    ]);

    const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.autonomy).toBe("sandboxed");
    expect(await readdir(root)).toEqual(["config.toml"]);
  });
});
