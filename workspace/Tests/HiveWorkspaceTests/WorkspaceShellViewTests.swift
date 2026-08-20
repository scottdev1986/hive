// WorkspaceShellViewTests.swift
//
// Drives the new shell from the frozen WorkspaceSnapshotV2 and sibling
// corpora and asserts what lands on screen: the availability panel and
// banners say exactly what each projection state says, the sidebar and
// context block stay read-only, the drawer orders by severity then age, and
// keyboard focus reaches the sidebar, menus, and drawer (the repo's Gate 10
// pattern: real views in a real window, real AX properties).

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class WorkspaceShellViewTests: XCTestCase {

    /// The same corpora the wire tests pin — resolved from the repo, never
    /// copied, so fixture drift fails here too.
    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveWorkspaceTests
            .deletingLastPathComponent() // Tests
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    /// The sidebar shows the declared screens, with nothing filtered out of it:
    /// a screen the shell does not have is not declared at all.
    private var fixtureSidebarRoutes: [ShellRoute] {
        ShellScreenRegistry.screens.map(\.route)
    }

    private func makeController(
        scenario: ProjectionAvailability = .current
    ) throws -> WorkspaceShellWindowController {
        _ = NSApplication.shared
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: scenario)
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · instance-fixture"),
            state: state)
        controller.window?.makeKeyAndOrderFront(nil)
        controller.window?.layoutIfNeeded()
        return controller
    }

    /// The dense corpora, which overflow every viewport this suite uses.
    private func makeDenseController() throws -> WorkspaceShellWindowController {
        _ = NSApplication.shared
        let denseDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveWorkspaceTests
            .deletingLastPathComponent() // Tests
            .appendingPathComponent("WorkspaceCoreTests/Fixtures-dense")
            .path
        let state = try ShellFixtureStore(directory: denseDirectory)
            .loadState(scenario: .current)
        return WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · instance-fixture"),
            state: state)
    }

    private func commandItem(_ command: ShellCommand) -> NSMenuItem {
        let item = NSMenuItem(title: command.title, action: nil, keyEquivalent: "")
        item.identifier = NSUserInterfaceItemIdentifier(command.rawValue)
        return item
    }

    private func liveRunProjection() throws -> LiveRunProjection {
        let line = try XCTUnwrap(FeedLine.parse(
            """
            {"v":1,"agents":[{"id":"agent-live","name":"live","tool":"claude",
             "model":"model","status":"idle","sessionLocator":{"schemaVersion":1,
             "instanceId":"rig","subject":{"kind":"agent","agentId":"agent-live"},
             "generation":1,"sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
             "hostKind":"sessiond","engineBuildId":"engine"}}]}
            """))
        return try LiveRunProjection(feedLine: line)
    }

    private func allText(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField { found.append(field.stringValue) }
        for subview in view.subviews { found.append(contentsOf: allText(in: subview)) }
        return found
    }

    /// How far right anything the viewer can see actually reaches, in the
    /// given view's own coordinates. Frame widths alone pass while the visible
    /// content sits in a narrow column with the rest of the window blank.
    private func contentRightEdge(of view: NSView, in root: NSView) -> CGFloat {
        // A hidden view hides its subtree, so descending into one would let
        // content nobody can see answer a question about what is on screen.
        if view !== root, view.isHidden { return 0 }
        var edge: CGFloat = 0
        if view !== root, view.frame.width > 0 {
            edge = view.convert(view.bounds, to: root).maxX
        }
        for subview in view.subviews {
            edge = max(edge, contentRightEdge(of: subview, in: root))
        }
        return edge
    }

    private func findView(
        in view: NSView,
        identifier: String
    ) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let match = findView(in: subview, identifier: identifier) { return match }
        }
        return nil
    }

    // MARK: Fixture-driven rendering

    func testShellRendersTheSnapshotFixtureThroughTheProjectionTypes() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        // Live Run is active by default and renders the frozen outer-horizon
        // WorkspaceSnapshot v2 from the same fixture directory.
        XCTAssertNotNil(findView(in: content, identifier: "outer-horizon-screen"))
        let text = allText(in: content).joined(separator: "\n")
        XCTAssertTrue(text.contains("instance-fixture"), "instance from the fixture")
        XCTAssertTrue(text.contains("revision 1"), "snapshot revision")
        XCTAssertTrue(text.contains("19 admitted / 19 target"), "dense hierarchy count")
    }

    func testTaskRouterRendersEveryRouteCardWithTheDaemonsWeightsAndShares() throws {
        let controller = try makeController()
        let content = try XCTUnwrap(controller.window?.contentView)
        let button = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-router") as? NSButton)
        button.performClick(nil)
        // The fixture's complex_coding route: opus weight 3 (75%), sol weight 1 (25%),
        // both from the daemon's projection — no inspection card, no client arithmetic.
        XCTAssertNotNil(findView(in: content, identifier: "task-router-card-complex_coding"))
        XCTAssertEqual(
            (findView(
                in: content,
                identifier: "task-router-weight-complex_coding-claude/claude-opus-4-8")
                as? NSTextField)?.stringValue,
            "3")
        let share = try XCTUnwrap(findView(
            in: content, identifier: "task-router-share-complex_coding-claude/claude-opus-4-8"))
        XCTAssertTrue(allText(in: share).contains("75%"))
        let text = allText(in: content).joined(separator: "\n")
        XCTAssertFalse(text.contains("Observed inspection"))
        XCTAssertFalse(text.contains("configured 60%"))
    }

    func testModelsQuotaKeepsUsageInProviderCardsWithoutASeparateEvidenceSection() throws {
        let controller = try makeController()
        let button = try XCTUnwrap(findView(
            in: controller.window!.contentView!, identifier: "shell-nav-models") as? NSButton)
        button.performClick(nil)
        let content = controller.window!.contentView!
        XCTAssertNil(findView(in: content, identifier: "models-quota-evidence"))
        XCTAssertNotNil(findView(
            in: content, identifier: "models-quota-meter-claude-5 hour window"))
        XCTAssertNotNil(findView(
            in: content, identifier: "models-quota-usage-opencode"))
    }

    func testRouterAndModelsExerciseAllSevenAvailabilityStates() throws {
        for scenario in ProjectionAvailability.allCases {
            let controller = try makeController(scenario: scenario)
            for route in [ShellRoute.taskRouter, .modelsQuota] {
                let button = try XCTUnwrap(findView(
                    in: controller.window!.contentView!,
                    identifier: "shell-nav-\(route.rawValue)") as? NSButton)
                button.performClick(nil)
                XCTAssertEqual(controller.currentState.activeScreen?.availability, scenario)
            }
        }
    }

    func testAvailabilityBannerStatesAreExercised() throws {
        // Stale, disconnected, and unauthorized carry banners; current and
        // unknown do not. Each banner's words come from the projection.
        let stale = try makeController(scenario: .stale)
        let staleText = allText(in: stale.window!.contentView!).joined(separator: "\n")
        XCTAssertTrue(staleText.contains("Projection is stale"))
        // Stale means the LAST OBSERVED state stays on screen carrying its own
        // timestamp. A test that only reads the banner would pass against a
        // screen that had blanked its values, which is the failure to catch.
        XCTAssertTrue(
            staleText.contains("Observed at 2026-07-29T20:00:00.000Z"),
            "the stale screen must date what it is showing")
        XCTAssertTrue(
            staleText.contains("revision 1"),
            "the stale screen must keep the values it last observed")
        XCTAssertEqual(
            stale.currentState.activeScreen?.observedAt, "2026-07-29T20:00:00.000Z")
        let disconnected = try makeController(scenario: .disconnected)
        let disconnectedText = allText(in: disconnected.window!.contentView!)
            .joined(separator: "\n")
        XCTAssertTrue(disconnectedText.contains("Daemon disconnected"))
        XCTAssertTrue(disconnectedText.contains("2026-07-30T20:00:00.000Z"))
        let unauthorized = try makeController(scenario: .unauthorized)
        let unauthorizedText = allText(in: unauthorized.window!.contentView!)
            .joined(separator: "\n")
        XCTAssertTrue(unauthorizedText.contains("refused this read"))
        XCTAssertTrue(unauthorizedText.contains("read-not-authorized"))
        let current = try makeController(scenario: .current)
        let banners = findView(in: current.window!.contentView!, identifier: "shell-banners")
        XCTAssertEqual(banners?.isHidden, true, "a current projection raises no banner")
    }

    func testAScreenWithNoHonestContractIsOnNoSurfaceAtAll() throws {
        let controller = try makeController()
        let content = controller.window!.contentView!
        // Neither omitted screen is a nav row. The defect this replaces hid one
        // of them and left the other clickable with nothing behind it.
        for omitted in ["tokens", "autonomy"] {
            XCTAssertNil(
                findView(in: content, identifier: "shell-nav-\(omitted)"),
                "\(omitted) must not be a nav row")
        }
        // The positive control: a declared screen IS a nav row, so the two
        // absences above are facts about those screens, not a broken search.
        XCTAssertNotNil(findView(in: content, identifier: "shell-nav-run"))
        // Queen is a frozen wire. Navigating there must show the observed
        // projection, not an absent-row contract gap.
        controller.performShellCommand(commandItem(.showQueenProvider))
        let queenText = allText(in: controller.window!.contentView!).joined(separator: "\n")
        XCTAssertTrue(queenText.contains("claude"), "live provider is named from the fixture")
        XCTAssertEqual(controller.currentState.activeScreen?.contract, .frozen)
        XCTAssertNil(controller.currentState.activeScreen?.banner)
    }

    func testScreenRouterHostsOneScreenAtATime() throws {
        let controller = try makeController()
        guard let host = findView(
            in: controller.window!.contentView!, identifier: "shell-screen-host")
        else { return XCTFail("no screen host") }
        for command in [ShellCommand.showQueenProvider, .memoryOverview, .showTaskRouter] {
            controller.performShellCommand(commandItem(command))
            XCTAssertEqual(host.subviews.count, 1, "one active screen, always")
        }
        XCTAssertEqual(controller.currentState.activeRoute, .taskRouter)
    }

    func testDenseScreenScrollsInsideTheRequestedWindowSize() throws {
        let controller = try makeDenseController()
        guard let window = controller.window, let content = window.contentView else {
            return XCTFail("no window")
        }

        let requestedSize = NSSize(width: 940, height: 508)
        window.setContentSize(requestedSize)
        window.layoutIfNeeded()
        let heightBeforeNavigation = content.bounds.height
        XCTAssertEqual(heightBeforeNavigation, requestedSize.height, accuracy: 1)

        let router = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-router") as? NSButton)
        router.performClick(nil)
        window.layoutIfNeeded()

        XCTAssertEqual(content.bounds.height, heightBeforeNavigation, accuracy: 1)
        let scrollView = try XCTUnwrap(findView(
            in: content, identifier: "shell-screen-scroll") as? NSScrollView)
        let documentView = try XCTUnwrap(scrollView.documentView)
        let mainRow = try XCTUnwrap(findView(
            in: content, identifier: "shell-main-row") as? NSStackView)
        XCTAssertEqual(mainRow.frame.width, content.bounds.width, accuracy: 1)
        XCTAssertEqual(
            scrollView.frame.height,
            content.bounds.height - Theme.Metric.topBarHeight,
            accuracy: 1)
        XCTAssertEqual(
            scrollView.frame.width,
            content.bounds.width - Theme.Metric.sidebarWidth - 1,
            accuracy: 1)
        XCTAssertTrue(documentView.isFlipped)
        XCTAssertEqual(
            documentView.bounds.width,
            scrollView.contentView.bounds.width,
            accuracy: 1)
        XCTAssertGreaterThan(
            documentView.bounds.height,
            scrollView.contentView.bounds.height)

        let bottom = NSPoint(
            x: 0,
            y: documentView.bounds.height - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: bottom)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        XCTAssertGreaterThan(scrollView.contentView.bounds.minY, 0)

        controller.performShellCommand(commandItem(.toggleAttention))
        window.layoutIfNeeded()
        XCTAssertGreaterThan(
            scrollView.contentView.bounds.minY,
            0,
            "a same-route render must preserve the user's scroll position")

        let models = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-models") as? NSButton)
        models.performClick(nil)
        window.layoutIfNeeded()
        XCTAssertEqual(
            scrollView.contentView.bounds.minY,
            0,
            accuracy: 1,
            "navigating to a different screen starts at its header")
    }

    func testDenseScreenFillsEveryWindowWidthItIsGiven() throws {
        let controller = try makeDenseController()
        guard let window = controller.window, let content = window.contentView else {
            return XCTFail("no window")
        }
        let router = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-router") as? NSButton)
        router.performClick(nil)
        let scrollView = try XCTUnwrap(findView(
            in: content, identifier: "shell-screen-scroll") as? NSScrollView)
        let mainRow = try XCTUnwrap(findView(
            in: content, identifier: "shell-main-row") as? NSStackView)
        let documentView = try XCTUnwrap(scrollView.documentView)

        // The window opens at 1100 points wide. A screen that keeps that width
        // once the window is wider leaves the rest of the window blank, which
        // is what a fullscreen capture caught, so every width past the launch
        // width has to be measured.
        for width in [940.0, 1100.0, 1728.0, 2560.0] {
            window.setContentSize(NSSize(width: width, height: 560))
            window.layoutIfNeeded()
            XCTAssertEqual(content.bounds.width, width, accuracy: 1)
            XCTAssertEqual(
                mainRow.frame.width, width, accuracy: 1,
                "the sidebar row must span the window at \(width)")
            XCTAssertEqual(
                scrollView.frame.width,
                width - Theme.Metric.sidebarWidth - 1,
                accuracy: 1,
                "the screen must take every point the sidebar leaves at \(width)")
            XCTAssertEqual(
                documentView.bounds.width,
                scrollView.contentView.bounds.width,
                accuracy: 1,
                "the scrolled document must match its viewport at \(width)")

            // A screen built from its own controls and one built from the
            // shared availability panel are bounded by different constraints,
            // so both have to be measured.
            for route in ["router", "queen"] {
                let nav = try XCTUnwrap(findView(
                    in: content, identifier: "shell-nav-\(route)") as? NSButton)
                nav.performClick(nil)
                window.layoutIfNeeded()
                let panel = try XCTUnwrap(documentView.subviews.first)
                XCTAssertEqual(
                    panel.frame.width, documentView.bounds.width, accuracy: 1,
                    "\(route) must fill the viewport at \(width)")
                // Theme.Space.page of inset on each side; anything narrower is
                // the blank right-hand band the fullscreen capture showed.
                // The upper bound matters just as much: there is no horizontal
                // scroller, so content past the viewport is content nobody can
                // reach, and it would satisfy the lower bound on its own.
                let rightEdge = contentRightEdge(of: panel, in: panel)
                XCTAssertGreaterThan(
                    rightEdge,
                    documentView.bounds.width - Theme.Space.page * 2,
                    "\(route) content must reach the right edge at \(width)")
                XCTAssertLessThanOrEqual(
                    rightEdge,
                    documentView.bounds.width,
                    "\(route) content must not spill past the viewport at \(width)")
            }
        }

        // Dense current installs TaskRouterScreenView and QueenProviderScreenView.
        // The availability panel is a different constraint graph and is what
        // the screen-content-fills-width probe mutates; unknown queen is the
        // measured way that panel is on screen.
        let fallback = try makeController(scenario: .unknown)
        defer { fallback.window?.close() }
        guard let fallbackWindow = fallback.window,
              let fallbackContent = fallbackWindow.contentView else {
            return XCTFail("no fallback window")
        }
        let fallbackQueen = try XCTUnwrap(findView(
            in: fallbackContent, identifier: "shell-nav-queen") as? NSButton)
        fallbackQueen.performClick(nil)
        let fallbackScroll = try XCTUnwrap(findView(
            in: fallbackContent, identifier: "shell-screen-scroll") as? NSScrollView)
        let fallbackDocument = try XCTUnwrap(fallbackScroll.documentView)
        for width in [940.0, 1100.0, 1728.0, 2560.0] {
            fallbackWindow.setContentSize(NSSize(width: width, height: 560))
            fallbackWindow.layoutIfNeeded()
            let panel = try XCTUnwrap(fallbackDocument.subviews.first)
            XCTAssertTrue(
                panel is ShellAvailabilityPanel,
                "unknown queen must be the availability panel at \(width)")
            XCTAssertEqual(
                panel.frame.width, fallbackDocument.bounds.width, accuracy: 1,
                "availability panel must fill the viewport at \(width)")
            let rightEdge = contentRightEdge(of: panel, in: panel)
            XCTAssertGreaterThan(
                rightEdge,
                fallbackDocument.bounds.width - Theme.Space.page * 2,
                "availability panel content must reach the right edge at \(width)")
            XCTAssertLessThanOrEqual(
                rightEdge,
                fallbackDocument.bounds.width,
                "availability panel content must not spill past the viewport at \(width)")
        }
    }

    func testSparseScreenFillsItsViewportWithoutManufacturingScroll() throws {
        let controller = try makeController(scenario: .unknown)
        guard let window = controller.window, let content = window.contentView else {
            return XCTFail("no window")
        }
        window.setContentSize(NSSize(width: 1440, height: 900))
        window.layoutIfNeeded()
        let sparse = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-queen") as? NSButton)
        sparse.performClick(nil)
        window.layoutIfNeeded()

        let scrollView = try XCTUnwrap(findView(
            in: content, identifier: "shell-screen-scroll") as? NSScrollView)
        let documentView = try XCTUnwrap(scrollView.documentView)
        let panel = try XCTUnwrap(documentView.subviews.first)
        XCTAssertEqual(
            documentView.bounds.height,
            scrollView.contentView.bounds.height,
            accuracy: 1,
            "a screen with little to say still fills the viewport it is given")
        XCTAssertEqual(
            panel.frame.height, documentView.bounds.height, accuracy: 1,
            "the panel reaches the document's bottom, so no window shows through")
        let clamped = scrollView.contentView.constrainBoundsRect(
            NSRect(
                origin: NSPoint(x: 0, y: 400),
                size: scrollView.contentView.bounds.size))
        XCTAssertEqual(
            clamped.origin.y, 0, accuracy: 0.5,
            "a screen that fits has nowhere to scroll")
    }

    func testLiveRunFillsItsViewportWithoutManufacturingScroll() throws {
        let controller = try makeController(scenario: .unknown)
        guard let window = controller.window, let content = window.contentView else {
            return XCTFail("no window")
        }
        let sparseWorkbench = LiveRunWorkbenchView(terminalFactory: nil)
        controller.installLiveRunWorkbench(sparseWorkbench)
        window.setContentSize(NSSize(width: 1_440, height: 900))
        window.layoutIfNeeded()

        let scrollView = try XCTUnwrap(findView(
            in: content, identifier: "shell-screen-scroll") as? NSScrollView)
        let documentView = try XCTUnwrap(scrollView.documentView)

        func assertPinned(_ workbench: LiveRunWorkbenchView) throws {
            let panel = try XCTUnwrap(documentView.subviews.first)
            XCTAssertTrue(panel === workbench, "the exact-height route is Live Run")
            XCTAssertEqual(
                documentView.bounds.height,
                scrollView.contentView.bounds.height,
                accuracy: 1,
                "Live Run pins its document to the viewport it is given")
            XCTAssertEqual(
                panel.frame.height, documentView.bounds.height, accuracy: 1,
                "the workbench reaches the document's bottom, so no window shows through")
            let clamped = scrollView.contentView.constrainBoundsRect(
                NSRect(
                    origin: NSPoint(x: 0, y: 400),
                    size: scrollView.contentView.bounds.size))
            XCTAssertEqual(
                clamped.origin.y, 0, accuracy: 0.5,
                "Live Run has nowhere to scroll")
        }

        try assertPinned(sparseWorkbench)

        let tallWorkbench = LiveRunWorkbenchView { session in
            TallLiveRunSurface(locator: session.locator!)
        }
        controller.installLiveRunWorkbench(tallWorkbench)
        tallWorkbench.apply(try liveRunProjection())
        window.layoutIfNeeded()
        try assertPinned(tallWorkbench)
    }

    func testVisibleWindowKeepsItsRequestedSizeAfterLayout() throws {
        let controller = try makeController()
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        let requestedFrame = NSRect(x: 100, y: 100, width: 1100, height: 720)

        window.setFrame(requestedFrame, display: false)
        window.makeKeyAndOrderFront(nil)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))

        XCTAssertEqual(window.frame.width, requestedFrame.width, accuracy: 1)
        XCTAssertEqual(window.frame.height, requestedFrame.height, accuracy: 1)

        controller.performShellCommand(commandItem(.toggleAttention))
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
        XCTAssertEqual(window.frame.width, requestedFrame.width, accuracy: 1)
        XCTAssertEqual(window.frame.height, requestedFrame.height, accuracy: 1)
    }

    // MARK: Sidebar and context block

    func testSidebarHasEveryNavButtonWithRealAccessibilityLabels() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        for route in fixtureSidebarRoutes {
            guard let button = findView(in: content, identifier: "shell-nav-\(route.rawValue)")
                as? NSButton
            else {
                XCTFail("missing nav button for \(route)")
                continue
            }
            XCTAssertEqual(button.accessibilityRole(), .button)
            XCTAssertTrue(
                button.accessibilityLabel()?.contains(route.title) ?? false,
                "\(route) needs a real-words label")
            XCTAssertGreaterThanOrEqual(
                button.fittingSize.height, Theme.Metric.controlMinHeight - 1,
                "\(route) needs a reachable hit target")
        }
        XCTAssertNil(findView(in: content, identifier: "shell-nav-tokens"))
        let run = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-run") as? NSButton)
        let router = try XCTUnwrap(findView(
            in: content, identifier: "shell-nav-router") as? NSButton)
        XCTAssertEqual(run.state, .on)
        XCTAssertFalse(run.isBordered)
        router.performClick(nil)
        XCTAssertEqual(run.state, .off)
        XCTAssertEqual(router.state, .on)
        XCTAssertFalse(router.isBordered)
        for group in ShellNavGroup.allCases {
            XCTAssertTrue(
                allText(in: content).contains(group.title.uppercased()),
                "missing nav group \(group)")
        }
    }

    func testContextBlockIsReadOnly() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        let text = allText(in: content).joined(separator: "\n")
        XCTAssertTrue(text.contains("hive"))
        XCTAssertTrue(text.contains("/Users/test/Projects/hive"))
        XCTAssertTrue(text.contains("instance · instance-fixture"))
        for case let field as NSTextField in content.allSubviews {
            // Read-only means nothing in the shell edits these values;
            // selectable-for-copy stays, as with any Mac label.
            XCTAssertFalse(field.isEditable, "the context block must never edit")
        }
    }

    // MARK: Attention drawer

    func testDrawerTogglesFromTheMenuCommandAndShowsItsEmptyState() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        // Fixture load may raise stranded-work attention; clear so empty is
        // the measured state this case proves.
        controller.apply { $0.apply(attention: AttentionQueue()) }
        XCTAssertNil(findView(in: content, identifier: "shell-attention-drawer"))
        controller.performShellCommand(commandItem(.toggleAttention))
        XCTAssertNotNil(findView(in: content, identifier: "shell-attention-drawer"))
        XCTAssertNotNil(findView(in: content, identifier: "shell-attention-empty"))
        controller.performShellCommand(commandItem(.toggleAttention))
        XCTAssertNil(findView(in: content, identifier: "shell-attention-drawer"))
    }

    // MARK: Run inspector

    func testInspectorTogglesFromTheMenuCommandAndShowsTaskPane() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        XCTAssertNil(findView(in: content, identifier: "shell-inspector"))
        controller.performShellCommand(commandItem(.toggleInspector))
        let inspector = try XCTUnwrap(
            findView(in: content, identifier: "shell-inspector"))
        XCTAssertTrue(inspector.allSubviews.contains {
            ($0 as? NSScrollView)?.hasVerticalScroller == true
        })
        XCTAssertNotNil(findView(in: content, identifier: "shell-inspector-tab-task"))
        XCTAssertNotNil(findView(in: content, identifier: "shell-inspector-title"))
        XCTAssertNil(findView(in: content, identifier: "shell-inspector-criteria-absent"))
        XCTAssertNil(findView(in: content, identifier: "shell-inspector-criterion"))
        controller.performShellCommand(commandItem(.toggleInspector))
        XCTAssertNil(findView(in: content, identifier: "shell-inspector"))
    }

    func testInspectorTabsSwitchWithoutLeavingLiveRun() throws {
        let controller = try makeController()
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        controller.performShellCommand(commandItem(.toggleInspector))
        XCTAssertEqual(controller.currentState.activeRoute, .liveRun)
        controller.apply { $0.selectInspectorTab(.events) }
        XCTAssertEqual(controller.currentState.inspectorTab, .events)
        XCTAssertNotNil(findView(in: content, identifier: "shell-inspector-tab-events"))
        XCTAssertNotNil(findView(in: content, identifier: "shell-inspector-events-absent"))
        XCTAssertNil(findView(in: content, identifier: "shell-inspector-event"))
        controller.apply { $0.selectInspectorTab(.session) }
        XCTAssertEqual(controller.currentState.inspectorTab, .session)
        XCTAssertEqual(controller.currentState.activeRoute, .liveRun)
    }

    func testInspectorEventsTabIsHonestlyAbsent() throws {
        let dense = try makeController(scenario: .current)
        dense.performShellCommand(commandItem(.toggleInspector))
        dense.apply { $0.selectInspectorTab(.events) }
        XCTAssertNotNil(findView(
            in: dense.window!.contentView!, identifier: "shell-inspector-events-absent"))
        XCTAssertNil(findView(
            in: dense.window!.contentView!, identifier: "shell-inspector-event"))
        XCTAssertTrue(allText(in: dense.window!.contentView!).contains {
            $0.contains("no Workspace HTTP GET")
        })
    }

    func testInspectorRendersHierarchyWireWordsWithoutInventedContracts() throws {
        let controller = try makeController()
        controller.performShellCommand(commandItem(.toggleInspector))
        let text = allText(in: controller.window!.contentView!).joined(separator: "\n")
        XCTAssertTrue(text.contains("P3"))
        XCTAssertTrue(text.contains("lead-coordination"))
        XCTAssertFalse(text.contains("acceptedBy (declared)"))
        XCTAssertNil(findView(
            in: controller.window!.contentView!, identifier: "shell-inspector-accepted-by"))
    }

    func testInspectorMenuShortcutIsOptionCommandI() throws {
        let controller = try makeController()
        let menu = ShellMenuBuilder.build(target: controller)
        let viewMenu = try XCTUnwrap(
            menu.items.first { $0.submenu?.title == "View" }?.submenu)
        let inspector = try XCTUnwrap(
            viewMenu.items.first { $0.identifier?.rawValue == "toggle-inspector" })
        XCTAssertEqual(inspector.keyEquivalent, "i")
        XCTAssertEqual(
            inspector.keyEquivalentModifierMask, [.command, .option])
        XCTAssertEqual(
            inspector.action,
            #selector(WorkspaceShellWindowController.performShellCommand(_:)))
    }

    func testDrawerOrdersSeverityThenAge() throws {
        let controller = try makeController()
        var queue = AttentionQueue()
        queue.raise(AttentionItem(
            id: "old-waiting", projectID: "p", paneID: "a",
            severity: .waiting, title: "old waiting", detail: "d",
            raisedAt: 100))
        queue.raise(AttentionItem(
            id: "new-failed", projectID: "p", paneID: "b",
            severity: .failed, title: "new failed", detail: "d",
            raisedAt: 300))
        queue.raise(AttentionItem(
            id: "mid-waiting", projectID: "p", paneID: "c",
            severity: .waiting, title: "mid waiting", detail: "d",
            raisedAt: 200))
        controller.apply { state in
            state.apply(attention: queue)
            state.setAttentionDrawer(visible: true)
        }
        guard let content = controller.window?.contentView else {
            return XCTFail("no content view")
        }
        var rows: [String] = []
        collectRows(in: content, into: &rows)
        XCTAssertEqual(
            rows,
            ["new failed. d", "old waiting. d", "mid waiting. d"],
            "severity first, then age, regardless of insertion order")
    }

    private func collectRows(in view: NSView, into rows: inout [String]) {
        if view.accessibilityIdentifier() == "shell-attention-row",
           let label = view.accessibilityLabel() {
            rows.append(label)
        }
        for subview in view.subviews { collectRows(in: subview, into: &rows) }
    }

    // MARK: Keyboard navigation (Gate 10 pattern: real window, real focus)

    func testKeyboardFocusReachesSidebarMenusAndDrawer() throws {
        let controller = try makeController()
        guard let window = controller.window,
              let content = window.contentView
        else { return XCTFail("no window") }

        XCTAssertNotNil(window.initialFirstResponder)
        // Every sidebar row takes first responder.
        for route in fixtureSidebarRoutes {
            guard let button = findView(in: content, identifier: "shell-nav-\(route.rawValue)")
            else { return XCTFail("missing nav button for \(route)") }
            XCTAssertTrue(
                window.makeFirstResponder(button),
                "\(route) must take keyboard focus")
        }
        // The key-view chain leaves the sidebar (toward the drawer or back to
        // the first row) instead of dead-ending.
        let first = try XCTUnwrap(
            findView(in: content, identifier: "shell-nav-run"))
        var walked = Set<ObjectIdentifier>()
        var cursor: NSView? = first
        var reachedAll = false
        while let current = cursor, !walked.contains(ObjectIdentifier(current)) {
            walked.insert(ObjectIdentifier(current))
            if walked.count == fixtureSidebarRoutes.count { reachedAll = true }
            cursor = current.nextKeyView
        }
        XCTAssertTrue(reachedAll, "the key loop must walk every sidebar row")

        // The drawer's close button joins the loop when the drawer opens.
        controller.performShellCommand(commandItem(.toggleAttention))
        guard let close = findView(in: content, identifier: "shell-attention-close")
        else { return XCTFail("drawer close missing") }
        XCTAssertTrue(window.makeFirstResponder(close))
        XCTAssertNotNil(close.nextKeyView)

        // The Attention toggle is on the menu with its shortcut.
        let menu = ShellMenuBuilder.build(target: controller)
        let viewMenu = try XCTUnwrap(
            menu.items.first { $0.submenu?.title == "View" }?.submenu)
        let attention = try XCTUnwrap(
            viewMenu.items.first { $0.identifier?.rawValue == "toggle-attention" })
        XCTAssertEqual(attention.keyEquivalent, "a")
        XCTAssertEqual(
            attention.keyEquivalentModifierMask, [.command, .option])
        XCTAssertEqual(
            attention.action,
            #selector(WorkspaceShellWindowController.performShellCommand(_:)))
    }
}

@MainActor
private final class TallLiveRunSurface: LiveRunTerminalSurface {
    let locator: AgentSessionLocator
    private(set) var installedView: NSView?

    init(locator: AgentSessionLocator) {
        self.locator = locator
    }

    func makeView() throws -> NSView {
        let view = TallLiveRunSurfaceView()
        installedView = view
        return view
    }

    func start() {}
    func detach() {}
}

private final class TallLiveRunSurfaceView: NSView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: 800, height: 900)
    }
}

private extension NSView {
    var allSubviews: [NSView] {
        subviews.flatMap { [$0] + $0.allSubviews }
    }
}
