import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 6 release lock: every adversarial byte split is authored by the
/// shipped headless lib-vt and restored by the shipped embedded surface.
final class Gate6SurfaceRestoreTests: XCTestCase {
    private struct FixtureCorpus {
        let cases: [Data]
        let subsequent: Data
    }

    private let expectedCorpus = [
        Data("\u{1B}[31mred\u{1B}[0m".utf8),
        Data("\u{1B}]2;checkpoint title\u{07}".utf8),
        Data("\u{1B}P$qm\u{1B}\\".utf8),
        Data("A😄Z".utf8),
        Data("e\u{0301}x".utf8),
        Data("\u{1B}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u{1B}\\".utf8),
        Data("\u{1B}[?2026hsynchronized\u{1B}[?2026l".utf8),
        Data("primary\u{1B}[?1049halternate\u{1B}[?1049lprimary-again".utf8),
        Data("12345678901234567890".utf8),
    ]
    private let expectedSubsequent = Data(
        "\u{07}\u{1B}]2;after\u{07}\u{1B}]7;file://host/tmp\u{07}\u{1B}[6n!".utf8
    )

    private var runtimeArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }

    private func candidateArtifacts() -> [URL] {
        if let exact = ProcessInfo.processInfo.environment["HIVE_GHOSTTY_ARTIFACT"],
           !exact.isEmpty {
            return [URL(fileURLWithPath: exact)]
        }
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveTerminalKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // workspace
            .deletingLastPathComponent() // repo root
        let artifacts = root.appendingPathComponent(".cache/native/artifacts")
        return ((try? FileManager.default.contentsOfDirectory(
            at: artifacts, includingPropertiesForKeys: nil
        )) ?? []).sorted { $0.path < $1.path }
    }

    private func checkpointEngineId(_ payload: Data) -> String? {
        guard payload.count >= 42,
              payload.prefix(8) == Data("HVGCP001".utf8) else { return nil }
        return payload[10..<42].map { String(format: "%02x", $0) }.joined()
    }

    private func fixtureDirectory() throws -> URL {
        let embeddedId = GhosttyManualSurface.engineBuildId()
        for artifact in candidateArtifacts() {
            let directory = artifact
                .appendingPathComponent("checkpoint-fixtures")
                .appendingPathComponent(runtimeArchitecture)
            let first = directory.appendingPathComponent("case-00-split-000.hvgcp")
            guard FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("corpus.hvg6").path
            ), let payload = try? Data(contentsOf: first),
               checkpointEngineId(payload) == embeddedId else { continue }
            return directory
        }
        XCTFail("matching \(runtimeArchitecture) cross-library fixtures missing — " +
                "rerun scripts/build-ghosttykit.sh; gate 6 never skips")
        throw NSError(domain: "Gate6SurfaceRestoreTests", code: 1)
    }

    private func readCorpus(_ directory: URL) throws -> FixtureCorpus {
        let data = try Data(contentsOf: directory.appendingPathComponent("corpus.hvg6"))
        var cursor = 0

        func read(_ count: Int) throws -> Data {
            guard count >= 0, cursor <= data.count - count else {
                throw NSError(domain: "Gate6SurfaceRestoreTests", code: 2)
            }
            defer { cursor += count }
            return data.subdata(in: cursor..<(cursor + count))
        }
        func readUInt32() throws -> Int {
            let bytes = try read(4)
            return Int(UInt32(bytes[0]) |
                       UInt32(bytes[1]) << 8 |
                       UInt32(bytes[2]) << 16 |
                       UInt32(bytes[3]) << 24)
        }

        guard try read(8) == Data("HVG6C001".utf8) else {
            throw NSError(domain: "Gate6SurfaceRestoreTests", code: 3)
        }
        let count = try readUInt32()
        let subsequent = try read(try readUInt32())
        var cases: [Data] = []
        cases.reserveCapacity(count)
        for _ in 0..<count {
            cases.append(try read(try readUInt32()))
        }
        guard cursor == data.count else {
            throw NSError(domain: "Gate6SurfaceRestoreTests", code: 4)
        }
        return FixtureCorpus(cases: cases, subsequent: subsequent)
    }

    private func fixture(
        _ directory: URL,
        caseIndex: Int,
        split: Int
    ) throws -> Data {
        let name = String(
            format: "case-%02d-split-%03d.hvgcp",
            caseIndex,
            split
        )
        return try Data(contentsOf: directory.appendingPathComponent(name))
    }

    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 6, got: \(error)")
            throw error
        }
    }

    private func readScreenText(_ surface: GhosttyManualSurface) -> String {
        guard let handle = surface.surfaceHandle else { return "" }
        var text = ghostty_text_s()
        let selection = ghostty_selection_s(
            top_left: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                x: 0,
                y: 0
            ),
            bottom_right: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                x: 0,
                y: 0
            ),
            rectangle: false
        )
        guard ghostty_surface_read_text(handle, selection, &text) else { return "" }
        defer { ghostty_surface_free_text(handle, &text) }
        return String(cString: text.text)
    }

    /// Drive the main queue so Gate 3's async callback delivery actually
    /// runs before we read the captured writes/events. Without this the
    /// callback arrays are trivially empty (delivery is deferred), which is
    /// exactly the false-green this test guards against.
    private func pumpMainQueue() {
        let delivered = expectation(description: "main-thread callback delivery")
        DispatchQueue.main.async { delivered.fulfill() }
        wait(for: [delivered], timeout: 5)
    }

    private func verify(
        directory: URL,
        bytes: Data,
        subsequent: Data,
        caseIndex: Int,
        split: Int
    ) throws {
        var prefixScreen = ""
        var finalScreen = ""
        var referenceWrites: [Data] = []
        var referenceEvents: [BridgeEvent] = []
        var remainder = bytes.subdata(in: split..<bytes.count)
        remainder.append(subsequent)
        let finalSequence = UInt64(bytes.count + subsequent.count)

        do {
            let reference = try makeSurface()
            defer { reference.free() }
            reference.callbackContext.onWrite = { referenceWrites.append($0) }
            reference.callbackContext.onEvent = { referenceEvents.append($0) }

            if split > 0 {
                XCTAssertEqual(
                    reference.processOutput(
                        bytes: bytes.subdata(in: 0..<split),
                        streamSeq: 0
                    ),
                    .success,
                    "case \(caseIndex) split \(split): reference prefix"
                )
            }
            XCTAssertEqual(reference.throughSeq, UInt64(split))
            // Drain the prefix's async delivery before clearing, so deferred
            // prefix callbacks do not leak into the suffix comparison.
            pumpMainQueue()
            prefixScreen = readScreenText(reference)
            referenceWrites.removeAll()
            referenceEvents.removeAll()
            XCTAssertEqual(
                reference.processOutput(bytes: remainder, streamSeq: UInt64(split)),
                .success,
                "case \(caseIndex) split \(split): uninterrupted suffix"
            )
            XCTAssertEqual(reference.throughSeq, finalSequence)
            pumpMainQueue()
            finalScreen = readScreenText(reference)
        }
        // The suffix ends in ESC[6n (DSR) under the enabled reply policy, so a
        // real reply byte must have reached the write callback — this makes
        // the restored-vs-reference write comparison below non-vacuous rather
        // than empty == empty.
        XCTAssertFalse(
            referenceWrites.isEmpty,
            "case \(caseIndex) split \(split): reference suffix must produce real reply bytes"
        )

        let payload = try fixture(directory, caseIndex: caseIndex, split: split)
        XCTAssertEqual(
            checkpointEngineId(payload),
            GhosttyManualSurface.engineBuildId(),
            "case \(caseIndex) split \(split): lib-vt/embedded identity"
        )
        let restored = try makeSurface()
        defer { restored.free() }
        var restoredWrites: [Data] = []
        var restoredEvents: [BridgeEvent] = []
        restored.callbackContext.onWrite = { restoredWrites.append($0) }
        restored.callbackContext.onEvent = { restoredEvents.append($0) }
        let restoreResult = restored.restoreCheckpoint(
            payload: payload,
            throughSeq: UInt64(split)
        )
        guard restoreResult == .success else {
            XCTFail("case \(caseIndex) split \(split): restore returned \(restoreResult)")
            return
        }
        // Drive restore's deferred title/pwd/invalidate delivery before
        // asserting — otherwise restoredWrites/restoredEvents are trivially
        // empty (the false-green) and a spurious restore-time write would go
        // undetected.
        pumpMainQueue()

        XCTAssertEqual(restored.throughSeq, UInt64(split))
        XCTAssertTrue(
            restoredWrites.isEmpty,
            "case \(caseIndex) split \(split): restore emitted host bytes"
        )
        XCTAssertEqual(
            restoredEvents.map(\.type.rawValue).sorted(),
            [1, 2, 3],
            "case \(caseIndex) split \(split): restore state-sync events"
        )
        XCTAssertEqual(
            readScreenText(restored),
            prefixScreen,
            "case \(caseIndex) split \(split): first restored frame"
        )
        restoredWrites.removeAll()
        restoredEvents.removeAll()

        XCTAssertEqual(
            restored.processOutput(bytes: remainder, streamSeq: UInt64(split)),
            .success,
            "case \(caseIndex) split \(split): restored suffix"
        )
        XCTAssertEqual(restored.throughSeq, finalSequence)
        pumpMainQueue()
        // Non-vacuous: referenceWrites was already proven non-empty above, so
        // this equality asserts the restored surface reproduced the SAME real
        // reply bytes, not empty == empty.
        XCTAssertFalse(
            restoredWrites.isEmpty,
            "case \(caseIndex) split \(split): restored suffix must produce real reply bytes"
        )
        XCTAssertEqual(
            restoredWrites,
            referenceWrites,
            "case \(caseIndex) split \(split): terminal replies"
        )
        XCTAssertEqual(
            restoredEvents,
            referenceEvents,
            "case \(caseIndex) split \(split): terminal effects"
        )
        XCTAssertEqual(
            readScreenText(restored),
            finalScreen,
            "case \(caseIndex) split \(split): final screen"
        )
        XCTAssertEqual(
            restored.processOutput(bytes: Data("x".utf8), streamSeq: 0),
            .invalidValue,
            "case \(caseIndex) split \(split): stale sequence rejection"
        )
    }

    func testEveryLibVtAuthoredSplitRestoresIntoRealSurface() throws {
        if let expected = ProcessInfo.processInfo.environment["HIVE_EXPECTED_TEST_ARCH"] {
            XCTAssertEqual(runtimeArchitecture, expected, "release lock ran wrong slice")
        }
        XCTAssertNotEqual(runtimeArchitecture, "unsupported")

        let directory = try fixtureDirectory()
        let corpus = try readCorpus(directory)
        XCTAssertEqual(corpus.cases, expectedCorpus, "C and Swift corpus must be exact")
        XCTAssertEqual(corpus.subsequent, expectedSubsequent)

        var fixtureCount = 0
        for (caseIndex, bytes) in corpus.cases.enumerated() {
            for split in 0...bytes.count {
                try verify(
                    directory: directory,
                    bytes: bytes,
                    subsequent: corpus.subsequent,
                    caseIndex: caseIndex,
                    split: split
                )
                fixtureCount += 1
            }
        }
        XCTAssertEqual(fixtureCount, 187, "full pinned byte-split corpus")
    }
}
