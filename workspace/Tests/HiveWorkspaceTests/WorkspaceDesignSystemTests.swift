import AppKit
import XCTest

@testable import HiveWorkspace
import WorkspaceCore

final class WorkspaceDesignSystemTests: XCTestCase {

    func testFoundationPrimitivesExposeOneComposableScreenContract() throws {
        let action = NSButton(title: "Refresh", target: nil, action: nil)
        let header = PageHeaderView(
            title: "Models & Quota",
            subtitle: "Measured capacity evidence.",
            actions: [action])
        let card = SectionCardView(title: "Claude")
        let row = DataTableRowView(columns: [
            NSTextField(labelWithString: "Model"),
            NSTextField(labelWithString: "claude-opus"),
        ])
        let meter = MeterBarView()
        meter.state = .fill(fraction: 0.5, color: Theme.accent)
        card.contentStack.addArrangedSubview(row)
        card.contentStack.addArrangedSubview(meter)

        XCTAssertEqual(header.accessibilityIdentifier(), "hds-page-header")
        XCTAssertEqual(card.accessibilityIdentifier(), "hds-section-card")
        XCTAssertEqual(row.accessibilityIdentifier(), "hds-data-row")
        XCTAssertEqual(meter.accessibilityIdentifier(), "hds-meter-bar")
    }

    func testSplitHorizonTokensUseTheExactChromePaletteAndNativeScale() throws {
        assertRGB(Theme.Chrome.bg, hex: 0x091117)
        assertRGB(Theme.Chrome.top, hex: 0x111A20)
        assertRGB(Theme.Chrome.sidebar, hex: 0x0E171C)
        assertRGB(Theme.Chrome.panel, hex: 0x101B22)
        assertRGB(Theme.Chrome.panel2, hex: 0x172630)
        assertRGB(Theme.Chrome.line, hex: 0x263A45)
        assertRGB(Theme.Chrome.text, hex: 0xEDF4F7)
        assertRGB(Theme.Chrome.muted, hex: 0x8599A4)
        assertRGB(Theme.Chrome.faint, hex: 0x536873)
        assertRGB(Theme.Chrome.accent, hex: 0x73D8E8)
        assertRGB(Theme.Chrome.green, hex: 0x69D49F)
        assertRGB(Theme.Chrome.yellow, hex: 0xEFB161)
        assertRGB(Theme.Chrome.red, hex: 0xEC7770)
        assertRGB(Theme.Chrome.violet, hex: 0xC1A0DD)

        XCTAssertEqual(Theme.Metric.sidebarWidth, 188)
        XCTAssertEqual(Theme.Metric.topBarHeight, 59)
        XCTAssertEqual(Theme.Metric.controlMinHeight, 28)
        XCTAssertEqual(Theme.Font.chromeNav.pointSize, 8)
        XCTAssertEqual(Theme.Font.chromeGroup.pointSize, 6)
        XCTAssertEqual(Theme.Font.screenSubtitle.pointSize, 8)
        XCTAssertEqual(Theme.Font.sectionTitle.pointSize, 12)
        XCTAssertEqual(Theme.Font.badge.pointSize, 7)
    }

    func testActionButtonAndBannerExposeTheTwoChromeLevels() throws {
        let button = ActionButton(title: "Refresh")
        XCTAssertEqual(button.accessibilityIdentifier(), "hds-action-button")
        XCTAssertTrue(button.constraints.contains {
            $0.firstAttribute == .height
                && $0.relation == .greaterThanOrEqual
                && $0.constant == Theme.Metric.controlMinHeight
        })

        let banner = ShellBanner(severity: .warning, text: "Projection is stale.")
        let global = ShellBannerView(banner: banner, presentation: .global)
        let inline = ShellBannerView(banner: banner, presentation: .inline)
        XCTAssertEqual(global.accessibilityIdentifier(), "shell-banner-global")
        XCTAssertEqual(inline.accessibilityIdentifier(), "shell-banner-inline")
    }

    func testLiveRunSupportSurfacesUseSharedControlsAndCards() throws {
        let inspector = ShellInspectorView(
            projection: nil,
            tab: .task,
            onSelectTab: { _ in },
            onClose: {})
        XCTAssertTrue(findView(
            in: inspector, identifier: "shell-inspector-close") is ActionButton)

        var queue = AttentionQueue()
        queue.raise(AttentionItem(
            id: "attention-1",
            projectID: "project",
            paneID: "pane",
            severity: .waiting,
            title: "Input needed",
            detail: "Typed decision required",
            raisedAt: 1))
        let drawer = ShellAttentionDrawerView(queue: queue, onClose: {})
        XCTAssertTrue(findView(
            in: drawer, identifier: "shell-attention-close") is ActionButton)
        XCTAssertTrue(findView(
            in: drawer, identifier: "shell-attention-row") is CardView)
    }

