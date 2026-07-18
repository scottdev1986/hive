import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 9 (M1-B1): the NON-ACTION runtime-callback half of the matrix
/// (close_surface_cb, read/confirm/write clipboard cbs) plus the
/// observe-only action-notification carrier for Gate 10.
///
/// Every unreachability claim here is probe-measured with a
/// direct-invocation positive control proving the probe itself observes —
/// a dead probe would otherwise make "never fired" vacuous.
final class Gate9CallbackMatrixTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 9 matrix, got: \(error)")
            throw error
        }
    }

    private func drainMain(_ seconds: TimeInterval = 0.3) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    // MARK: close request

    /// Positive control for the probe seam: the REAL factory runtime config's
    /// close_surface_cb increments the probe when invoked directly. Without
    /// this, the "never fired" assertions below could pass on a dead probe.
    func testCloseSurfaceProbeObservesDirectInvocation() {
        let runtime = GhosttyBridgeFactory.makeRuntimeConfig(wakeupContext: GhosttyAppWakeupContext())
        let before = HiveGhosttyRuntimeCallbackProbes.count(.closeSurface)
        runtime.close_surface_cb?(nil, false)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.closeSurface), before + 1,
                       "the factory's close_surface_cb must record on the probe when invoked")
    }

    /// Story cover "close request": a close request on a manual surface is
    /// HANDLED as the CLOSE_REQUEST bridge event (embedded.zig Surface.close
    /// takes the hive_manual branch and RETURNS before app.opts.close_surface),
    /// so the C close_surface_cb is unreachable-by-construction. Both halves
    /// are asserted: the event arrives, and the probe stays flat.
    func testCloseRequestSurfacesAsBridgeEventNeverAsCloseSurfaceCb() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        var events: [BridgeEvent] = []
        surface.callbackContext.onEvent = { events.append($0) }
        let before = HiveGhosttyRuntimeCallbackProbes.count(.closeSurface)

        ghostty_surface_request_close(handle)
        drainMain()

        XCTAssertTrue(events.contains { $0.type == .closeRequest },
                      "a close request on a manual surface must surface as the CLOSE_REQUEST bridge " +
                      "event (visible behavior); got \(events.map(\.type))")
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.closeSurface), before,
                       "the C close_surface_cb must never fire for a manual surface — the hive_manual " +
                       "branch returns first (embedded.zig Surface.close)")
    }

    // MARK: OSC 52 clipboard

    /// OSC 52 write from untrusted bytes: DENIED with VISIBLE behavior — the
    /// CLIPBOARD_DENIED bridge event fires, the macOS pasteboard is untouched
    /// (changeCount stable), and the deny happens in the patched vt handler
    /// BEFORE the apprt layer (write/confirm clipboard probes stay flat).
    func testOSC52WriteIsVisiblyDeniedAndPasteboardUntouched() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var events: [BridgeEvent] = []
        surface.callbackContext.onEvent = { events.append($0) }
        let pasteboardBefore = NSPasteboard.general.changeCount
        let writeBefore = HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard)
        let confirmBefore = HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard)

        // OSC 52, clipboard 'c', "hello" base64 — a hostile clipboard plant.
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}]52;c;aGVsbG8=\u{07}".utf8), streamSeq: 0),
                       .success)
        drainMain()

        XCTAssertTrue(events.contains { $0.type == .clipboardDenied },
                      "OSC 52 write must be denied VISIBLY via the CLIPBOARD_DENIED event; got \(events.map(\.type))")
        XCTAssertEqual(NSPasteboard.general.changeCount, pasteboardBefore,
                       "untrusted bytes must never mutate the macOS pasteboard")
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard), writeBefore,
                       "the deny must happen in the vt handler — write_clipboard_cb never fires")
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard), confirmBefore)
    }

    /// OSC 52 read: the existing reply-corpus control proves protocol
    /// silence; this half proves the deny LAYER — the request never even
    /// reaches the apprt read_clipboard_cb. Positive control: invoking the
    /// factory's read_clipboard_cb directly both records on the probe and
    /// returns false (the typed deny).
    func testOSC52ReadNeverReachesTheApprtReadCallback() throws {
        let runtime = GhosttyBridgeFactory.makeRuntimeConfig(wakeupContext: GhosttyAppWakeupContext())
        let direct = HiveGhosttyRuntimeCallbackProbes.count(.readClipboard)
        XCTAssertEqual(runtime.read_clipboard_cb?(nil, GHOSTTY_CLIPBOARD_STANDARD, nil), false,
                       "read_clipboard_cb must deny")
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.readClipboard), direct + 1,
                       "probe positive control")

        let surface = try makeSurface()
        defer { surface.free() }
        let before = HiveGhosttyRuntimeCallbackProbes.count(.readClipboard)
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}]52;c;?\u{07}".utf8), streamSeq: 0), .success)
        drainMain()
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.readClipboard), before,
                       "an OSC 52 read from untrusted bytes must be denied before the apprt layer — " +
                       "read_clipboard_cb must never fire from terminal bytes")
    }

    // MARK: action-notification carrier (Gate 10 consumer)

    /// SCROLLBAR: scrolling output must deliver a typed, payload-carrying
    /// notification on the main thread through the per-surface sink.
    func testScrollOutputDeliversScrollbarNotificationWithPayload() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var received: [HiveTerminalActionNotification] = []
        var deliveredOffMain = false
        surface.onActionNotification = { note in
            if !Thread.isMainThread { deliveredOffMain = true }
            received.append(note)
        }

        var out = Data()
        for i in 0..<60 { out.append(Data("line \(i)\r\n".utf8)) }
        XCTAssertEqual(surface.processOutput(bytes: out, streamSeq: 0), .success)
        drainMain(0.5)

        XCTAssertFalse(deliveredOffMain, "action notifications must be delivered on the main thread")
        let scrollbars = received.compactMap { note -> (UInt64, UInt64, UInt64)? in
            if case let .scrollbar(total, offset, len) = note { return (total, offset, len) }
            return nil
        }
        XCTAssertFalse(scrollbars.isEmpty,
                       "scrolling output must deliver a scrollbar notification; got \(received)")
        XCTAssertTrue(scrollbars.contains { $0.0 > 0 && $0.2 > 0 },
                      "scrollbar payload must carry real geometry (total/len > 0); got \(scrollbars)")
    }

    /// SELECTION_CHANGED: a real mouse-drag selection gesture must deliver
    /// the notification (measured, not inferred from the tag name) — and the
    /// selection must be readable via ghostty_surface_read_selection.
    func testSelectionGestureDeliversSelectionChangedNotification() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("hello selection world\r\n".utf8), streamSeq: 0),
                       .success)
        drainMain(0.1)

        var received: [HiveTerminalActionNotification] = []
        surface.onActionNotification = { received.append($0) }

        surface.setFocus(true)
        surface.sendMousePos(x: 10, y: 10, modifiers: [])
        _ = surface.sendMouseButton(state: .press, button: .left, modifiers: [])
        surface.sendMousePos(x: 220, y: 10, modifiers: [])
        _ = surface.sendMouseButton(state: .release, button: .left, modifiers: [])
        drainMain(0.5)

        XCTAssertTrue(received.contains(.selectionChanged),
                      "a drag selection must deliver .selectionChanged; got \(received)")
        XCTAssertNotNil(surface.readSelection(),
                        "the dragged selection must be readable via ghostty_surface_read_selection")
    }

    /// Builds the surface-targeted C value the production dispatch receives,
    /// so the lifetime tests drive the REAL notifySurface path (registry
    /// lookup + context admission gate), not a test-only shortcut.
    private func surfaceTarget(_ handle: ghostty_surface_t) -> ghostty_target_s {
        ghostty_target_s(tag: GHOSTTY_TARGET_SURFACE, target: ghostty_target_u(surface: handle))
    }

    /// Lifetime ORDERING (dylan cross-vendor review 2026-07-18): a note
    /// ENQUEUED while the surface is alive, with free() running before the
    /// main queue drains (wrapper still retained), must deliver nothing.
    /// The enqueue-time registry check alone passed here and delivered
    /// after free; only the execution-time gate (the context's
    /// acceptingCallbacks recheck, closed by beginTeardown in free) makes
    /// this hold.
    func testNotificationEnqueuedBeforeFreeIsDroppedAtExecutionTime() throws {
        let surface = try makeSurface()
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        var received = 0
        surface.onActionNotification = { _ in received += 1 }

        // Enqueue while alive and registered — the enqueue-time check passes.
        HiveGhosttyActionPolicy.notifySurface(surfaceTarget(handle), .selectionChanged)
        // free() runs on main BEFORE the queued delivery closure can (this
        // test body occupies the main thread; the async closure is behind us).
        surface.free()
        drainMain(0.1)

        XCTAssertEqual(received, 0,
                       "a notification enqueued before free() must be dropped at execution time — " +
                       "delivery after free is the dylan-review blocking defect")
        withExtendedLifetime(surface) {} // wrapper retained across the drain, as in the exploit
    }

    /// Lifetime: after free(), a late action routed at the old handle value
    /// must be dropped — never delivered (no callback after free).
    func testNoNotificationDeliveredAfterFree() throws {
        let surface = try makeSurface()
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        var received = 0
        surface.onActionNotification = { _ in received += 1 }
        surface.free()

        // The handle value is only used as a registry KEY (never deref'd).
        HiveGhosttyActionPolicy.notifySurface(surfaceTarget(handle), .selectionChanged)
        drainMain(0.1)
        XCTAssertEqual(received, 0, "a freed surface must never receive action notifications")
    }

    // MARK: static privileged-opener scan

    /// The scanner predicate, factored so the suite can positively control
    /// the DETECTION path itself: first forbidden symbol found on a code
    /// (non-comment) line, or nil. Comment lines may NAME a forbidden symbol
    /// (the policy docs do); only code lines can call one.
    ///
    /// NSWorkspace is judged PER LINE by SUBTRACTION, not marker presence
    /// (eleanor integration review 2026-07-18: a marker-presence allowlist
    /// was evadable by co-locating a benign marker on a mixed line or in an
    /// inline comment): inline comments are stripped first, then the exact
    /// benign observer expressions (Gate 7's sleep/wake observation) are
    /// REMOVED from the line — if any NSWorkspace residue remains (an
    /// opener call, a bare alias, anything else) the line is flagged.
    private static let forbiddenOpeners = ["NSWorkspace", "UserNotifications", "UNUserNotificationCenter",
                                           "EnableSecureEventInput", "DisableSecureEventInput"]
    private static let benignNSWorkspaceExpressions = ["NSWorkspace.shared.notificationCenter",
                                                       "NSWorkspace.willSleepNotification",
                                                       "NSWorkspace.didWakeNotification"]
    private func firstForbiddenOpener(in text: String) -> String? {
        // Strip inline comments so a benign marker inside one can never
        // exempt code on the same line, and a symbol appearing only inside
        // a comment can never flag it (the policy docs name these symbols).
        let codeLines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                if let slash = line.range(of: "//") { return line[line.startIndex..<slash.lowerBound] }
                return line
            }
        for line in codeLines {
            for symbol in Self.forbiddenOpeners where line.contains(symbol) {
                if symbol == "NSWorkspace" {
                    var residual = String(line)
                    for expr in Self.benignNSWorkspaceExpressions {
                        residual = residual.replacingOccurrences(of: expr, with: "")
                    }
                    if !residual.contains("NSWorkspace") { continue }
                }
                return symbol
            }
        }
        return nil
    }

    /// SECURITY: no code path in HiveTerminalKit can open URLs, post user
    /// notifications, or flip macOS secure input — the symbols simply do not
    /// occur. Complements the live denials: even a misrouted verdict has no
    /// privileged sink to reach.
    ///
    /// SELF-CHECKING (dylan cross-vendor review 2026-07-18, second pass): the
    /// committed suite plants a synthetic forbidden opener through the SAME
    /// predicate + symbol list the scan uses, so disabling detection
    /// (emptying the list, breaking the predicate) turns THIS test red —
    /// it can no longer stay green when the answer is NO.
    func testKitSourcesContainNoPrivilegedOpeners() throws {
        // Positive control 1: a planted forbidden CODE line IS detected.
        XCTAssertEqual(firstForbiddenOpener(in: "let opener = NSWorkspace.shared.open(url)"),
                       "NSWorkspace",
                       "detector must catch a planted forbidden opener — nil means forbidden-symbol " +
                       "detection is disabled and every scan result below is vacuous")
        XCTAssertEqual(firstForbiddenOpener(in: "EnableSecureEventInput()"), "EnableSecureEventInput")
        // Positive control 2: an ALIAS evasion is still caught — the benign
        // allowlist must not open a hole for `let ws = NSWorkspace.shared`.
        XCTAssertEqual(firstForbiddenOpener(in: "let ws = NSWorkspace.shared"), "NSWorkspace",
                       "a bare NSWorkspace alias (opener-evasion shape) must be flagged")
        // Positive controls 3+4 (eleanor integration review): co-locating a
        // benign marker must NOT exempt an opener on the same line.
        XCTAssertEqual(firstForbiddenOpener(
                           in: "let opened = NSWorkspace.shared.open(url); let center = NSWorkspace.shared.notificationCenter"),
                       "NSWorkspace",
                       "a mixed line (opener + benign observer) must flag the opener")
        XCTAssertEqual(firstForbiddenOpener(in: "NSWorkspace.shared.open(url) // .notificationCenter"),
                       "NSWorkspace",
                       "a benign marker inside an inline comment must not exempt the opener before it")
        // Positive control 5: the intentional exemptions still hold.
        XCTAssertNil(firstForbiddenOpener(in: "/// OPEN_URL (no NSWorkspace.open from terminal content in B1)."),
                     "a comment-only mention must not trip the scan")
        XCTAssertNil(firstForbiddenOpener(in: "let center = NSWorkspace.shared.notificationCenter"),
                     "the Gate-7 sleep/wake observation line must stay exempt")

        let sourcesRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveTerminalKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // workspace
            .appendingPathComponent("Sources/HiveTerminalKit")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: sourcesRoot, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThanOrEqual(files.count, 5, "scanner must see the kit's sources (dead-scan control)")

        var sawKnownSymbol = false
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            if text.contains("GhosttyManualSurface") { sawKnownSymbol = true }
            XCTAssertNil(firstForbiddenOpener(in: text),
                         "\(file.lastPathComponent) must not reference a privileged opener in code")
        }
        XCTAssertTrue(sawKnownSymbol, "scanner must find a known-present symbol (dead-scan control)")
    }
}
