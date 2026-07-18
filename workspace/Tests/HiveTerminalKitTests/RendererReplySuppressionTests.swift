import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// B2.1 regression form of Ellen's independently verified B2.0 suppression
/// detector. Each query must first prove that the enabled canonical surface
/// answers, otherwise silence from the disabled renderer copy is vacuous.
final class RendererReplySuppressionTests: XCTestCase {
    private struct Query {
        let name: String
        let bytes: Data
    }

    private static let queries: [Query] = [
        Query(name: "DSR (CSI 5 n)", bytes: Data("\u{1B}[5n".utf8)),
        Query(name: "DA1 (CSI c)", bytes: Data("\u{1B}[c".utf8)),
        Query(name: "DA2 (CSI > c)", bytes: Data("\u{1B}[>c".utf8)),
        Query(name: "DA3 (CSI = c)", bytes: Data("\u{1B}[=c".utf8)),
        Query(name: "XTVERSION (CSI > q)", bytes: Data("\u{1B}[>q".utf8)),
        Query(name: "DECRQSS (DCS $ q m ST)", bytes: Data("\u{1B}P$qm\u{1B}\\".utf8)),
        Query(name: "XTGETTCAP (DCS + q 544E ST)", bytes: Data("\u{1B}P+q544E\u{1B}\\".utf8)),
    ]

    private func pump() {
        let done = expectation(description: "main queue drained")
        DispatchQueue.main.async { done.fulfill() }
        wait(for: [done], timeout: 2)
        let deadline = Date().addingTimeInterval(0.2)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    private func writes(
        for query: Query,
        policy: GhosttyTerminalReplyPolicy
    ) throws -> [Data] {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(terminalReplies: policy)
        defer { surface.free() }
        var observed: [Data] = []
        let lock = NSLock()
        surface.callbackContext.onWrite = { data in
            lock.lock()
            observed.append(data)
            lock.unlock()
        }
        XCTAssertEqual(
            surface.processOutput(bytes: query.bytes, streamSeq: 0),
            .success,
            "\(query.name) must parse cleanly under \(policy)"
        )
        pump()
        lock.lock()
        defer { lock.unlock() }
        return observed
    }

    func testEveryQueryIsIndividuallySuppressedAndNonVacuous() throws {
        var answeredWhenEnabled: [String] = []
        var silentInBothPolicies: [String] = []

        for query in Self.queries {
            let enabled = try writes(for: query, policy: .enabled)
            let disabled = try writes(for: query, policy: .disabled)

            XCTAssertTrue(
                disabled.isEmpty,
                "\(query.name) produced \(disabled.count) renderer write(s): "
                    + "\(disabled.map { String(decoding: $0, as: UTF8.self) })"
            )

            if enabled.isEmpty {
                silentInBothPolicies.append(query.name)
            } else {
                answeredWhenEnabled.append(query.name)
            }
        }

        print("B21_REPLY_SUPPRESSION answered_when_enabled_count=\(answeredWhenEnabled.count)")
        print("B21_REPLY_SUPPRESSION vacuous_count=\(silentInBothPolicies.count)")
        XCTAssertEqual(
            answeredWhenEnabled.count,
            Self.queries.count,
            "every query must answer under .enabled; vacuous: \(silentInBothPolicies)"
        )
        XCTAssertEqual(silentInBothPolicies.count, 0, "suppression proof must have vacuous_count=0")
    }

    func testObservationChannelPositiveControl() throws {
        let query = Query(name: "DA1", bytes: Data("\u{1B}[c".utf8))
        XCTAssertEqual(
            try writes(for: query, policy: .enabled),
            [Data("\u{1B}[?62;22c".utf8)],
            "positive control: enabled DA1 must reach onWrite"
        )
    }
}
