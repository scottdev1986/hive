import { describe, expect, test } from "bun:test";
import {
  machoRpaths,
  nonSystemMachODependencies,
} from "../../src/release/build";

describe("Workspace release dependency closure", () => {
  test("reads each architecture's RPATH once", () => {
    expect(machoRpaths(`
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
`)).toEqual([
      "/usr/lib/swift",
      "/Applications/Xcode.app/usr/lib/swift",
    ]);
  });

  test("rejects dependencies outside macOS itself", () => {
    expect(nonSystemMachODependencies(`
/tmp/release/HiveWorkspace (architecture arm64):
\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/opt/homebrew/lib/libghostty.dylib (compatibility version 1.0.0, current version 1.0.0)
\t@rpath/PrivateTerminal.framework/PrivateTerminal (compatibility version 1.0.0, current version 1.0.0)
`)).toEqual([
      "/opt/homebrew/lib/libghostty.dylib",
      "@rpath/PrivateTerminal.framework/PrivateTerminal",
    ]);
  });
});
