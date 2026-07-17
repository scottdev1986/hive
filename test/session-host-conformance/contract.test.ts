import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CHECKPOINT_HEADER,
  FRAME_HEADER,
  FRAME_TYPES,
} from "../../src/schemas/session-protocol";
import { buildWireCorpus } from "./fixtures";
import {
  GENERATED_FILES,
  WIRE_SCHEMA_CATALOG,
  renderGeneratedArtifacts,
} from "./generate";
import { runConformance } from "./runner";

describe("terminal foundation WP0 contracts", () => {
  test("wire and checkpoint layouts are fixed-width and collision-free", () => {
    expect(Object.values(FRAME_HEADER.widths).reduce((sum, width) => sum + width, 0)).toBe(FRAME_HEADER.bytes);
    expect(Object.values(CHECKPOINT_HEADER.widths).reduce((sum, width) => sum + width, 0)).toBe(CHECKPOINT_HEADER.bytes);
    expect(new Set(Object.values(FRAME_TYPES)).size).toBe(Object.keys(FRAME_TYPES).length);
  });

  test("SessionHost interface and supporting types stay verbatim with §19", async () => {
    const design = await readFile(resolve(import.meta.dir, "../../docs/design/terminal-stack-transition.html"), "utf8");
    const extract = (label: string): string => {
      const marker = `<pre aria-label="${label}">`;
      const start = design.indexOf(marker);
      const end = design.indexOf("</pre>", start);
      if (start < 0 || end < 0) throw new Error(`missing normative block ${label}`);
      return design.slice(start + marker.length, end)
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    };
    const expected = `${extract("Normative SessionHost TypeScript contract")}\n\n${extract("Normative SessionHost supporting types")}\n`;
    const actual = await readFile(resolve(import.meta.dir, "../../src/daemon/session-host/contract.ts"), "utf8");
    expect(actual).toBe(expected);
  });

  test("checked-in Swift, Zig, and corpus artifacts are deterministic", async () => {
    const rendered = renderGeneratedArtifacts();
    for (const [path, expected] of Object.entries(rendered)) {
      expect(await readFile(path, "utf8")).toBe(expected);
    }
  });

  test("the shared corpus covers every generated wire schema", () => {
    const corpus = buildWireCorpus();
    const schemaNames = Object.keys(WIRE_SCHEMA_CATALOG).sort();
    expect([...new Set(corpus.valid.map((item) => item.schema))].sort()).toEqual(schemaNames);
    expect([...new Set(corpus.invalid.map((item) => item.schema))].sort()).toEqual(schemaNames);
  });

  test("Swift and TypeScript agree after every valid, invalid, and reducer prefix", async () => {
    const evidence = await runConformance();
    expect(evidence).toEqual({
      validCases: 50,
      invalidCases: 55,
      validHeaders: 2,
      ignoredHeaders: 2,
      invalidHeaders: 7,
      reducerScenarios: 10,
      reducerPrefixes: 25,
      zig: "generated-uncompiled-wp1",
    });
  }, 30_000);

  test("the Zig output stays schema-driven and payload-struct free", async () => {
    const zig = await readFile(GENERATED_FILES.zig, "utf8");
    expect(zig).toContain("Zig 0.15.2 compilation is provisioned by WP1");
    expect(zig).toContain("pub const hello_payload = \"helloPayload\"");
    expect(zig).toContain("pub const @\"error\": u16 = 0x0003");
    expect(zig).toContain("pub const response: u16 = 0x0001");
    expect(zig).toContain("pub const visibility_expiry_ms: u64 = 15000");
    expect(zig).toContain("@embedFile(\"session-protocol.schema.json\")");
    expect(zig).not.toContain("Payload = struct");
  });
});
