import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

final class Gate8ClipboardTests: XCTestCase {
    private func makeKeyEvent(_ text: String, keyCode: UInt16 = 7) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: text,
            charactersIgnoringModifiers: text,
            isARepeat: false,
            keyCode: keyCode
        )!
    }

    private func makeTerminal(_ surface: GhosttyManualSurface) -> HiveTerminalView {
        HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
    }

    private func drainMain(until predicate: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    private func drainMain(for duration: TimeInterval) {
        let deadline = Date().addingTimeInterval(duration)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    func testDisabledReplySurfaceRoutesKeyTextAndBracketedPasteThroughOneWriteCallback() throws {
        let clipboard = GhosttyClipboardContext(
            read: { location in location == GHOSTTY_CLIPBOARD_STANDARD ? "clip\nboard" : nil },
            write: { _, _ in }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let enableBracketedPaste = Data("\u{1B}[?2004h".utf8)
        let deviceAttributesQuery = Data("\u{1B}[c".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enableBracketedPaste, streamSeq: 0), .success)
        XCTAssertEqual(
            surface.processOutput(bytes: deviceAttributesQuery, streamSeq: UInt64(enableBracketedPaste.count)),
            .success
        )
        drainMain(for: 0.1)
        XCTAssertTrue(writes.isEmpty, "terminal replies must stay disabled on the renderer-copy role")

        terminal.encodeKey(makeKeyEvent("x"))
        terminal.insertText("文", replacementRange: NSRange(location: NSNotFound, length: 0))
        terminal.paste(nil)

        let expected = Data(
            "x\u{1B}[200~文\u{1B}[201~\u{1B}[200~clip\nboard\u{1B}[201~".utf8
        )
        drainMain(until: {
            writes.reduce(into: Data(), { $0.append($1) }).count >= expected.count
        })
        let actual = writes.reduce(into: Data(), { $0.append($1) })
        XCTAssertEqual(
            actual,
            expected,
            "actual hex: \(actual.map { String(format: "%02x", $0) }.joined())"
        )
    }

    func testUnsafePasteConfirmationFailsClosed() throws {
        var confirmations: [(String, ghostty_clipboard_request_e)] = []
        let clipboard = GhosttyClipboardContext(
            read: { _ in "echo unsafe\n" },
            write: { _, _ in },
            onConfirmation: { confirmations.append(($0, $1)) }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        let readBefore = HiveGhosttyRuntimeCallbackProbes.count(.readClipboard)
        let confirmBefore = HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard)

        terminal.paste(nil)

        drainMain(until: { !confirmations.isEmpty })
        drainMain(for: 0.1)
        XCTAssertEqual(confirmations.first?.0, "echo unsafe\n")
        XCTAssertEqual(confirmations.first?.1, GHOSTTY_CLIPBOARD_REQUEST_PASTE)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.readClipboard), readBefore + 1)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard), confirmBefore + 1)
        XCTAssertTrue(writes.isEmpty, "unsafe content must never reach the PTY without an affirmative UI")
    }

    func testConfirmedClipboardWriteIsDroppedWithoutHostAuthorizationUI() {
        var copied: [[GhosttyClipboardContent]] = []
        let clipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { _, contents in copied.append(contents) }
        )
        let runtime = GhosttyBridgeFactory.makeRuntimeConfig(wakeupContext: GhosttyAppWakeupContext())
        let before = HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard)
        "text/plain".withCString { mime in
            "blocked".withCString { data in
                var content = ghostty_clipboard_content_s(mime: mime, data: data)
                runtime.write_clipboard_cb?(
                    clipboard.unownedContextPointer,
                    GHOSTTY_CLIPBOARD_STANDARD,
                    &content,
                    1,
                    true
                )
            }
        }
        drainMain(for: 0.1)

        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard), before + 1)
        XCTAssertTrue(copied.isEmpty)
    }

    func testSelectionCopyCopiesCallbackContentBeforeDeferredHostWrite() throws {
        var copied: [[GhosttyClipboardContent]] = []
        let clipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { location, contents in
                XCTAssertEqual(location, GHOSTTY_CLIPBOARD_STANDARD)
                copied.append(contents)
            }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        let output = Data("copy me".utf8)
        XCTAssertEqual(surface.processOutput(bytes: output, streamSeq: 0), .success)

        terminal.selectAll(nil)
        drainMain(until: { surface.semanticSnapshot()?.selection != nil })
        drainMain(for: 0.1)
        XCTAssertTrue(copied.isEmpty, "selection is viewer-local until the explicit host copy gesture")
        let before = HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard)

        terminal.copy(nil)

        XCTAssertTrue(copied.isEmpty, "the C array must be copied now but delivered only after callback return")
        drainMain(until: { !copied.isEmpty })
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard), before + 1)
        XCTAssertEqual(copied.count, 1)
        XCTAssertEqual(copied[0].first(where: { $0.mime == "text/plain" })?.data, "copy me")
    }

    func testOSC52CannotReachClipboardCallbacksUnderDisabledPolicy() throws {
        var readCount = 0
        var copied: [[GhosttyClipboardContent]] = []
        let clipboard = GhosttyClipboardContext(
            read: { _ in
                readCount += 1
                return "secret"
            },
            write: { _, contents in copied.append(contents) }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        defer { surface.free() }
        var writes: [Data] = []
        var events: [BridgeEvent] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        surface.callbackContext.onEvent = { events.append($0) }
        let readBefore = HiveGhosttyRuntimeCallbackProbes.count(.readClipboard)
        let confirmBefore = HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard)
        let writeBefore = HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard)

        let writeOSC = Data("\u{1B}]52;c;aGVsbG8=\u{07}".utf8)
        let readOSC = Data("\u{1B}]52;c;?\u{07}".utf8)
        XCTAssertEqual(surface.processOutput(bytes: writeOSC, streamSeq: 0), .success)
        XCTAssertEqual(surface.processOutput(bytes: readOSC, streamSeq: UInt64(writeOSC.count)), .success)
        drainMain(for: 0.2)

        XCTAssertTrue(events.contains { $0.type == .clipboardDenied })
        XCTAssertEqual(readCount, 0)
        XCTAssertTrue(copied.isEmpty)
        XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.readClipboard), readBefore)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.confirmReadClipboard), confirmBefore)
        XCTAssertEqual(HiveGhosttyRuntimeCallbackProbes.count(.writeClipboard), writeBefore)
    }

    func testQueuedClipboardCompletionDropsAfterSurfaceTeardown() throws {
        let clipboard = GhosttyClipboardContext(
            read: { _ in "late paste" },
            write: { _, _ in }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        let terminal = makeTerminal(surface)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        terminal.paste(nil)
        surface.free()
        drainMain(for: 0.1)

        XCTAssertTrue(writes.isEmpty)
    }

    func testPendingClipboardRequestCompletesEmptyBeforeTeardown() {
        let clipboard = GhosttyClipboardContext(
            read: { _ in "must not escape" },
            write: { _, _ in }
        )
        let engine = FakeManualSurface()
        clipboard.bind(surface: engine)
        let state = UnsafeMutableRawPointer(bitPattern: 1)!

        XCTAssertTrue(clipboard.beginRead(location: GHOSTTY_CLIPBOARD_STANDARD, state: state))
        clipboard.beginTeardown()

        XCTAssertEqual(engine.clipboardCompletions.count, 1)
        XCTAssertEqual(engine.clipboardCompletions[0].text, "")
        XCTAssertEqual(engine.clipboardCompletions[0].state, state)
        XCTAssertTrue(engine.clipboardCompletions[0].confirmed)
        drainMain(for: 0.1)
        XCTAssertEqual(engine.clipboardCompletions.count, 1, "the stale queued completion must be execution-gated")
    }
}
