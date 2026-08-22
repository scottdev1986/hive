import { describe, expect, test } from "bun:test";
import {
  buildHashFor,
  cliDefines,
  embeddingsDigestForBuild,
  machoRpaths,
  nonSystemMachODependencies,
} from "../../src/release/build";

// HIVE_BUILD_HASH is the content address that lets a new CLI refuse an old daemon, so it has to
// move for everything that changes the bytes and stay put for everything that does not. The variant
// changes the bytes — it is compiled in as a define — so it is an input here. Two binaries that
// differed only by variant used to collide on one hash, which was measured on real artifacts before
// this was fixed: both carried 1709ea7c…, and they were not the same file.
describe("the build hash addresses what actually changed", () => {
  const hash = (variant: "prod" | "dev" | "qa" | null): string =>
    buildHashFor("source", "0.0.7", "abc1234", "bun-darwin-arm64", variant);

  test("two builds differing only by variant no longer collide", () => {
    const hashes = [hash("prod"), hash("dev"), hash("qa")];
    expect(new Set(hashes).size).toBe(3);
  });

  test("a rebuild of one variant still agrees with itself", () => {
    // The property the daemon handshake needs: different releases disagree, one release is stable.
    expect(hash("dev")).toBe(hash("dev"));
  });

  test("null is its own case, not a synonym for prod", () => {
    // sessiond takes no variant define, so its bytes are identical whichever variant is being
    // built. A hash that moved for an artifact that did not change would be as wrong as one that
    // stayed for an artifact that did.
    expect(hash(null)).not.toBe(hash("prod"));
  });

  test("every other input still moves it", () => {
    const base = buildHashFor("s", "v", "c", "t", "prod");
    expect(buildHashFor("S", "v", "c", "t", "prod")).not.toBe(base);
    expect(buildHashFor("s", "V", "c", "t", "prod")).not.toBe(base);
    expect(buildHashFor("s", "v", "C", "t", "prod")).not.toBe(base);
    expect(buildHashFor("s", "v", "c", "T", "prod")).not.toBe(base);
  });
});

describe("what a CLI binary is told about itself at compile time", () => {
  const base = {
    version: "0.0.7",
    commit: "abc1234",
    buildDate: "2026-08-14T00:00:00.000Z",
    publicKey: null,
    variant: "prod",
  } as const;

  test("the variant is always compiled in, prod included", () => {
    // A define emitted only for some variants leaves the rest deciding from the environment, which
    // is exactly what compiling it in exists to prevent.
    for (const variant of ["prod", "dev", "qa"] as const) {
      expect(cliDefines({ ...base, variant }, "src", "build", null)).toContain(
        `process.env.HIVE_BUILD_VARIANT=${JSON.stringify(variant)}`,
      );
    }
  });

  test("every define is passed as its own --define argument", () => {
    const defines = cliDefines(base, "src-hash", "build-hash", null);
    for (let index = 0; index < defines.length; index += 2) {
      expect(defines[index]).toBe("--define");
      expect(defines[index + 1]).toMatch(/^process\.env\.[A-Z_]+=/);
    }
  });

  test("the two security-critical values are absent unless supplied, never empty", () => {
    const names = (defines: string[]): string[] =>
      defines
        .filter((argument) => argument.startsWith("process.env."))
        .map(
          (argument) =>
            // SAFETY: The test owns this value and its fields.
            argument.slice("process.env.".length).split("=")[0] as string,
        );

    // Positive control: the reader below can see these names when they ARE present.
    const supplied = names(
      cliDefines({ ...base, publicKey: "spki" }, "s", "b", "digest"),
    );
    expect(supplied).toContain("HIVE_RELEASE_PUBLIC_KEY");
    expect(supplied).toContain("HIVE_EMBEDDINGS_DIGEST");

    // An unkeyed build must omit them rather than define them empty: `defined()` in
    // src/shared/version.ts treats an empty string as absent, but a present-and-empty define is a
    // claim that the value was decided, and it was not.
    const omitted = names(cliDefines(base, "s", "b", null));
    expect(omitted).not.toContain("HIVE_RELEASE_PUBLIC_KEY");
    expect(omitted).not.toContain("HIVE_EMBEDDINGS_DIGEST");
    expect(omitted).toContain("HIVE_BUILD_VARIANT");
  });

  test("unsigned dev builds do not pin a separately staged runtime", () => {
    expect(embeddingsDigestForBuild(null, "loaded-digest")).toBeNull();
  });

  test("keyed releases pin the runtime they ship", () => {
    expect(
      embeddingsDigestForBuild("release-public-key", "loaded-digest"),
    ).toBe("loaded-digest");
  });
});

describe("Workspace release dependency closure", () => {
  test("reads each architecture's RPATH once", () => {
    expect(
      machoRpaths(`
Load command 10
          cmd LC_RPATH
      cmdsize 32
         path /usr/lib/swift (offset 12)
Load command 11
          cmd LC_RPATH
      cmdsize 48
         path /Applications/Xcode.app/usr/lib/swift (offset 12)
Load command 10
          cmd LC_RPATH
      cmdsize 32
         path /usr/lib/swift (offset 12)
`),
    ).toEqual(["/usr/lib/swift", "/Applications/Xcode.app/usr/lib/swift"]);
  });

  test("rejects dependencies outside macOS itself", () => {
    expect(
      nonSystemMachODependencies(`
/tmp/release/HiveWorkspace (architecture arm64):
\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/opt/homebrew/lib/libghostty.dylib (compatibility version 1.0.0, current version 1.0.0)
\t@rpath/PrivateTerminal.framework/PrivateTerminal (compatibility version 1.0.0, current version 1.0.0)
`),
    ).toEqual([
      "/opt/homebrew/lib/libghostty.dylib",
      "@rpath/PrivateTerminal.framework/PrivateTerminal",
    ]);
  });
});
