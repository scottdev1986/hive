import AppKit
import XCTest
import WorkspaceCore
@testable import HiveWorkspace

/// C1.3 — pane chrome, padding, and the focus affordance.
///
/// Two hazards are *demonstrated* here rather than asserted:
///
///  1. **Overlay vs. sublayer.** Repo law says AppKit paints a view's own layer
///     and its sublayers beneath the layers of that view's subviews, so a dim
///     added as a `CALayer` sublayer under an opaque background subview is
///     absent, not subtle. `testSublayerDimIsAbsentWhileSiblingOverlayDimIsVisible`
///     builds both constructions and shows the sublayer one failing.
///  2. **Vibrancy inheritance.** The terminal surface must not descend from a
///     vibrancy-enabled view. `testTerminalContentHasNoVibrancyEnabledAncestor`
///     walks the real pane's ancestor chain.
///
/// Both are offscreen and need no window server, so they hold under a locked
/// GUI session.
final class C13PaneChromeTests: XCTestCase {

    // MARK: - The offscreen instrument

    /// Renders a view tree offscreen and returns the color at its center.
    ///
    /// `cacheDisplay(in:to:)` draws through the view hierarchy the same way the
    /// window server composites it, including layer-backed subviews, so paint
    /// order is preserved. The instrument is only trustworthy if it can be
    /// shown to resolve a dim at all, which is what the controls below do.
    private func centerColor(of view: NSView) throws -> NSColor {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            throw XCTSkip("no bitmap representation available for offscreen capture")
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        let x = Int(view.bounds.midX)
        let y = Int(view.bounds.midY)
        guard let color = rep.colorAt(x: x, y: y) else {
            throw XCTSkip("offscreen capture produced no pixel at (\(x), \(y))")
        }
        return color
    }

    /// Perceived lightness of the sampled pixel, in the device gray space.
    /// A dim over white lowers it; that is the whole signal.
    private func luminance(_ color: NSColor) throws -> CGFloat {
        guard let gray = color.usingColorSpace(.deviceGray) else {
            throw XCTSkip("sampled color would not convert to device gray")
        }
        return gray.whiteComponent
    }

