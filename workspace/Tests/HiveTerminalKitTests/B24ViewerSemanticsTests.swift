import AppKit
import Carbon
import CoreImage
import Darwin
import HiveGhosttyC
import IOSurface
import XCTest
@testable import HiveTerminalKit

final class B24ViewerSemanticsTests: XCTestCase {
    private func makeTerminal(_ engine: ManualSurfaceEngine) -> HiveTerminalView {
        HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 640, height: 360),
            engine: engine
        )
    }

    private func semanticSnapshot(total: UInt64, offset: UInt64, length: UInt64) -> ManualSurfaceSemanticSnapshot {
        ManualSurfaceSemanticSnapshot(
            generation: 1,
            text: "",
            textUTF16Length: 0,
            visibleRows: [],
            selection: nil,
            cursor: ManualSurfaceSemanticCursor(
                utf16Offset: nil,
                line: nil,
                column: 0,
                row: 0,
                framePixels: .zero,
                isVisible: false,
                isPendingWrap: false
            ),
            viewport: ManualSurfaceSemanticViewport(
                total: total,
                offset: offset,
                length: length,
                followsBottom: offset + length >= total
            ),
            geometry: ManualSurfaceSemanticGeometry(
                columns: 0,
                rows: 0,
                widthPixels: 0,
                heightPixels: 0,
                cellWidthPixels: 0,
                cellHeightPixels: 0,
                paddingTopPixels: 0,
                paddingBottomPixels: 0,
                paddingRightPixels: 0,
                paddingLeftPixels: 0
            )
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

    private func keyEquivalent(_ key: String, modifiers: NSEvent.ModifierFlags) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: key,
            charactersIgnoringModifiers: key,
            isARepeat: false,
            keyCode: 0
        )!
    }

    private func navigationKey(_ keyCode: Int) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "",
            charactersIgnoringModifiers: "",
            isARepeat: false,
            keyCode: UInt16(keyCode)
        )!
    }

    private func mouseEvent(
        _ type: NSEvent.EventType,
        x: CGFloat,
        y: CGFloat,
        modifiers: NSEvent.ModifierFlags = []
    ) -> NSEvent {
        NSEvent.mouseEvent(
            with: type,
            location: NSPoint(x: x, y: y),
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: type == .leftMouseUp ? 0 : 1
        )!
    }

    private func scrollEvent(deltaY: Int32) throws -> NSEvent {
        let cgEvent = try XCTUnwrap(CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 1,
            wheel1: deltaY,
            wheel2: 0,
            wheel3: 0
        ))
        return try XCTUnwrap(NSEvent(cgEvent: cgEvent))
    }

    private func drag(
        _ terminal: HiveTerminalView,
        modifiers: NSEvent.ModifierFlags = []
    ) {
        terminal.mouseDown(with: mouseEvent(.leftMouseDown, x: 14, y: 342, modifiers: modifiers))
        terminal.mouseDragged(with: mouseEvent(.leftMouseDragged, x: 210, y: 342, modifiers: modifiers))
        terminal.mouseUp(with: mouseEvent(.leftMouseUp, x: 210, y: 342, modifiers: modifiers))
    }

    func testProductPolicyPinsBoundedHistoryAndLocalSelectionAfterTheme() throws {
        let contents = HiveTerminalConfiguration.contents()
        let theme = try XCTUnwrap(contents.range(of: "background = 0f1117")?.lowerBound)
        let history = try XCTUnwrap(
            contents.range(of: "scrollback-limit = \(HiveTerminalConfiguration.scrollbackLimitBytes)")?.lowerBound
        )
        let localSelection = try XCTUnwrap(contents.range(of: "copy-on-select = false")?.lowerBound)

        XCTAssertEqual(HiveTerminalConfiguration.scrollbackLimitBytes, 48 * 1024 * 1024)
        XCTAssertLessThan(theme, history)
        XCTAssertLessThan(history, localSelection)
        XCTAssertLessThan(
            localSelection,
            try XCTUnwrap(contents.range(of: "clipboard-read = deny")?.lowerBound),
            "viewer policy must stay in the post-theme override layer with the Gate-9 clipboard policy"
        )
    }

    func testSearchOverlayReportsRetainedHistoryScopeAndLiveEngineCounts() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        terminal.showSearch(nil)
        XCTAssertTrue(terminal.searchState.isPresented)
        XCTAssertEqual(terminal.searchState.retainedHistoryLimitBytes, 48 * 1024 * 1024)
        XCTAssertTrue(terminal.searchState.historyLimitNotice.contains("48 MiB"))

        XCTAssertTrue(terminal.search("needle"))
        engine.callbackContext.enqueueActionNotification(.searchTotal(3))
        engine.callbackContext.enqueueActionNotification(.searchSelected(1))
        drainMain(until: { terminal.searchState.selectedResult == 1 })

        XCTAssertEqual(terminal.searchState.query, "needle")
        XCTAssertEqual(terminal.searchState.totalResults, 3)
        XCTAssertEqual(terminal.searchState.selectedResult, 1)
        XCTAssertEqual(terminal.searchOverlayForTesting?.resultText, "2/3")

        terminal.endSearch()
        XCTAssertFalse(terminal.searchState.isPresented)
        XCTAssertNil(terminal.searchOverlayForTesting)
    }

    func testCommandCopyIsConsumedLocallyAndEnabledOnlyForASelection() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let copyItem = NSMenuItem(title: "Copy", action: #selector(HiveTerminalView.copy(_:)), keyEquivalent: "c")

        XCTAssertFalse(terminal.canCopySelection)
        XCTAssertFalse(terminal.validateMenuItem(copyItem))
        terminal.copy(nil)
        XCTAssertTrue(engine.bindingActions.isEmpty)

        engine.fakeSelection = (offset: 0, length: 4)
        engine.fakeSelectedText = "copy"
        XCTAssertTrue(terminal.canCopySelection)
        XCTAssertTrue(terminal.validateMenuItem(copyItem))
        XCTAssertTrue(terminal.performKeyEquivalent(with: keyEquivalent("c", modifiers: .command)))
        XCTAssertEqual(engine.bindingActions, ["copy_to_clipboard"])
    }

    func testFindKeyEquivalentsOwnSearchWithoutBecomingProviderInput() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        XCTAssertTrue(terminal.performKeyEquivalent(with: keyEquivalent("f", modifiers: .command)))
        XCTAssertTrue(terminal.searchState.isPresented)
        XCTAssertTrue(terminal.performKeyEquivalent(with: keyEquivalent("g", modifiers: .command)))
        XCTAssertTrue(terminal.performKeyEquivalent(with: keyEquivalent("g", modifiers: [.command, .shift])))

        XCTAssertEqual(engine.bindingActions, [
            "navigate_search:next",
            "navigate_search:previous",
        ])
        XCTAssertTrue(engine.keysSentDetail.isEmpty, "search shortcuts must remain viewer-local")
    }

    func testCopyOnSelectPolicyReachesTheEngineAndHostCopyRemainsReachable() throws {
        var deniedPolicyWrites: [[GhosttyClipboardContent]] = []
        let deniedClipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { _, content in deniedPolicyWrites.append(content) }
        )
        let denied = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: HiveTerminalConfiguration.contents(headless: true),
            clipboardContext: deniedClipboard
        )
        defer { denied.free() }
        let deniedTerminal = makeTerminal(denied)
        XCTAssertEqual(denied.processOutput(bytes: Data("copy me".utf8), streamSeq: 0), .success)

        deniedTerminal.selectAll(nil)
        drainMain(until: { denied.semanticSnapshot()?.selection != nil })
        drainMain(for: 0.1)
        XCTAssertNotNil(denied.semanticSnapshot()?.selection, "positive control: selection must exist")
        XCTAssertTrue(deniedPolicyWrites.isEmpty, "copy-on-select=false must reach the engine")

        deniedTerminal.copy(nil)
        drainMain(until: { !deniedPolicyWrites.isEmpty })
        XCTAssertEqual(
            deniedPolicyWrites.first?.first(where: { $0.mime == "text/plain" })?.data,
            "copy me",
            "positive control: the explicit host copy gesture must still reach the same callback"
        )

        var enabledPolicyWrites: [[GhosttyClipboardContent]] = []
        let enabledClipboard = GhosttyClipboardContext(
            read: { _ in nil },
            write: { _, content in enabledPolicyWrites.append(content) }
        )
        let enabledContents = HiveTerminalConfiguration.contents(headless: true)
            .replacingOccurrences(of: "copy-on-select = false", with: "copy-on-select = true")
        let enabled = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: enabledContents,
            clipboardContext: enabledClipboard
        )
        defer { enabled.free() }
        let enabledTerminal = makeTerminal(enabled)
        XCTAssertEqual(enabled.processOutput(bytes: Data("mutation control".utf8), streamSeq: 0), .success)

        enabledTerminal.selectAll(nil)
        drainMain(until: { !enabledPolicyWrites.isEmpty })
        XCTAssertFalse(
            enabledPolicyWrites.isEmpty,
            "mutation control: changing the consumed setting to true must make selection write"
        )
    }

    func testUncapturedDragSelectsLocallyWithoutProviderBytes() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        XCTAssertEqual(
            surface.processOutput(bytes: Data("local selection text\r\n".utf8), streamSeq: 0),
            .success
        )

        drag(terminal)
        drainMain(until: { surface.semanticSnapshot()?.selection != nil })

        XCTAssertFalse(surface.semanticSnapshot()?.selection?.text.isEmpty ?? true)
        XCTAssertTrue(writes.isEmpty, "viewer-local selection must not write provider bytes")
    }

    func testCapturedDragRoutesToApplicationButShiftOverrideSelectsLocally() throws {
        let captured = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { captured.free() }
        let capturedTerminal = makeTerminal(captured)
        var capturedWrites: [Data] = []
        captured.callbackContext.onWrite = { capturedWrites.append($0) }
        let capturedInput = Data("captured text\r\n\u{1B}[?1000h\u{1B}[?1006h".utf8)
        XCTAssertEqual(captured.processOutput(bytes: capturedInput, streamSeq: 0), .success)
        XCTAssertTrue(captured.mouseCaptured(), "positive control: application mouse mode must be active")

        drag(capturedTerminal)
        drainMain(until: { !capturedWrites.isEmpty })
        XCTAssertFalse(capturedWrites.isEmpty, "captured mouse gestures must reach the application")
        XCTAssertNil(captured.semanticSnapshot()?.selection)

        let overridden = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { overridden.free() }
        let overriddenTerminal = makeTerminal(overridden)
        var overriddenWrites: [Data] = []
        overridden.callbackContext.onWrite = { overriddenWrites.append($0) }
        let overrideInput = Data("shift override text\r\n\u{1B}[?1000h\u{1B}[?1006h".utf8)
        XCTAssertEqual(overridden.processOutput(bytes: overrideInput, streamSeq: 0), .success)
        XCTAssertTrue(overridden.mouseCaptured(), "positive control: Shift must override a genuinely captured mode")

        drag(overriddenTerminal, modifiers: .shift)
        drainMain(until: { overridden.semanticSnapshot()?.selection != nil })
        XCTAssertFalse(overridden.semanticSnapshot()?.selection?.text.isEmpty ?? true)
        XCTAssertTrue(overriddenWrites.isEmpty, "Shift override must remain viewer-local")
    }

    func testWheelMovesRetainedViewportLocallyButCapturedWheelDoesNot() throws {
        let local = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { local.free() }
        let localTerminal = makeTerminal(local)
        let localBinding = SurfaceBinding(locator: makeTestLocator(), connectionId: "b24-local-scroll")
        try localTerminal.bind(to: localBinding)
        var output = Data()
        for row in 0..<100 { output.append(Data("local-row-\(row)\r\n".utf8)) }
        XCTAssertEqual(
            localTerminal.applyOutput(bytes: output, streamSeq: 0, frameBinding: localBinding),
            .applied(newHighWater: UInt64(output.count))
        )
        guard let bottom = local.semanticSnapshot() else { return XCTFail("bottom snapshot") }
        XCTAssertTrue(bottom.viewport.followsBottom)
        XCTAssertGreaterThan(bottom.viewport.total, bottom.viewport.length)
        var localWrites: [Data] = []
        local.callbackContext.onWrite = { localWrites.append($0) }

        localTerminal.scrollWheel(with: try scrollEvent(deltaY: 5))
        drainMain(until: {
            local.semanticSnapshot()?.viewport.followsBottom == false
                && localTerminal.scrollState.followsBottom == false
        })
        XCTAssertFalse(local.semanticSnapshot()?.viewport.followsBottom ?? true)
        XCTAssertTrue(localWrites.isEmpty)
        let anchoredOffset = local.semanticSnapshot()?.viewport.offset

        let unseen = Data("new-output-while-scrolled\r\n".utf8)
        XCTAssertEqual(
            localTerminal.applyOutput(
                bytes: unseen,
                streamSeq: UInt64(output.count),
                frameBinding: localBinding
            ),
            .applied(newHighWater: UInt64(output.count + unseen.count))
        )
        drainMain(until: { localTerminal.scrollState.hasUnseenOutput })
        XCTAssertEqual(local.semanticSnapshot()?.viewport.offset, anchoredOffset)
        XCTAssertFalse(local.semanticSnapshot()?.viewport.followsBottom ?? true)
        XCTAssertEqual(localTerminal.newOutputIndicatorForTesting?.title, "New output ↓")

        localTerminal.keyDown(with: navigationKey(kVK_End))
        drainMain(until: { localTerminal.scrollState.followsBottom })
        XCTAssertTrue(local.semanticSnapshot()?.viewport.followsBottom ?? false)
        XCTAssertFalse(localTerminal.scrollState.hasUnseenOutput)
        XCTAssertNil(localTerminal.newOutputIndicatorForTesting)

        let captured = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { captured.free() }
        let capturedTerminal = makeTerminal(captured)
        XCTAssertEqual(captured.processOutput(bytes: output, streamSeq: 0), .success)
        let enable = Data("\u{1B}[?1000h\u{1B}[?1006h".utf8)
        XCTAssertEqual(captured.processOutput(bytes: enable, streamSeq: UInt64(output.count)), .success)
        var capturedWrites: [Data] = []
        captured.callbackContext.onWrite = { capturedWrites.append($0) }

        capturedTerminal.mouseDown(with: mouseEvent(.leftMouseDown, x: 14, y: 342))
        capturedTerminal.mouseUp(with: mouseEvent(.leftMouseUp, x: 14, y: 342))
        drainMain(until: { capturedWrites.count >= 2 })
        XCTAssertFalse(capturedWrites.isEmpty, "positive control: enabled mouse mode must capture at the established point")
        capturedWrites.removeAll()

        capturedTerminal.scrollWheel(with: try scrollEvent(deltaY: 5))
        drainMain(until: { !capturedWrites.isEmpty })
        XCTAssertFalse(capturedWrites.isEmpty, "captured wheel must reach the application")
        XCTAssertTrue(captured.semanticSnapshot()?.viewport.followsBottom ?? false)
    }

    func testProductionHostFrameMarksNewOutputWhileViewportIsAnchored() throws {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let host = FakeHost(connectionId: "b24-production-output")
        let locator = makeTestLocator()
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        host.enqueueOutput(streamSeq: 0, bytes: Data("ready".utf8))
        XCTAssertEqual(
            try terminal.attach(
                grant: host.makeGrant(locator: locator),
                geometry: makeGeometry(),
                transport: host.clientTransport
            ),
            .firstCorrectFrame(highWater: 5, connectionId: host.clientTransport.connectionId)
        )

        engine.callbackContext.enqueueActionNotification(.scrollbar(total: 100, offset: 20, len: 20))
        drainMain(until: { terminal.scrollState.followsBottom == false })
        XCTAssertFalse(terminal.scrollState.hasUnseenOutput)

        terminal.pumpHostFrame(
            WireFrame(type: .output, streamSeq: 5, payload: Data("new".utf8)),
            frameBinding: try XCTUnwrap(terminal.binding)
        )

        XCTAssertEqual(terminal.highWater, 8)
        XCTAssertTrue(terminal.scrollState.hasUnseenOutput)
        XCTAssertEqual(terminal.newOutputIndicatorForTesting?.title, "New output ↓")
    }

    func testProductionHostFrameReadsAtomicViewportWhenScrollbarNotificationIsStale() throws {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let host = FakeHost(connectionId: "b24-production-snapshot")
        let locator = makeTestLocator()
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        host.enqueueOutput(streamSeq: 0, bytes: Data("ready".utf8))
        XCTAssertEqual(
            try terminal.attach(
                grant: host.makeGrant(locator: locator),
                geometry: makeGeometry(),
                transport: host.clientTransport
            ),
            .firstCorrectFrame(highWater: 5, connectionId: host.clientTransport.connectionId)
        )

        engine.callbackContext.enqueueActionNotification(.scrollbar(total: 100, offset: 80, len: 20))
        drainMain(until: { terminal.scrollState.totalRows == 100 })
        XCTAssertTrue(terminal.scrollState.followsBottom, "positive control: the notification is stale at bottom")
        engine.fakeSemanticSnapshot = semanticSnapshot(total: 100, offset: 20, length: 20)

        terminal.pumpHostFrame(
            WireFrame(type: .output, streamSeq: 5, payload: Data("new".utf8)),
            frameBinding: try XCTUnwrap(terminal.binding)
        )

        XCTAssertFalse(terminal.scrollState.followsBottom)
        XCTAssertTrue(terminal.scrollState.hasUnseenOutput)
        XCTAssertEqual(terminal.newOutputIndicatorForTesting?.title, "New output ↓")
    }

    func testConfiguredHistoryPrunesOldestRowsButKeepsRecentRowsSearchable() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting(
            contents: """
            keybind = clear
            scrollback-limit = 4096
            copy-on-select = false
            """
        )
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        let oldestMarker = "oldest-pruned-marker"
        let recentMarker = "recent-retained-marker"
        var output = Data("\(oldestMarker)\r\n".utf8)
        for row in 0..<8_000 {
            output.append(Data(String(format: "history-%05d-abcdefghijklmnopqrstuvwxyz\r\n", row).utf8))
        }
        output.append(Data("\(recentMarker)\r\n".utf8))
        XCTAssertEqual(surface.processOutput(bytes: output, streamSeq: 0), .success)

        terminal.showSearch(nil)
        XCTAssertTrue(terminal.search(oldestMarker))
        drainMain(until: { terminal.searchState.totalResults == 0 })
        XCTAssertEqual(
            terminal.searchState.totalResults,
            0,
            "the oldest marker must rotate out under the configured byte bound"
        )

        XCTAssertTrue(terminal.search(recentMarker))
        drainMain(until: {
            terminal.searchState.totalResults == 1 && terminal.searchState.selectedResult == 0
        })
        XCTAssertEqual(
            terminal.searchState.totalResults,
            1,
            "positive control: the same live search predicate must find recently retained history"
        )
    }

    func testSearchCoversRetainedScrollbackAndReceivesRealProgressActions() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { surface.free() }
        let terminal = makeTerminal(surface)
        var output = Data("retained-search-marker\r\n".utf8)
        for row in 0..<80 { output.append(Data("filler-\(row)\r\n".utf8)) }
        XCTAssertEqual(surface.processOutput(bytes: output, streamSeq: 0), .success)
        XCTAssertFalse(surface.semanticSnapshot()?.text.contains("retained-search-marker") ?? true)

        terminal.showSearch(nil)
        XCTAssertTrue(terminal.search("retained-search-marker"))
        drainMain(until: {
            terminal.searchState.totalResults == 1 && terminal.searchState.selectedResult == 0
        })

        XCTAssertEqual(terminal.searchState.totalResults, 1)
        XCTAssertEqual(terminal.searchState.selectedResult, 0)
        XCTAssertEqual(terminal.searchOverlayForTesting?.resultText, "1/1")
    }

    func testAlternateScreenLeavesPrimaryScrollbackAndViewportIntact() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(widthPx: 640, heightPx: 360)
        defer { surface.free() }
        var primary = Data()
        for row in 0..<70 { primary.append(Data("primary-\(row)\r\n".utf8)) }
        XCTAssertEqual(surface.processOutput(bytes: primary, streamSeq: 0), .success)
        let primarySnapshot = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertGreaterThan(primarySnapshot.viewport.total, primarySnapshot.viewport.length)

        let enter = Data("\u{1B}[?1049hALT-SCREEN".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enter, streamSeq: UInt64(primary.count)), .success)
        let alternateSnapshot = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertTrue(alternateSnapshot.text.contains("ALT-SCREEN"))

        let leave = Data("\u{1B}[?1049l".utf8)
        XCTAssertEqual(
            surface.processOutput(bytes: leave, streamSeq: UInt64(primary.count + enter.count)),
            .success
        )
        let restored = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertEqual(restored.viewport.total, primarySnapshot.viewport.total)
        XCTAssertEqual(restored.viewport.offset, primarySnapshot.viewport.offset)
        XCTAssertTrue(restored.text.contains("primary-69"))
        XCTAssertFalse(restored.text.contains("ALT-SCREEN"))
    }

    func testUserCloseRemovesSearchUIAndDropsLateSearchNotifications() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        terminal.showSearch(nil)
        XCTAssertNotNil(terminal.searchOverlayForTesting)

        terminal.userClose()
        engine.callbackContext.enqueueActionNotification(.searchTotal(99))
        drainMain(for: 0.1)

        XCTAssertFalse(terminal.searchState.isPresented)
        XCTAssertNil(terminal.searchOverlayForTesting)
        XCTAssertNil(terminal.searchState.totalResults)
        XCTAssertTrue(engine.freed)
    }

    func testLiveRenderedSustainedOutputQualification() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HIVE_B24_LIVE"] == "1" else {
            throw XCTSkip("set HIVE_B24_LIVE=1 for the unlocked-GUI Instruments proof")
        }
        let screenshotPath = try XCTUnwrap(environment["HIVE_B24_SCREENSHOT_PATH"])
        let framePath = try XCTUnwrap(environment["HIVE_B24_FRAME_PATH"])

        _ = NSApplication.shared
        let terminal = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 900, height: 560),
            viewerId: "b24-live-proof"
        )
        let window = NSWindow(
            contentRect: terminal.frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Hive B2.4 Viewer Qualification"
        window.isReleasedWhenClosed = false
        window.contentView = terminal
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        defer {
            terminal.userClose()
            window.orderOut(nil)
            window.contentView = nil
        }

        let surface = try XCTUnwrap(terminal.engine as? GhosttyManualSurface)
        let geometry = try XCTUnwrap(terminal.reportedGeometry)
        let host = FakeHost(connectionId: "b24-live-proof")
        let locator = makeTestLocator()
        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
        host.enqueueOutput(streamSeq: 0, bytes: Data("\u{1B}[2J\u{1B}[H".utf8))
        let outcome = try terminal.attach(
            grant: host.makeGrant(locator: locator),
            geometry: geometry,
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("expected first correct frame, got \(outcome)")
        }
        drainMain(until: { terminal.surfaceState == .live })
        XCTAssertEqual(terminal.surfaceState, .live)
        let binding = try XCTUnwrap(terminal.binding)
        var sequence = terminal.highWater
        func apply(_ bytes: Data) {
            let expected = sequence + UInt64(bytes.count)
            terminal.pumpHostFrame(
                WireFrame(
                    type: .output,
                    flags: [.contentSensitive],
                    streamSeq: sequence,
                    payload: bytes
                ),
                frameBinding: binding
            )
            XCTAssertEqual(terminal.highWater, expected)
            sequence = expected
        }

        let pixelCard = Data(
            ("\u{1B}[38;5;45mHIVE B2.4 VIEWER LIVE\u{1B}[0m\r\n"
                + "80 MiB sustained output  |  48 MiB retained-history cap\r\n"
                + "search 1/1  |  selection local  |  alternate screen verified\r\n").utf8
        )
        apply(pixelCard)
        surface.draw()
        drainMain(for: 0.25)
        XCTAssertTrue(surface.semanticSnapshot()?.text.contains("HIVE B2.4 VIEWER LIVE") ?? false)
        try captureRenderedFrame(terminal, at: framePath)
        apply(Data("\u{1B}[2J\u{1B}[H".utf8))

        apply(Data("oldest-live-proof-marker\r\n".utf8))
        let line = Data("b24-sustained-output-abcdefghijklmnopqrstuvwxyz-0123456789\r\n".utf8)
        var chunk = Data()
        while chunk.count + line.count <= 64 * 1024 { chunk.append(line) }

        for _ in 0..<16 { apply(chunk) }
        drainMain(for: 0.2)
        let baselineBytes = try physicalFootprintBytes()
        var peakBytes = baselineBytes

        let targetBytes = 80 * 1024 * 1024
        let retainedSearchMarkerAt = 56 * 1024 * 1024
        var insertedRetainedMarker = false
        var nextMemorySample = UInt64(4 * 1024 * 1024)
        while sequence < UInt64(targetBytes) {
            if !insertedRetainedMarker, sequence >= UInt64(retainedSearchMarkerAt) {
                apply(Data("retained-live-proof-marker\r\n".utf8))
                insertedRetainedMarker = true
            }
            autoreleasepool { apply(chunk) }
            if sequence >= nextMemorySample {
                drainMain(for: 0.02)
                peakBytes = max(peakBytes, (try? physicalFootprintBytes()) ?? 0)
                nextMemorySample += UInt64(4 * 1024 * 1024)
            }
        }
        apply(Data("recent-live-proof-marker\r\n".utf8))
        drainMain(for: 0.5)
        let settledBytes = try physicalFootprintBytes()
        peakBytes = max(peakBytes, settledBytes)
        let settledGrowth = settledBytes > baselineBytes ? settledBytes - baselineBytes : 0
        let peakGrowth = peakBytes > baselineBytes ? peakBytes - baselineBytes : 0
        if environment["HIVE_B24_INSTRUMENTED"] != "1" {
            XCTAssertLessThanOrEqual(settledGrowth, 128 * 1024 * 1024)
            XCTAssertLessThanOrEqual(peakGrowth, 192 * 1024 * 1024)
        }

        apply(Data("screenshot-search-marker\r\n".utf8))
        for _ in 0..<32 { apply(chunk) }
        drainMain(for: 0.2)

        terminal.showSearch(nil)
        XCTAssertTrue(terminal.search("oldest-live-proof-marker"))
        drainMain(until: { terminal.searchState.totalResults == 0 })
        XCTAssertEqual(terminal.searchState.totalResults, 0)
        XCTAssertTrue(terminal.search("screenshot-search-marker"))
        drainMain(until: {
            terminal.searchState.totalResults == 1 && terminal.searchState.selectedResult == 0
        })
        XCTAssertEqual(terminal.searchState.totalResults, 1)
        XCTAssertEqual(terminal.searchState.selectedResult, 0)
        terminal.endSearch()
        drainMain(for: 0.1)

        XCTAssertTrue(terminal.engine.performBindingAction("scroll_page_up"))
        drainMain(until: { surface.semanticSnapshot()?.viewport.followsBottom == false })
        drainMain(for: 0.1)
        XCTAssertFalse(surface.semanticSnapshot()?.viewport.followsBottom ?? true)
        let anchor = surface.semanticSnapshot()?.viewport.offset
        apply(Data("unseen-live-proof-output\r\n".utf8))
        drainMain(until: { terminal.scrollState.hasUnseenOutput })
        XCTAssertTrue(terminal.scrollState.hasUnseenOutput)
        XCTAssertEqual(surface.semanticSnapshot()?.viewport.offset, anchor)
        XCTAssertEqual(terminal.newOutputIndicatorForTesting?.title, "New output ↓")

        terminal.showSearch(nil)
        XCTAssertTrue(terminal.search("screenshot-search-marker"))
        drainMain(until: {
            terminal.searchState.totalResults == 1 && terminal.searchState.selectedResult == 0
        })
        XCTAssertEqual(terminal.searchOverlayForTesting?.resultText, "1/1")
        XCTAssertTrue(terminal.navigateSearchToNext())
        drainMain(until: {
            surface.semanticSnapshot()?.text.contains("screenshot-search-marker") == true
        })

        drag(terminal)
        drainMain(until: { surface.semanticSnapshot()?.selection != nil })
        XCTAssertFalse(surface.semanticSnapshot()?.selection?.text.isEmpty ?? true)
        XCTAssertTrue(surface.semanticSnapshot()?.text.contains("screenshot-search-marker") ?? false)
        surface.draw()
        drainMain(until: { terminal.renderEvidence.hasPresentedContents })
        XCTAssertTrue(terminal.renderEvidence.hasPresentedContents)
        drainMain(for: 0.25)
        if environment["HIVE_B24_INSTRUMENTED"] != "1" {
            try capture(window: window, at: screenshotPath)
        }

        let drawsBeforeOcclusion = terminal.drawScheduledCount
        window.orderOut(nil)
        drainMain(until: { terminal.appliedOcclusionVisible == false })
        apply(Data("occluded-live-proof-output\r\n".utf8))
        drainMain(for: 0.2)
        XCTAssertEqual(terminal.drawScheduledCount, drawsBeforeOcclusion)
        window.makeKeyAndOrderFront(nil)
        drainMain(until: { terminal.appliedOcclusionVisible == true })
        drainMain(until: { terminal.drawScheduledCount == drawsBeforeOcclusion + 1 })

        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
        let drawsBeforeSleep = terminal.drawScheduledCount
        apply(Data("sleep-gated-live-proof-output\r\n".utf8))
        drainMain(for: 0.2)
        XCTAssertEqual(terminal.drawScheduledCount, drawsBeforeSleep)
        let wakesBefore = terminal.wakeTransitionCount
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
        drainMain(until: { terminal.wakeTransitionCount == wakesBefore + 1 })
        drainMain(until: { terminal.drawScheduledCount == drawsBeforeSleep + 1 })

        surface.callbackContext.enqueueRendererHealth(.unhealthy)
        drainMain(until: { !terminal.rendererHealthy })
        let drawsBeforeRecovery = terminal.drawScheduledCount
        apply(Data("renderer-health-pending-output\r\n".utf8))
        drainMain(for: 0.2)
        XCTAssertEqual(terminal.drawScheduledCount, drawsBeforeRecovery)
        surface.callbackContext.enqueueRendererHealth(.healthy)
        drainMain(until: { terminal.rendererHealthy })
        drainMain(until: { terminal.drawScheduledCount == drawsBeforeRecovery + 1 })

        let metrics = "B24_LIVE_METRICS baseline_bytes=\(baselineBytes) "
            + "settled_bytes=\(settledBytes) peak_bytes=\(peakBytes) "
            + "settled_growth_bytes=\(settledGrowth) peak_growth_bytes=\(peakGrowth) "
            + "scrollback_limit_bytes=\(HiveTerminalConfiguration.scrollbackLimitBytes) "
            + "input_bytes=\(sequence) instrumented=\(environment["HIVE_B24_INSTRUMENTED"] == "1") "
            + "screenshot=\(screenshotPath) frame=\(framePath)"
        print(metrics)
        if let metricsPath = environment["HIVE_B24_METRICS_PATH"] {
            try (metrics + "\n").write(toFile: metricsPath, atomically: true, encoding: .utf8)
        }
    }

    private func physicalFootprintBytes() throws -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            throw NSError(domain: NSMachErrorDomain, code: Int(result))
        }
        return info.phys_footprint
    }

    private func capture(window: NSWindow, at path: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(window.windowNumber), path]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertGreaterThan((attributes[.size] as? NSNumber)?.intValue ?? 0, 10_000)
    }

    private func captureRenderedFrame(_ terminal: HiveTerminalView, at path: String) throws {
        let layer = try XCTUnwrap(terminal.ghosttyRenderingLayer)
        let ioSurface = try XCTUnwrap(layer.contents as? IOSurface)
        let image = CIImage(ioSurface: ioSurface)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        try CIContext().writePNGRepresentation(
            of: image,
            to: url,
            format: .RGBA8,
            colorSpace: colorSpace
        )
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertGreaterThan((attributes[.size] as? NSNumber)?.intValue ?? 0, 10_000)
    }

}