    /// The capsule token is far larger than any badge is tall. Left unclamped on
    /// a continuous corner curve it describes no shape, and the badge then draws
    /// neither its fill nor its words while still laying out at its full size —
    /// an invisible state, which is exactly what a badge exists to prevent.
    func testACapsuleBadgeKeepsARadiusItsOwnBoxCanDraw() throws {
        let badge = CapsuleBadge(
            text: "stale reading", symbol: "clock.fill", style: .warning)
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 60))
        host.addSubview(badge)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            badge.topAnchor.constraint(equalTo: host.topAnchor),
        ])
        host.layoutSubtreeIfNeeded()

        let radius = try XCTUnwrap(badge.layer?.cornerRadius)
        XCTAssertGreaterThan(badge.bounds.height, 0, "positive control: the badge has a box")
        XCTAssertGreaterThan(radius, 0, "a squared-off badge is not a capsule")
        XCTAssertLessThanOrEqual(
            radius,
            badge.bounds.height / 2,
            "a radius past half the height degenerates and the badge disappears")
    }

    func testAVerticalDividerDoesNotHugItsHairlineHeight() {
        let hairline = NSBox.hdsSeparator()
        let divider = NSBox.hdsVerticalDivider()
        XCTAssertEqual(
            hairline.contentHuggingPriority(for: .vertical),
            .required,
            "a horizontal hairline must refuse extra height")
        XCTAssertLessThan(
            divider.contentHuggingPriority(for: .vertical).rawValue,
            NSLayoutConstraint.Priority.windowSizeStayPut.rawValue,
            "a vertical divider must not unique-ify the window height")
        XCTAssertTrue(
            divider.constraints.contains {
                $0.firstAttribute == .width && $0.constant == 1
            },
            "a vertical divider is one point wide")
    }

    func testShellChromeUsesCompactSidebarAndNamedTopBarControls() throws {
        _ = NSApplication.shared
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · fixture"),
            state: ShellState())
        let window = try XCTUnwrap(controller.window)
        window.setContentSize(NSSize(width: 1_100, height: 720))
        window.contentView?.layoutSubtreeIfNeeded()
        let content = try XCTUnwrap(window.contentView)

        let topBar = try XCTUnwrap(findView(in: content, identifier: "shell-top-bar"))
        let sidebar = try XCTUnwrap(findView(in: content, identifier: "shell-sidebar"))
        XCTAssertEqual(topBar.frame.height, Theme.Metric.topBarHeight, accuracy: 1)
        XCTAssertEqual(sidebar.frame.width, Theme.Metric.sidebarWidth, accuracy: 1)
        for identifier in [
            "shell-queen-status",
            "shell-attention-status",
            "shell-settings",
        ] {
            XCTAssertNotNil(findView(in: topBar, identifier: identifier), identifier)
        }
        let attention = try XCTUnwrap(findView(
            in: topBar, identifier: "shell-attention-status") as? NSButton)
        XCTAssertFalse(controller.currentState.attentionDrawerVisible)
        attention.performClick(nil)
        XCTAssertTrue(controller.currentState.attentionDrawerVisible)
    }

    func testGlobalBannerSpansTheShellBelowTheTopBar() throws {
        _ = NSApplication.shared
        let state = ShellState(lastOutcome: .surfaceUnavailable(
            .showLiveRun,
            reason: "Projection is stale."))
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · fixture"),
            state: state)
        let window = try XCTUnwrap(controller.window)
        window.setContentSize(NSSize(width: 1_100, height: 720))
        window.contentView?.layoutSubtreeIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let topBar = try XCTUnwrap(findView(in: content, identifier: "shell-top-bar"))
        let banner = try XCTUnwrap(findView(in: content, identifier: "shell-banner-global"))
        let topBarFrame = topBar.convert(topBar.bounds, to: content)
        let bannerFrame = banner.convert(banner.bounds, to: content)

        XCTAssertEqual(bannerFrame.width, content.bounds.width, accuracy: 1)
        XCTAssertEqual(bannerFrame.minX, content.bounds.minX, accuracy: 1)
        XCTAssertEqual(bannerFrame.maxY, topBarFrame.minY, accuracy: 1)
    }

    private func findView(in view: NSView, identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews {
            if let found = findView(in: child, identifier: identifier) { return found }
        }
        return nil
    }

    private func assertRGB(
        _ color: NSColor,
        hex: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let rgb = color.usingColorSpace(.sRGB) else {
            return XCTFail("Color does not resolve in sRGB", file: file, line: line)
        }
        XCTAssertEqual(Int((rgb.redComponent * 255).rounded()), (hex >> 16) & 0xFF,
                       file: file, line: line)
        XCTAssertEqual(Int((rgb.greenComponent * 255).rounded()), (hex >> 8) & 0xFF,
                       file: file, line: line)
        XCTAssertEqual(Int((rgb.blueComponent * 255).rounded()), hex & 0xFF,
                       file: file, line: line)
    }
}