    /// A white opaque background view, exactly the situation the hazard needs:
    /// something opaque covering the bounds, drawn as a *subview*.
    private final class OpaqueWhiteView: NSView {
        override var isOpaque: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.white.setFill()
            dirtyRect.fill()
        }
    }

    /// A black 50% overlay drawn as a view.
    private final class DimOverlayView: NSView {
        override var isOpaque: Bool { false }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.black.withAlphaComponent(0.5).setFill()
            dirtyRect.fill()
        }
    }

    private static let bounds = NSRect(x: 0, y: 0, width: 80, height: 80)

    /// Root + opaque white background subview. The shared base of all three
    /// constructions; only the dim attachment differs.
    private func makeRootWithOpaqueBackground() -> NSView {
        let root = NSView(frame: Self.bounds)
        root.wantsLayer = true
        let background = OpaqueWhiteView(frame: Self.bounds)
        background.wantsLayer = true
        root.addSubview(background)
        return root
    }

    // MARK: - 1. The overlay-vs-sublayer hazard, demonstrated

    func testSublayerDimIsAbsentWhileSiblingOverlayDimIsVisible() throws {
        // NEGATIVE CONTROL — no dim at all. Establishes the undimmed reading.
        let undimmedRoot = makeRootWithOpaqueBackground()
        let undimmed = try luminance(try centerColor(of: undimmedRoot))

        // POSITIVE CONTROL — the sanctioned construction: a sibling overlay
        // view added last. If the instrument cannot see THIS dim, it cannot
        // see any dim, and the sublayer result below would be meaningless.
        let overlayRoot = makeRootWithOpaqueBackground()
        let overlay = DimOverlayView(frame: Self.bounds)
        overlayRoot.addSubview(overlay)
        let overlayDimmed = try luminance(try centerColor(of: overlayRoot))

        // THE HAZARD — identical dim, attached as a CALayer sublayer of the
        // root's own layer while the opaque background subview covers bounds.
        let sublayerRoot = makeRootWithOpaqueBackground()
        let dimLayer = CALayer()
        dimLayer.frame = Self.bounds
        dimLayer.backgroundColor = NSColor.black.withAlphaComponent(0.5).cgColor
        sublayerRoot.layer?.addSublayer(dimLayer)
        let sublayerDimmed = try luminance(try centerColor(of: sublayerRoot))

        print("C13_LUMINANCE undimmed=\(undimmed) overlay=\(overlayDimmed) sublayer=\(sublayerDimmed)")

        // INSTRUMENT PIN — the negative control must read as the white it was
        // told to draw. A renderer that returned a constant (all-white, all-
        // black, all-clear) would otherwise make the sublayer assertion below
        // pass for entirely the wrong reason.
        XCTAssertEqual(
            undimmed, 1.0, accuracy: 0.01,
            """
            INSTRUMENT FAILURE, not a finding. The undimmed control read \
            \(undimmed) instead of white (1.0), so the offscreen capture is \
            not rendering what it was given and no reading here is meaningful.
            """)

        // The instrument resolves a real dim: the positive control is
        // materially darker than the negative control.
        XCTAssertLessThan(
            overlayDimmed, undimmed - 0.1,
            """
            INSTRUMENT FAILURE, not a finding. The sibling-overlay positive \
            control did not read as dimmed (overlay=\(overlayDimmed) vs \
            undimmed=\(undimmed)), so this test cannot resolve a dim at all \
            and the sublayer reading below proves nothing. Fix the capture \
            before interpreting any result here.
            """)

        // The hazard: the sublayer dim is ABSENT — indistinguishable from
        // having added no dim whatsoever.
        XCTAssertEqual(
            sublayerDimmed, undimmed, accuracy: 0.01,
            """
            The sublayer dim was expected to be absent (repo law: AppKit paints \
            a view's sublayers beneath its subviews' layers). It instead read \
            as \(sublayerDimmed) against an undimmed \(undimmed). If this now \
            passes as visible, the hazard's premise changed and the overlay \
            requirement in PaneAttenuationView/PaneFocusRingView should be \
            re-derived rather than trusted.
            """)

        // And stated as the comparison that matters: same dim, two attachment
        // points, only one of which ever reaches the screen.
        XCTAssertGreaterThan(
            sublayerDimmed, overlayDimmed + 0.1,
            "The sublayer construction must be demonstrably lighter (less dim) than the overlay construction.")
    }

    // MARK: - 2. No vibrancy-enabled ancestor over terminal content

    /// Every ancestor of `view`, nearest first, excluding `view` itself.
    private func ancestors(of view: NSView) -> [NSView] {
        var chain: [NSView] = []
        var next = view.superview
        while let current = next {
            chain.append(current)
            next = current.superview
        }
        return chain
    }

    /// The check itself: nothing in the chain may be an `NSVisualEffectView`,
    /// and nothing may advertise vibrancy. Returns the offenders so a failure
    /// names them instead of just reporting a count.
    private func vibrancyOffenders(above view: NSView) -> [String] {
        ancestors(of: view).compactMap { ancestor in
            if ancestor is NSVisualEffectView {
                return "\(type(of: ancestor)) (NSVisualEffectView)"
            }
            if ancestor.allowsVibrancy {
                return "\(type(of: ancestor)) (allowsVibrancy == true)"
            }
            return nil
        }
    }

    private func makePane() -> PaneView {
        PaneView(paneID: PaneID("c13-chrome-probe"), title: "c13", dispatch: { _ in })
    }

    func testTerminalContentHasNoVibrancyEnabledAncestor() {
        let pane = makePane()
        pane.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
        pane.layoutSubtreeIfNeeded()

        let offenders = vibrancyOffenders(above: pane.contentView)
        XCTAssertTrue(
            offenders.isEmpty,
            """
            Terminal content descends from a vibrancy-enabled view: \
            \(offenders.joined(separator: ", ")). Vibrancy is inherited by \
            subviews and cannot be switched off by them, so this applies it to \
            arbitrary full-color terminal output.
            """)
    }

    /// Positive control for the check above. Planting an `NSVisualEffectView`
    /// into the chain must make `vibrancyOffenders` report it — otherwise an
    /// empty result in the real test would mean "the walk is broken", not
    /// "the chain is clean".
    func testVibrancyCheckDetectsAPlantedVisualEffectView() {
        let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        effect.material = .contentBackground
        let child = NSView(frame: effect.bounds)
        effect.addSubview(child)
        let grandchild = NSView(frame: effect.bounds)
        child.addSubview(grandchild)

        let offenders = vibrancyOffenders(above: grandchild)
        XCTAssertFalse(
            offenders.isEmpty,
            "The vibrancy walk failed to see an NSVisualEffectView placed directly in the ancestor chain.")
        XCTAssertTrue(
            offenders.contains { $0.contains("NSVisualEffectView") },
            "Expected the planted NSVisualEffectView to be named among \(offenders).")
    }

    /// The pane background must be opaque: it is what the terminal descends
    /// from, and a transparent one would let desktop content through.
    func testPaneBackgroundIsOpaqueAndNotAVisualEffectView() {
        let pane = makePane()
        pane.layoutSubtreeIfNeeded()

        let background = ancestors(of: pane.contentView).first
        XCTAssertNotNil(background, "contentView has no superview to check")
        XCTAssertFalse(
            background is NSVisualEffectView,
            "The pane background is an NSVisualEffectView again.")
        XCTAssertTrue(
            background?.isOpaque == true,
            "The pane background must be opaque.")
    }

    // MARK: - 3. Behavioral fallout from dropping NSVisualEffectView

    /// An `NSVisualEffectView` does not only look like something — its material
    /// re-resolves automatically across light and dark. Pane chrome may have
    /// been riding that automatic appearance behavior rather than owning it.
    /// The replacement must therefore be shown to still repaint across an
    /// appearance switch; a plain view filled with a hardcoded color would look
    /// right in one mode and be silently wrong in the other.
    func testPaneBackgroundStillRespondsToAppearanceAfterDroppingVibrancy() throws {
        func backgroundLuminance(under appearance: NSAppearance.Name) throws -> CGFloat {
            let background = PaneBackgroundView(frame: Self.bounds)
            background.appearance = NSAppearance(named: appearance)
            return try luminance(try centerColor(of: background))
        }

        let light = try backgroundLuminance(under: .aqua)
        let dark = try backgroundLuminance(under: .darkAqua)
        print("C13_APPEARANCE light=\(light) dark=\(dark)")

        XCTAssertGreaterThan(
            light, dark + 0.2,
            """
            The pane background did not change across the appearance switch \
            (light=\(light), dark=\(dark)). Dropping NSVisualEffectView lost \
            the automatic material response and nothing replaced it, so the \
            background is now painted the same in both modes.
            """)
    }

    /// The same guarantee stated structurally: the fill must come from a
    /// semantic color that re-resolves, which is what makes the test above
    /// pass for the right reason.
    // NOTE: there is deliberately no test that the background schedules its own
    // redraw on an appearance change. One was written, and the mutation case
    // `stop-repainting-on-appearance-change` showed it stayed GREEN when the
    // override it appeared to guard was neutered: AppKit's own
    // `viewDidChangeEffectiveAppearance` already invalidates the view, so the
    // override was dead code. Both the override and the test were removed
    // rather than shipped as decoration. The property that actually matters —
    // the fill re-resolving across light and dark — is covered above and is
    // mutation-proven by `hardcode-the-background-color`.

    // MARK: - 4. Focus by attenuation

    func testUnfocusedPaneIsAttenuatedAndFocusedPaneIsNot() {
        let view = PaneAttenuationView()

        view.indicator = .none
        XCTAssertTrue(view.isAttenuated, "An unfocused pane must be dimmed.")

        view.indicator = .active
        XCTAssertFalse(view.isAttenuated, "The focused pane must render normally.")

        // `.inactive` still IS the focused pane — the window merely is not key.
        view.indicator = .inactive
        XCTAssertFalse(
            view.isAttenuated,
            "A focused pane in a non-key window must not be dimmed; that would claim focus had moved.")
    }

    func testAttenuationPassesClicksThroughToTheTerminal() {
        let view = PaneAttenuationView(frame: NSRect(x: 0, y: 0, width: 50, height: 50))
        XCTAssertNil(
            view.hitTest(NSPoint(x: 25, y: 25)),
            "The attenuation overlay must never take a click from the terminal below it.")
    }

    /// Attenuation sits above the pane background but below the status border
    /// and focus ring: status is a correctness signal and stays legible.
    func testAttenuationIsBelowStatusAndFocusChrome() {
        let pane = makePane()
        pane.layoutSubtreeIfNeeded()

        let subviews = pane.subviews
        func index(ofType type: AnyClass) -> Int? {
            subviews.firstIndex { $0.isKind(of: type) }
        }

        guard let attenuationIndex = index(ofType: PaneAttenuationView.self),
              let statusIndex = index(ofType: PaneStatusBorderView.self),
              let focusIndex = index(ofType: PaneFocusRingView.self),
              let backgroundIndex = index(ofType: PaneBackgroundView.self) else {
            return XCTFail("pane is missing one of background/attenuation/status/focus: \(subviews)")
        }

        XCTAssertLessThan(backgroundIndex, attenuationIndex, "Attenuation must be above the pane background.")
        XCTAssertLessThan(attenuationIndex, statusIndex, "Status must stay above attenuation.")
        XCTAssertLessThan(attenuationIndex, focusIndex, "The focus ring must stay above attenuation.")
    }

    /// The attenuation overlay is a sibling view, never a sublayer — the
    /// hazard demonstrated in test 1 is what forbids the alternative.
    func testPaneChromeAddsNoSublayers() {
        let pane = makePane()
        pane.layoutSubtreeIfNeeded()

        for chrome in pane.subviews where chrome is PaneAttenuationView || chrome is PaneFocusRingView {
            XCTAssertTrue(
                chrome.layer?.sublayers?.isEmpty ?? true,
                "\(type(of: chrome)) attached a sublayer; chrome must draw itself, not stack layers.")
        }
    }
}
