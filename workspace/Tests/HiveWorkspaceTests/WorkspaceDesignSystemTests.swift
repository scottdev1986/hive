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
        assertRGB(Theme.Chrome.muted, hex: 0x99B0BC)
        assertRGB(Theme.Chrome.faint, hex: 0x7593A2)
        assertRGB(Theme.Chrome.dashedStroke, hex: 0x566C77)
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


    // MARK: - Contrast

    /// Every surface a screen can put text on. A token only passes if it clears
    /// AA against the lightest of them in dark mode and the darkest in light
    /// mode, because one token serves all five.
    private static let textSurfaces: [(String, NSColor)] = [
        ("workspaceBackground", Theme.workspaceBackground),
        ("sidebarFill", Theme.sidebarFill),
        ("sidebarContextFill", Theme.sidebarContextFill),
        ("cardFill", Theme.cardFill),
        ("insetFill", Theme.insetFill),
    ]

    private static let appearances: [(String, NSAppearance)] = [
        ("dark", NSAppearance(named: .darkAqua)!),
        ("light", NSAppearance(named: .aqua)!),
    ]

    /// WCAG 2.1 relative luminance, then the 1.4.3 ratio.
    private func contrast(
        _ ink: NSColor, on ground: NSColor, in appearance: NSAppearance
    ) -> Double {
        func luminance(_ color: NSColor) -> Double {
            var resolved = color
            appearance.performAsCurrentDrawingAppearance {
                resolved = color.usingColorSpace(.sRGB) ?? color
            }
            func channel(_ raw: CGFloat) -> Double {
                let value = Double(raw)
                return value <= 0.04045
                    ? value / 12.92
                    : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(resolved.redComponent)
                + 0.7152 * channel(resolved.greenComponent)
                + 0.0722 * channel(resolved.blueComponent)
        }
        let a = luminance(ink), b = luminance(ground)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// The meta line, the panel subtitle and the meter's freshness caption all
    /// read from this ramp. Each one states whether the number above it can be
    /// trusted, so each one is content and owes AA on every ground it lands on.
    func testTheTextRampClearsAAOnEverySurfaceInBothAppearances() {
        let inks: [(String, NSColor)] = [
            ("primaryText", Theme.primaryText),
            ("secondaryText", Theme.secondaryText),
            ("tertiaryText", Theme.tertiaryText),
        ]
        for (mode, appearance) in Self.appearances {
            for (inkName, ink) in inks {
                for (groundName, ground) in Self.textSurfaces {
                    let ratio = contrast(ink, on: ground, in: appearance)
                    XCTAssertGreaterThanOrEqual(
                        ratio, 4.5,
                        "\(mode) \(inkName) on \(groundName) is \(ratio), below AA")
                }
            }
        }
    }

    /// Raising the dim end of the ramp is only correct if the ramp still has
    /// three steps. Equal-contrast text would pass the check above and still
    /// destroy the distinction between a value and its provenance.
    func testTheTextRampKeepsThreeDistinctLevels() {
        for (mode, appearance) in Self.appearances {
            for (groundName, ground) in Self.textSurfaces {
                let primary = contrast(Theme.primaryText, on: ground, in: appearance)
                let secondary = contrast(Theme.secondaryText, on: ground, in: appearance)
                let tertiary = contrast(Theme.tertiaryText, on: ground, in: appearance)
                let where_ = "\(mode) on \(groundName)"
                XCTAssertGreaterThan(
                    primary / secondary, 1.25,
                    "\(where_): primary and secondary have collapsed together")
                XCTAssertGreaterThan(
                    secondary / tertiary, 1.25,
                    "\(where_): secondary and meta text have collapsed together")
            }
        }
    }

    /// A dashed edge is a boundary, not a word: it answers to the 3:1 non-text
    /// threshold and must stay below the text ramp, or an unavailable card
    /// draws a louder border than an available one.
    func testTheDashedStrokeIsABoundaryAndStaysBelowTheTextRamp() {
        for (mode, appearance) in Self.appearances {
            let stroke = contrast(Theme.subtleStroke, on: Theme.cardFill, in: appearance)
            let tertiary = contrast(Theme.tertiaryText, on: Theme.cardFill, in: appearance)
            XCTAssertGreaterThanOrEqual(
                stroke, 3.0, "\(mode): a boundary below 3:1 is not visible")
            XCTAssertLessThan(
                stroke, tertiary,
                "\(mode): the dashed edge has reached text brightness")
        }
    }

    /// Token arithmetic cannot see this one. The label is drawn by AppKit from
    /// `contentTintColor`, so a bezel or tint change can strip the ink while
    /// every token still reads correct — this renders the real control and
    /// measures the pixels. Only the enabled button is asserted: WCAG 1.4.3
    /// exempts inactive components, and a disabled primary is *meant* to
    /// recede.
    func testThePrimaryActionLabelClearsAAAgainstItsOwnFill() throws {
        _ = NSApplication.shared
        for (mode, appearance) in Self.appearances {
            let button = ActionButton(title: "Apply route", style: .primary)
            button.isEnabled = true
            let host = NSView(frame: NSRect(x: 0, y: 0, width: 120, height: 30))
            host.appearance = appearance
            host.addSubview(button)
            button.frame = host.bounds
            host.layoutSubtreeIfNeeded()

            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            appearance.performAsCurrentDrawingAppearance {
                host.cacheDisplay(in: host.bounds, to: rep)
            }

            // Only fully opaque pixels are the control. Everything outside the
            // rounded rect is transparent and reports as black, which would
            // otherwise win both "most common" and "darkest".
            var tally: [[Int]: Int] = [:]
            for y in 0..<rep.pixelsHigh {
                for x in 0..<rep.pixelsWide {
                    guard let raw = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
                          raw.alphaComponent > 0.9
                    else { continue }
                    tally[[
                        Int((raw.redComponent * 255).rounded()),
                        Int((raw.greenComponent * 255).rounded()),
                        Int((raw.blueComponent * 255).rounded()),
                    ], default: 0] += 1
                }
            }
            // The fill is whatever covers most of the control; the ink is the
            // pixel furthest from it. Which of the two is darker flips between
            // appearances, so the label is found by distance, not by lightness.
            func color(_ c: [Int]) -> NSColor {
                NSColor(
                    srgbRed: CGFloat(c[0]) / 255, green: CGFloat(c[1]) / 255,
                    blue: CGFloat(c[2]) / 255, alpha: 1)
            }
            let fill = try XCTUnwrap(tally.max { $0.value < $1.value }?.key)
            let ink = try XCTUnwrap(tally.keys.max {
                contrast(color($0), on: color(fill), in: appearance)
                    < contrast(color($1), on: color(fill), in: appearance)
            })
            XCTAssertNotEqual(
                ink, fill, "positive control: \(mode) found no label pixels at all")

            let ratio = contrast(color(ink), on: color(fill), in: appearance)
            XCTAssertGreaterThanOrEqual(
                ratio, 4.5,
                "\(mode): enabled primary action label is \(ratio) on its fill")
        }
    }

    /// Proves the measurement can report a failure. Without it a broken
    /// luminance function would make every assertion above pass silently.
    func testTheContrastMeasurementReportsAKnownFailure() {
        let dark = NSAppearance(named: .darkAqua)!
        // The ink this ramp's meta text used to carry, on the lightest card ground.
        let retired = Theme.Chrome.color(0x536873)
        XCTAssertLessThan(
            contrast(retired, on: Theme.insetFill, in: dark), 4.5,
            "positive control: the check no longer detects a sub-AA pair")
        XCTAssertEqual(
            contrast(.white, on: .black, in: dark), 21, accuracy: 0.05,
            "positive control: black on white is the 21:1 anchor")
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
