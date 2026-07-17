import Foundation
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// MF1: HiveGhosttyC must pin the authoritative native header — not a drifting fork.
/// Same pattern as WorkspaceCoreTests sharing the daemon wire Fixtures.
final class HeaderParityTests: XCTestCase {
    func testHiveGhosttyBridgeHeaderMatchesNativeAuthority() throws {
        let repoRoot = try findRepoRoot()
        let native = repoRoot
            .appendingPathComponent("native/include/hive_ghostty_bridge.h")
        let shipped = repoRoot
            .appendingPathComponent("workspace/Sources/HiveGhosttyC/include/hive_ghostty_bridge.h")

        XCTAssertTrue(FileManager.default.fileExists(atPath: native.path),
                      "native authority missing at \(native.path)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: shipped.path),
                      "HiveGhosttyC header missing at \(shipped.path)")

        // Resolve symlinks so we compare the real files.
        let nativeReal = shippedResolving(native)
        let shippedReal = shippedResolving(shipped)
        XCTAssertEqual(
            nativeReal.path,
            shippedReal.path,
            "HiveGhosttyC header must be the same inode/path as native/include (symlink), not a fork. native=\(nativeReal.path) shipped=\(shippedReal.path)"
        )

        let nativeBytes = try Data(contentsOf: native)
        let shippedBytes = try Data(contentsOf: shipped)
        XCTAssertEqual(
            nativeBytes,
            shippedBytes,
            "hive_ghostty_bridge.h content drift between native/ and HiveGhosttyC"
        )
        XCTAssertTrue(
            String(data: nativeBytes, encoding: .utf8)?.contains("hive_ghostty_event_fn") == true
        )
    }

    func testGhosttyResultValuesMatchLibghosttyVtABI() throws {
        // Thin types.h values must match result.zig / libghostty-vt types.h.
        XCTAssertEqual(GHOSTTY_SUCCESS.rawValue, 0)
        XCTAssertEqual(GHOSTTY_OUT_OF_MEMORY.rawValue, -1)
        XCTAssertEqual(GHOSTTY_INVALID_VALUE.rawValue, -2)
        XCTAssertEqual(GHOSTTY_OUT_OF_SPACE.rawValue, -3)
        XCTAssertEqual(GHOSTTY_NO_VALUE.rawValue, -4)

        XCTAssertEqual(GhosttyBridgeResult.success.rawValue, Int32(GHOSTTY_SUCCESS.rawValue))
        XCTAssertEqual(GhosttyBridgeResult.outOfMemory.rawValue, Int32(GHOSTTY_OUT_OF_MEMORY.rawValue))
        XCTAssertEqual(GhosttyBridgeResult.invalidValue.rawValue, Int32(GHOSTTY_INVALID_VALUE.rawValue))
        XCTAssertEqual(GhosttyBridgeResult.outOfSpace.rawValue, Int32(GHOSTTY_OUT_OF_SPACE.rawValue))
        XCTAssertEqual(GhosttyBridgeResult.noValue.rawValue, Int32(GHOSTTY_NO_VALUE.rawValue))

        // When the offline artifact is present, pin against the real types.h text.
        let repoRoot = try findRepoRoot()
        let artifactRoot = repoRoot.appendingPathComponent(".cache/native/artifacts")
        if let enumerator = FileManager.default.enumerator(
            at: artifactRoot,
            includingPropertiesForKeys: nil
        ) {
            for case let url as URL in enumerator {
                if url.lastPathComponent == "types.h",
                   url.path.contains("ghostty/vt/types.h") {
                    let text = try String(contentsOf: url, encoding: .utf8)
                    XCTAssertTrue(text.contains("GHOSTTY_SUCCESS = 0"))
                    XCTAssertTrue(text.contains("GHOSTTY_OUT_OF_MEMORY = -1"))
                    XCTAssertTrue(text.contains("GHOSTTY_INVALID_VALUE = -2"))
                    XCTAssertTrue(text.contains("GHOSTTY_OUT_OF_SPACE = -3"))
                    XCTAssertTrue(text.contains("GHOSTTY_NO_VALUE = -4"))
                    return
                }
            }
        }
        // Artifact optional for pure-Swift CI; values above still pin the ABI.
    }

    private func findRepoRoot() throws -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<8 {
            let native = url.appendingPathComponent("native/include/hive_ghostty_bridge.h")
            if FileManager.default.fileExists(atPath: native.path) {
                return url
            }
            url.deleteLastPathComponent()
        }
        throw XCTSkip("could not locate repo root from \(#filePath)")
    }

    private func shippedResolving(_ url: URL) -> URL {
        url.resolvingSymlinksInPath()
    }
}
