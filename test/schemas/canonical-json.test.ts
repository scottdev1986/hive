import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../src/shared/canonical-json";

describe("canonicalJson", () => {
  test("sorts object keys by code unit at every depth", () => {
    expect(canonicalJson({ ä: 1, z: { b: 2, a: 1 } })).toBe(
      '{"z":{"a":1,"b":2},"ä":1}',
    );
  });

  test("rejects values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson(undefined)).toThrow("non-JSON value");
    expect(() => canonicalJson(Number.NaN)).toThrow("finite numbers");
  });
});
