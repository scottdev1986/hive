import XCTest
@testable import HiveWorkspace
import WorkspaceCore

final class ComposerLeaseStoreTests: XCTestCase {
    func testLeaseStartsBeforeEditingAndEndsAfterSubmissionGrace() {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-composer-\(UUID().uuidString)").path
        let store = ComposerLeaseStore(instanceHome: home, submitGrace: 0.01)
        defer {
            store.clear()
            try? FileManager.default.removeItem(atPath: home)
        }

        store.handle(recipient: "maya", action: .editing)
        XCTAssertTrue(store.isActive("maya"))
        store.handle(recipient: "maya", action: .submitted)
        XCTAssertTrue(store.isActive("maya"))

        let expired = expectation(description: "submission grace expired")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { expired.fulfill() }
        wait(for: [expired], timeout: 1)
        XCTAssertFalse(store.isActive("maya"))
    }

    func testNewDraftCannotBeClearedByPreviousSubmissionTimer() {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-composer-\(UUID().uuidString)").path
        let store = ComposerLeaseStore(instanceHome: home, submitGrace: 0.01)
        defer {
            store.clear()
            try? FileManager.default.removeItem(atPath: home)
        }

        store.handle(recipient: "orchestrator", action: .editing)
        store.handle(recipient: "orchestrator", action: .submitted)
        store.handle(recipient: "orchestrator", action: .editing)

        let oldTimerFired = expectation(description: "old timer fired")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { oldTimerFired.fulfill() }
        wait(for: [oldTimerFired], timeout: 1)
        XCTAssertTrue(store.isActive("orchestrator"))

        store.handle(recipient: "orchestrator", action: .cancelled)
        XCTAssertFalse(store.isActive("orchestrator"))
    }
}
