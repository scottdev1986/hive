import XCTest
@testable import WorkspaceCore

final class TranscriptModelTests: XCTestCase {

    func testStreamingDeltasGrowOneItemInPlace() {
        var model = TranscriptModel()
        XCTAssertEqual(model.apply(.messageDelta(messageID: "m1", role: .assistant, text: "Hel", model: nil)),
                       .appended(index: 0))
        XCTAssertEqual(model.apply(.messageDelta(messageID: "m1", role: .assistant, text: "lo", model: nil)),
                       .updated(index: 0))
        guard case .message(let item) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(item.text, "Hello")
        XCTAssertTrue(item.isStreaming)
        _ = model.apply(.messageCompleted(messageID: "m1"))
        guard case .message(let done) = model.items[0] else { return XCTFail() }
        XCTAssertFalse(done.isStreaming)
    }

    func testMissingModelStaysAbsentUntilProviderReportsIt() {
        var model = TranscriptModel()
        _ = model.apply(.messageDelta(messageID: "m1", role: .assistant, text: "a", model: nil))
        guard case .message(let before) = model.items[0] else { return XCTFail() }
        XCTAssertNil(before.model, "unknown is never rendered as yes")
        _ = model.apply(.messageDelta(messageID: "m1", role: .assistant, text: "b", model: "claude-sonnet-5"))
        guard case .message(let after) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(after.model, "claude-sonnet-5")
    }

    func testHugeToolOutputAccumulatesAndCollapsesByDefault() {
        var model = TranscriptModel()
        _ = model.apply(.toolCallStarted(callID: "t1", name: "Bash", input: "make"))
        for _ in 0..<5 {
            let chunk = Array(repeating: "line", count: 1_000).joined(separator: "\n") + "\n"
            _ = model.apply(.toolOutput(callID: "t1", chunk: chunk, isANSI: false))
        }
        _ = model.apply(.toolCallCompleted(callID: "t1", exitCode: 0))
        guard case .toolCall(let item) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(item.outputLineCount, 5_001) // 5000 lines + trailing empty
        XCTAssertFalse(item.expanded, "large output starts collapsed")
        XCTAssertEqual(item.exitCode, 0)
        XCTAssertFalse(item.isRunning)

        _ = model.toggleToolOutput(itemID: "t1")
        guard case .toolCall(let expanded) = model.items[0] else { return XCTFail() }
        XCTAssertTrue(expanded.expanded)
    }

    func testApprovalLifecycle() {
        var model = TranscriptModel()
        _ = model.apply(.approvalRequested(approvalID: "a1", title: "Apply migration",
                                           detail: "rewrites config", diff: nil))
        guard case .approval(let pending) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(pending.state, .pending)
        _ = model.apply(.approvalResolved(approvalID: "a1", approved: true))
        guard case .approval(let resolved) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(resolved.state, .approved)
    }

    func testEventsForUnknownIDsAreIgnoredNotFatal() {
        var model = TranscriptModel()
        XCTAssertEqual(model.apply(.toolOutput(callID: "ghost", chunk: "x", isANSI: false)), .none)
        XCTAssertEqual(model.apply(.messageCompleted(messageID: "ghost")), .none)
        XCTAssertEqual(model.apply(.approvalResolved(approvalID: "ghost", approved: false)), .none)
        XCTAssertTrue(model.items.isEmpty)
    }

    func testLifecycleNoticesAppend() {
        var model = TranscriptModel()
        _ = model.apply(.sessionStarted(title: "worker", kind: .worker, model: nil))
        _ = model.apply(.agentFailed(error: "boom"))
        XCTAssertEqual(model.items.count, 2)
        guard case .notice(_, let text) = model.items[0] else { return XCTFail() }
        XCTAssertTrue(text.contains("model unknown"), "missing model renders as absent, not invented")
    }
}
