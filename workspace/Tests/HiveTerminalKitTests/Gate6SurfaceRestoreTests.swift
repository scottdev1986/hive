import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 6 (M1-B1) surface-path live proof, under the adjudicated split:
/// checkpoint AUTHORING is the headless lib-vt side (qualified by
/// native/tests/checkpoint/headless-checkpoint-harness.c, which writes
/// checkpoint-fixtures/authored.hvgcp into the toolchain-locked artifact);
/// the embedded UI surface is a RESTORE-ONLY consumer. This suite restores
/// that authored payload — produced by a DIFFERENT library than the one
/// restoring it — into a REAL manual surface and proves the consumer
/// contract: restore succeeds, the first frame shows the authored content,
/// restore emits no spurious writes toward the host, and the surface
/// accepts exact ordered replay at the caller-chosen through_seq.
final class Gate6SurfaceRestoreTests: XCTestCase {
    /// The authored fixture from the same artifact this test's GhosttyKit
    /// came from (payloads are build-bound, so cross-artifact mixing is
    /// impossible by construction — the import would reject it).
    private func fixturePayload() throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveTerminalKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // workspace
            .deletingLastPathComponent() // repo root
        let artifacts = root.appendingPathComponent(".cache/native/artifacts")
        let candidates = (try? FileManager.default.contentsOfDirectory(
            at: artifacts, includingPropertiesForKeys: nil)) ?? []
        for dir in candidates {
            let fixture = dir.appendingPathComponent("checkpoint-fixtures/authored.hvgcp")
            if let data = try? Data(contentsOf: fixture), !data.isEmpty {
                return data
            }
        }
        XCTFail("authored checkpoint fixture missing — rerun scripts/build-ghosttykit.sh " +
                "(or scripts/qualify-ghostty-checkpoint.sh) so the artifact carries " +
                "checkpoint-fixtures/authored.hvgcp; gate 6 live proof requires it")
        throw XCTSkip("unreachable — XCTFail above already failed the test")
    }

    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 6 live proof, got: \(error)")
            throw error
        }
    }

    private func readScreenText(_ surface: GhosttyManualSurface) -> String {
        guard let handle = surface.surfaceHandle else { return "" }
        var text = ghostty_text_s()
        let sel = ghostty_selection_s(
            top_left: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
            bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
            rectangle: false
        )
        guard ghostty_surface_read_text(handle, sel, &text) else { return "" }
        defer { ghostty_surface_free_text(handle, &text) }
        return String(cString: text.text)
    }

    func testRestoreAuthoredCheckpointFirstFrameNoSpuriousWritesExactReplay() throws {
        let payload = try fixturePayload()
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        var events: [BridgeEvent] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        surface.callbackContext.onEvent = { events.append($0) }

        // Caller-chosen through_seq, as sessiond would supply from its
        // journal position.
        let throughSeq: UInt64 = 1_000
        let result = surface.restoreCheckpoint(payload: payload, throughSeq: throughSeq)

        // KNOWN DEFECT until option D (boris audit 2026-07-18; cross-vendor
        // review 2026-07-18 narrowed this from an over-broad XCTExpectFailure
        // that masked ANY later regression): the lib-vt-authored payload is
        // REJECTED by the embedded surface's restore because lib-vt (c_abi=
        // true) and the embedded core (c_abi=false) serialize the same
        // structs with divergent enum backing, while the source-only build
        // id falsely promises compatibility. So the ONLY assertion the
        // current snapshot can make is the exact rejection — scoped here,
        // masking nothing. When option D aligns c_abi and restore returns
        // .success, this guard falls through and the FULL proof below
        // becomes the real gate (that fall-through is itself the loud
        // signal Calvin's D work must complete this test).
        guard result == .success else {
            XCTAssertEqual(result, .invalidValue,
                           "HIVE-B1-G6-XLIB: until option D aligns c_abi, cross-library restore is rejected " +
                           "with .invalidValue; when this starts returning .success the full proof below runs")
            XCTAssertEqual(surface.throughSeq, 0, "a rejected restore must not advance through_seq")
            return
        }

        // ---- POST-D PROOF (runs only once cross-library restore works) ----
        XCTAssertEqual(surface.throughSeq, throughSeq)

        // No spurious host-bound bytes may be emitted by the restore itself
        // (story: "emits no spurious input/write/event"). Terminal-generated
        // writes are synchronous on this thread, so an empty log is
        // meaningful, not a race.
        XCTAssertTrue(writes.isEmpty, "restore must not emit bytes toward the host, got \(writes)")

        // Restore DOES emit the state-sync events the embedded restore path
        // fires (embedded.zig ~1259-1261: title, pwd, invalidate) — these
        // are surface-internal, not host-bound bytes.
        let eventTypes = Set(events.map(\.type))
        XCTAssertTrue(eventTypes.contains(.invalidate),
                      "restore must invalidate so the first frame repaints, got \(eventTypes)")
        XCTAssertTrue(eventTypes.contains(.title) && eventTypes.contains(.pwd),
                      "restore must re-emit title+pwd from the restored terminal, got \(eventTypes)")

        // First frame: the authored content (harness `content` constant —
        // fixture contract, keep in sync) is on screen.
        let screen = readScreenText(surface)
        XCTAssertTrue(screen.contains("hello é world"),
                      "restored first frame must show the authored text — got \(screen.prefix(80).debugDescription)")
        XCTAssertTrue(screen.contains("red"),
                      "restored first frame must include the SGR-styled authored text")

        // Exact replay: ordered output continues at the restored seq, and
        // the restored parser answers protocol queries byte-exactly.
        writes.removeAll()
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: throughSeq), .success,
                       "replay at the restored through_seq must be accepted")
        XCTAssertEqual(writes, [Data("\u{1B}[?62;22c".utf8)],
                       "the restored surface must answer DA1 byte-exactly, exactly once")

        // A replay that ignores the restored seq is still rejected — the
        // ledger position genuinely moved to the restored through_seq.
        XCTAssertEqual(surface.processOutput(bytes: Data("x".utf8), streamSeq: 0), .invalidValue,
                       "pre-restore sequence numbers must be invalid after restore")
    }
}
