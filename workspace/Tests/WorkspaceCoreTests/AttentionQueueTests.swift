import XCTest
@testable import WorkspaceCore

final class AttentionQueueTests: XCTestCase {

    func item(_ id: String, severity: AttentionSeverity, at time: TimeInterval,
              pane: PaneID = "p", project: ProjectID = "hive") -> AttentionItem {
        AttentionItem(id: id, projectID: project, paneID: pane, severity: severity,
                      title: id, detail: "", raisedAt: time)
    }

    func testOrderedBySeverityThenAge() {
        var queue = AttentionQueue()
        queue.raise(item("old-completed", severity: .completed, at: 1))
        queue.raise(item("new-failure", severity: .failed, at: 100))
        queue.raise(item("old-waiting", severity: .waiting, at: 5))
        queue.raise(item("new-waiting", severity: .waiting, at: 50))
        queue.raise(item("disconnect", severity: .disconnected, at: 2))

        XCTAssertEqual(queue.ordered.map(\.id),
                       ["new-failure", "old-waiting", "new-waiting", "disconnect", "old-completed"],
                       "severity first; oldest first within a severity; never pane position")
    }

    func testResolveIsExplicitAndTargeted() {
        var queue = AttentionQueue()
        queue.raise(item("a", severity: .failed, at: 1))
        queue.raise(item("b", severity: .waiting, at: 2))
        queue.resolve(id: "a")
        XCTAssertEqual(queue.ordered.map(\.id), ["b"])
    }

    func testResolveAllForPaneLeavesOtherPanesAlone() {
        var queue = AttentionQueue()
        queue.raise(item("a", severity: .failed, at: 1, pane: "x"))
        queue.raise(item("b", severity: .waiting, at: 2, pane: "y"))
        queue.resolveAll(paneID: "x", projectID: "hive")
        XCTAssertEqual(queue.ordered.map(\.id), ["b"])
    }

    func testRaiseSameIDUpdatesInsteadOfDuplicating() {
        var queue = AttentionQueue()
        queue.raise(item("a", severity: .waiting, at: 1))
        queue.raise(item("a", severity: .failed, at: 9))
        XCTAssertEqual(queue.count, 1)
        XCTAssertEqual(queue.ordered.first?.severity, .failed)
    }
}
