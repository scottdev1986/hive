import XCTest
@testable import HiveTerminalKit

final class FactoryErrorTests: XCTestCase {
    func testSurfaceFailureUsesItsDescriptionForLocalizedDescription() {
        XCTAssertEqual(
            GhosttyBridgeFactory.FactoryError.surfaceFailed.localizedDescription,
            "hive_ghostty_surface_new_manual_v1 failed"
        )
    }
}
