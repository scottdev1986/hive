import XCTest
@testable import HiveTerminalKit

/// L0 linkage against real GhosttyKit.xcframework.
///
/// Uses: GhosttyKit.xcframework (built via scripts/build-ghosttykit.sh).
/// Skips soft-fail only if the symbol is empty (should not happen when linked).
final class GhosttyBridgeLinkTests: XCTestCase {
    func testEngineBuildIdSymbolResolves() {
        // Calling the silgen-named symbol proves the binary target linked.
        // Value is a hex engine identity string from the hive checkpoint module.
        let buildId = GhosttyManualSurface.engineBuildId()
        XCTAssertFalse(
            buildId.isEmpty,
            "hive_ghostty_engine_build_id_v1 must resolve via GhosttyKit"
        )
        // Hex SHA-256 is 64 chars; allow trailing content if format evolves.
        XCTAssertGreaterThanOrEqual(buildId.count, 32, "engine build id should be a digest-sized string")
    }
}
