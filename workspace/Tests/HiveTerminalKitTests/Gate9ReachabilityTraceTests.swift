import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 9 (M1-B1) A-class reachability TRACE — measure-don't-infer.
/// The action classification (HiveGhosttyActionPolicy) names which tags
/// are byte-triggerable, but a name is inference. This drives a battery of
/// real output sequences that SHOULD emit each candidate action through a
/// REAL manual surface and records which tags actually reach the action
/// callback via the policy spy. The recorded set IS the security surface:
/// every tag an agent's untrusted output stream can make Ghostty attempt.
///
/// The test asserts the OBSERVED reachable set is a subset of the tags the
/// policy classifies as byte-reachable (handledByEffects ∪ deniedPolicy ∪
/// engineInert), and that NOTHING privileged/gesture-only leaks. It prints
/// the exact observed set so the classification is grounded in a live
/// measurement the reviewer can read, not tag-name guessing.
final class Gate9ReachabilityTraceTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 9 trace, got: \(error)")
            throw error
        }
    }

    /// Output sequences that exercise the OSC/CSI actions a terminal can be
    /// driven to emit from its byte stream. Sourced from xterm ctlseqs +
    /// Ghostty's osc.zig command set.
    private static let corpus: [(label: String, bytes: [UInt8])] = [
        ("OSC 0 title+icon", Array("\u{1B}]0;agent-title\u{07}".utf8)),
        ("OSC 1 icon", Array("\u{1B}]1;icon\u{07}".utf8)),
        ("OSC 2 title", Array("\u{1B}]2;window-title\u{07}".utf8)),
        ("OSC 7 pwd", Array("\u{1B}]7;file:///tmp/x\u{07}".utf8)),
        ("OSC 8 hyperlink", Array("\u{1B}]8;;https://evil.example/\u{07}link\u{1B}]8;;\u{07}".utf8)),
        ("OSC 9 notification", Array("\u{1B}]9;spam from agent\u{07}".utf8)),
        ("OSC 777 notify", Array("\u{1B}]777;notify;title;body\u{07}".utf8)),
        ("OSC 4 palette", Array("\u{1B}]4;1;rgb:ff/00/00\u{07}".utf8)),
        ("OSC 10 fg", Array("\u{1B}]10;rgb:ff/ff/ff\u{07}".utf8)),
        ("OSC 11 bg", Array("\u{1B}]11;rgb:00/00/00\u{07}".utf8)),
        ("OSC 52 clipboard write", Array("\u{1B}]52;c;aGVsbG8=\u{07}".utf8)),
        ("OSC 52 clipboard read", Array("\u{1B}]52;c;?\u{07}".utf8)),
        ("OSC 9;4 progress", Array("\u{1B}]9;4;1;50\u{07}".utf8)),
        ("OSC 133 prompt marks", Array("\u{1B}]133;A\u{07}prompt\u{1B}]133;B\u{07}cmd\u{1B}]133;C\u{07}out\u{1B}]133;D;0\u{07}".utf8)),
        ("BEL", [0x07]),
        ("OSC 133;D exit code", Array("\u{1B}]133;D;1\u{07}".utf8)),
        ("DECSET 2004 bracketed paste", Array("\u{1B}[?2004h".utf8)),
        ("title stack push/pop", Array("\u{1B}[22;2t\u{1B}[23;2t".utf8)),
    ]

    func testTraceRecordsExactReachableActionSetFromUntrustedOutput() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let lock = NSLock()
        var observed = Set<UInt32>()
        HiveGhosttyActionPolicy.setObserver { tag, _ in
            lock.lock(); observed.insert(tag.rawValue); lock.unlock()
        }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }

        var seq: UInt64 = 0
        for entry in Self.corpus {
            let data = Data(entry.bytes)
            // Ordering faults aren't the subject here; feed each at the
            // running seq so all are accepted.
            XCTAssertEqual(surface.processOutput(bytes: data, streamSeq: seq), .success,
                           "corpus entry \(entry.label) must be accepted so its action path is exercised")
            seq += UInt64(data.count)
        }
        // Actions may dispatch via the app tick; drain the main queue.
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            Thread.sleep(forTimeInterval: 0.01)
        }

        lock.lock(); let reachable = observed; lock.unlock()

        // The measured reachable set, printed for the reviewer/record.
        let names = reachable.sorted().map { raw -> String in
            "\(raw):\(Self.tagName(raw))"
        }
        print("GATE9-TRACE reachable-from-output action tags = \(names)")

        // MEASURED RESULT (2026-07-18): the ONLY action reachable from the
        // entire untrusted-output corpus is SCROLLBAR (rawValue 26) — engine
        // scrollbar-geometry housekeeping, inert. title/pwd/bell reach the
        // surface as HiveManual EFFECTS → bridge events (HIVE_GHOSTTY_EVENT_*),
        // NOT the action callback, so they never appear here; notification/
        // color/progress/clipboard actions are not wired to the manual apprt
        // path at all. This makes the byte-triggerable action surface
        // effectively empty of anything privileged — a stronger result than
        // "denied": the classification is confirmed by measurement, not
        // inferred from tag names.
        //
        // HARD PIN (cross-vendor review 2026-07-18, clyde): assert equality
        // to exactly {SCROLLBAR}, not a soft subset of the policy's
        // byte-reachable buckets. A soft check would pass a dangerous tag
        // that was misclassified into deniedPolicy/handledByEffects/
        // engineInert (e.g. DESKTOP_NOTIFICATION is in deniedPolicyTags —
        // {SCROLLBAR, DESKTOP_NOTIFICATION} would satisfy subset checks
        // while contradicting the empty-privileged-action claim).

        let expected: Set<UInt32> = [GHOSTTY_ACTION_SCROLLBAR.rawValue]

        // 0. Liveness (non-vacuous guard): SCROLLBAR must be present, or the
        //    action channel is dead and a hard equality to {SCROLLBAR} would
        //    fail for the wrong reason. Kept as its own assertion so a dead
        //    observer is diagnosed distinctly from an over-broad set.
        XCTAssertTrue(reachable.contains(GHOSTTY_ACTION_SCROLLBAR.rawValue),
                      "liveness: SCROLLBAR must fire from real output+geometry — empty/missing means the " +
                      "trace channel is dead (observed \(names))")

        // 1. Hard pin: the measured reachable set IS exactly {SCROLLBAR}.
        //    Extra tags = privileged surface grew (or classification lied).
        //    Missing SCROLLBAR is already covered by the liveness assert.
        XCTAssertEqual(reachable, expected,
                       "byte-triggerable action surface must be exactly {SCROLLBAR}; " +
                       "observed \(names) — reclassify / re-measure before pinning")

        // 2. Diagnostic extras (kept; redundant with the hard pin but name
        //    the failure mode if a future edit softens equality by mistake):
        let gestureRaws = Set(HiveGhosttyActionPolicy.deniedGestureTags.map(\.rawValue))
        let leaked = reachable.intersection(gestureRaws)
        XCTAssertTrue(leaked.isEmpty,
                      "no gesture/window-management action may be reachable from untrusted output; leaked \(leaked)")
    }

    private static func tagName(_ raw: UInt32) -> String {
        let known: [UInt32: String] = [
            GHOSTTY_ACTION_SET_TITLE.rawValue: "SET_TITLE",
            GHOSTTY_ACTION_PWD.rawValue: "PWD",
            GHOSTTY_ACTION_RING_BELL.rawValue: "RING_BELL",
            GHOSTTY_ACTION_DESKTOP_NOTIFICATION.rawValue: "DESKTOP_NOTIFICATION",
            GHOSTTY_ACTION_COLOR_CHANGE.rawValue: "COLOR_CHANGE",
            GHOSTTY_ACTION_PROGRESS_REPORT.rawValue: "PROGRESS_REPORT",
            GHOSTTY_ACTION_COMMAND_FINISHED.rawValue: "COMMAND_FINISHED",
            GHOSTTY_ACTION_SHOW_CHILD_EXITED.rawValue: "SHOW_CHILD_EXITED",
            GHOSTTY_ACTION_SELECTION_CHANGED.rawValue: "SELECTION_CHANGED",
            GHOSTTY_ACTION_MOUSE_OVER_LINK.rawValue: "MOUSE_OVER_LINK",
            GHOSTTY_ACTION_MOUSE_SHAPE.rawValue: "MOUSE_SHAPE",
            GHOSTTY_ACTION_CELL_SIZE.rawValue: "CELL_SIZE",
            GHOSTTY_ACTION_SCROLLBAR.rawValue: "SCROLLBAR",
            GHOSTTY_ACTION_RENDER.rawValue: "RENDER",
            GHOSTTY_ACTION_OPEN_URL.rawValue: "OPEN_URL",
            GHOSTTY_ACTION_PROMPT_TITLE.rawValue: "PROMPT_TITLE",
        ]
        return known[raw] ?? "tag#\(raw)"
    }
}
