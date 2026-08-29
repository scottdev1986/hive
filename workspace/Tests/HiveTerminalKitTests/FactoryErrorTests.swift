import XCTest
@testable import HiveTerminalKit

final class FactoryErrorTests: XCTestCase {
    func testSurfaceFailureUsesItsDescriptionForLocalizedDescription() {
        XCTAssertEqual(
            GhosttyBridgeFactory.FactoryError.surfaceFailed.localizedDescription,
            "ghostty_surface_new failed"
        )
    }
}
