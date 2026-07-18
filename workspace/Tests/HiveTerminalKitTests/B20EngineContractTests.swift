import AppKit
import XCTest
@testable import HiveTerminalKit

final class B20EngineContractTests: XCTestCase {
    func testProductionViewSuppressesRepliesAndPresentsOrderedNeutralReplay() throws {
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 640, height: 360),
            viewerId: "b2-live-proof"
        )
        defer { view.userClose() }
        let binding = SurfaceBinding(locator: makeTestLocator(), connectionId: "b2-neutral")
        try view.bind(to: binding)

        var writes: [Data] = []
        view.engine.callbackContext.onWrite = { writes.append($0) }
        let chunks = [
            Data("\u{1B}[2J\u{1B}[HHive B2 neutral replay\r\n\u{1B}[38;5;39mmanual surface\u{1B}[0m".utf8),
            Data("\u{1B}[5n\u{1B}[c\u{1B}[>c\u{1B}[>q\u{1B}P$qm\u{1B}\\\u{1B}P+q544E\u{1B}\\".utf8),
        ]
        var sequence: UInt64 = 0
        for chunk in chunks {
            XCTAssertEqual(
                view.applyOutput(bytes: chunk, streamSeq: sequence, frameBinding: binding),
                .applied(newHighWater: sequence + UInt64(chunk.count))
            )
            sequence += UInt64(chunk.count)
        }

        XCTAssertTrue(waitUntil {
            let evidence = view.renderEvidence
            return evidence.drawCount > 0 && evidence.hasPresentedContents
        })
        pumpMainQueue()
        XCTAssertTrue(writes.isEmpty, "renderer copy must suppress DA/DSR/DECRQSS/XTGETTCAP replies")

        let evidence = view.renderEvidence
        XCTAssertEqual(evidence.locator, binding.locator)
        XCTAssertEqual(evidence.highWater, sequence)
        XCTAssertTrue(evidence.layerClass?.contains("IOSurfaceLayer") == true)
        XCTAssertFalse(evidence.engine.buildId.isEmpty)

        view.insertText("input-positive-control", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(waitUntil { writes == [Data("input-positive-control".utf8)] },
                      "positive control: AppKit-authored bytes must still reach the copied write callback")
    }

    func testSwiftPinProjectionMatchesNativeToolchainLock() throws {
        let root = try findRepoRoot()
        let data = try Data(contentsOf: root.appendingPathComponent("native/toolchain-lock.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let ghostty = try XCTUnwrap(object["ghostty"] as? [String: Any])
        XCTAssertEqual(
            HiveTerminalEngineIdentity.pinnedUpstreamCommit,
            ghostty["commit"] as? String
        )
        XCTAssertFalse(HiveTerminalEngineIdentity.current.buildId.isEmpty)
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func pumpMainQueue() {
        let done = expectation(description: "main queue drained")
        DispatchQueue.main.async { done.fulfill() }
        wait(for: [done], timeout: 1)
    }

    private func findRepoRoot() throws -> URL {
        var url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while url.path != "/" {
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("native/toolchain-lock.json").path) {
                return url
            }
            url.deleteLastPathComponent()
        }
        throw NSError(domain: "B20EngineContractTests", code: 1)
    }
}
