import AppKit
import Foundation

/// AppKit host for a Ghostty-owned terminal. Ghostty owns the PTY and child.
public final class HiveTerminalView: NSView, NSTextInputClient {
    public private(set) var surfaceState: TerminalSurfaceState = .starting
    public private(set) var inputSubmissionState: InputSubmissionState = .idle
    public private(set) var lastTitle: String = ""
    public private(set) var lastPwd: String = ""

    private var engineStorage: ManualSurfaceEngine?
    var engine: ManualSurfaceEngine {
        guard let engineStorage else { preconditionFailure("terminal surface is not initialized") }
        return engineStorage
    }

    public var onUserClose: (() -> Void)?
    public var onStateChange: ((TerminalSurfaceState) -> Void)?
    public var onBell: (() -> Void)?
    public var onRendererHealthChange: ((RendererHealth) -> Void)?
    public var onUserInput: ((_ characters: String, _ command: Bool, _ control: Bool) -> Void)?

    public private(set) var focusStealAttempts = 0
    var testingAllowFocusSteal = false
    public private(set) var drawScheduledCount = 0
    public private(set) var reportedGeometry: TerminalGeometry?
    public private(set) var appliedContentScale = NSSize(width: 1, height: 1)
    public private(set) var appliedDrawableSize = NSSize.zero
    public private(set) var appliedDisplayID: UInt32?
    public private(set) var appliedOcclusionVisible: Bool?
    public private(set) var rendererHealthy = true
    public private(set) var sleepTransitionCount = 0
    public private(set) var wakeTransitionCount = 0
    private(set) var appliedColorScheme: TerminalColorScheme?

    private var viewerId: String
    private var renderHostView: NSView?
    private var windowObservers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var appearancePreferenceObserver: NSObjectProtocol?
    var appearancePreferences: HiveAppearancePreferences = .shared
    var searchOverlayStorage: TerminalSearchOverlay?
    var searchStateStorage = TerminalSearchState()
    var newOutputIndicatorStorage: NSButton?
    var scrollStateStorage = TerminalScrollState()
    private var pendingDraw = false
    private var pendingDisplay = false
    private var hasCompletedInitialDraw = false
    private var renderingSuspended = false
    private var closed = false
    private var appliedFramebufferSize: (width: UInt32, height: UInt32)?
    var markedText = NSMutableAttributedString()
    var keyTextAccumulator: [String]?
    var previousPressureStage = 0

    init(frame frameRect: NSRect, engine: ManualSurfaceEngine, viewerId: String = "viewer-local") {
        self.engineStorage = engine
        self.viewerId = viewerId
        super.init(frame: frameRect)
        wantsLayer = true
        registerForDraggedTypes(Array(Self.dropTypes))
        synchronizeColorScheme()
        wireBridgeEvents()
        wireAccessibilitySignals()
        wireWorkspaceEvents()
        setSurfaceState(.live)
    }

    /// Ghostty-owned PTY. The view is a host; Ghostty execs `launch.command`.
    public init(
        frame frameRect: NSRect,
        launch: TerminalLaunch,
        viewerId: String = "viewer-local"
    ) throws {
        self.viewerId = viewerId
        super.init(frame: frameRect)
        wantsLayer = true
        registerForDraggedTypes(Array(Self.dropTypes))

        let renderHost = NSView(frame: bounds)
        renderHost.autoresizingMask = [.width, .height]
        addSubview(renderHost)
        renderHostView = renderHost

        let backingSize = convertToBacking(bounds.size)
        let widthPx = UInt32(max(1, Int(backingSize.width)))
        let heightPx = UInt32(max(1, Int(backingSize.height)))
        engineStorage = try GhosttyBridgeFactory.makeOwnedSurface(
            hostView: renderHost,
            launch: launch,
            widthPx: widthPx,
            heightPx: heightPx
        )
        synchronizeColorScheme()
        wireBridgeEvents()
        wireAccessibilitySignals()
        wireWorkspaceEvents()
        synchronizeRenderingState()
        applySelectedAppearance()
        setSurfaceState(.live)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        accessibilitySurfaceWillClose()
        removeWindowObservers()
        removeWorkspaceObservers()
        if let appearancePreferenceObserver {
            NotificationCenter.default.removeObserver(appearancePreferenceObserver)
        }
        engineStorage?.free()
    }

    public var renderEvidence: HiveTerminalRenderEvidence {
        let layer = ghosttyRenderingLayer
        return HiveTerminalRenderEvidence(
            engine: .current,
            drawCount: drawScheduledCount,
            layerClass: layer.map { String(describing: type(of: $0)) },
            hasPresentedContents: layer?.contents != nil
        )
    }

    private func wireBridgeEvents() {
        engine.callbackContext.onEvent = { [weak self] event in
            guard let self else { return }
            if Thread.isMainThread {
                self.handleBridgeEvent(event)
            } else {
                DispatchQueue.main.async { self.handleBridgeEvent(event) }
            }
        }
        engine.callbackContext.onRendererHealth = { [weak self] health in
            self?.handleRendererHealth(health)
        }
        engine.callbackContext.onActionNotification = { [weak self] note in
            self?.handleTerminalActionNotification(note)
        }
    }

    private func handleBridgeEvent(_ event: BridgeEvent) {
        switch event.type {
        case .invalidate:
            scheduleDraw()
            accessibilitySemanticStateDidInvalidate()
        case .title:
            lastTitle = String(data: event.bytes, encoding: .utf8) ?? ""
        case .pwd:
            lastPwd = String(data: event.bytes, encoding: .utf8) ?? ""
        case .bell:
            onBell?()
            accessibilityAnnounce("Terminal bell", priority: .high)
        case .clipboardDenied:
            accessibilityAnnounce("Clipboard access denied", priority: .high)
        case .closeRequest:
            accessibilityAnnounce("Terminal closed", priority: .medium)
            userClose()
        }
    }

    private func scheduleDraw() {
        pendingDraw = true
        schedulePendingDrawIfPossible()
    }

    private func schedulePendingDrawIfPossible() {
        guard pendingDraw, canPresentGhosttyFrame else { return }
        needsDisplay = true
        guard !pendingDisplay else { return }
        pendingDisplay = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingDisplay = false
            guard self.pendingDraw, self.canPresentGhosttyFrame else { return }
            self.displayIfNeeded()
        }
    }

    private var canPresentGhosttyFrame: Bool {
        !closed && rendererHealthy && !renderingSuspended && bounds.width > 0 && bounds.height > 0 &&
            appliedOcclusionVisible != false
    }

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard pendingDraw, canPresentGhosttyFrame else { return }
        pendingDraw = false
        drawScheduledCount += 1
        engine.draw()
        if !hasCompletedInitialDraw {
            hasCompletedInitialDraw = true
            synchronizeOcclusion()
        }
    }

    private func handleRendererHealth(_ health: RendererHealth) {
        rendererHealthy = health == .healthy
        onRendererHealthChange?(health)
        if health == .healthy {
            synchronizeRenderingState()
            engine.refresh()
            schedulePendingDrawIfPossible()
        }
    }

    @discardableResult
    func applySelectedAppearance() -> Bool {
        engine.applyHiveConfiguration(
            theme: appearancePreferences.resolvedTheme(
                for: HiveTerminalAppearanceState(
                    effectiveAppearance,
                    increasedContrast: false
                )
            ),
            font: appearancePreferences.font
        )
    }

    public func applyStatusUpdate(evidence: String) {
        notifyOutputStatusReconnect(reason: "status:\(evidence)")
    }

    public func notifyOutputStatusReconnect(reason: String) {
        _ = reason
        if testingAllowFocusSteal {
            focusStealAttempts += 1
            window?.makeFirstResponder(self)
        }
    }

    private func wireWorkspaceEvents() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            center.addObserver(
                forName: NSWorkspace.willSleepNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.sleepTransitionCount += 1
                self.renderingSuspended = true
                if self.appliedOcclusionVisible != false {
                    self.engineStorage?.setOcclusion(false)
                    self.appliedOcclusionVisible = false
                }
            },
            center.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.wakeTransitionCount += 1
                self.renderingSuspended = false
                self.synchronizeRenderingState()
                self.engine.refresh()
                self.schedulePendingDrawIfPossible()
            },
        ]

        appearancePreferenceObserver = NotificationCenter.default.addObserver(
            forName: HiveAppearancePreferences.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.applySelectedAppearance()
        }
    }

    public override func viewWillMove(toWindow newWindow: NSWindow?) {
        removeWindowObservers()
        super.viewWillMove(toWindow: newWindow)
        guard let newWindow else { return }

        let center = NotificationCenter.default
        windowObservers = [
            center.addObserver(
                forName: NSWindow.didChangeScreenNotification,
                object: newWindow,
                queue: .main
            ) { [weak self] _ in
                self?.synchronizeRenderingState()
            },
            center.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification,
                object: newWindow,
                queue: .main
            ) { [weak self] _ in
                self?.synchronizeOcclusion()
            },
        ]
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        synchronizeRenderingState()
        accessibilityFocusDidChange()
    }

    public override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        synchronizeRenderingState()
    }

    public override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        synchronizeColorScheme()
        applySelectedAppearance()
    }

    var ghosttyRenderingLayer: CALayer? {
        renderHostView?.layer
    }

    private func synchronizeRenderingState() {
        let backingSize = currentBackingSize
        let fallbackScale = window?.backingScaleFactor ?? 1
        let xScale = bounds.width > 0 ? backingSize.width / bounds.width : fallbackScale
        let yScale = bounds.height > 0 ? backingSize.height / bounds.height : fallbackScale
        appliedContentScale = NSSize(width: xScale, height: yScale)
        appliedDrawableSize = backingSize

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ghosttyRenderingLayer?.contentsScale = fallbackScale
        CATransaction.commit()

        engineStorage?.setContentScale(x: xScale, y: yScale)
        synchronizeDisplayID()
        synchronizeOcclusion()
        synchronizeFramebufferSize()
    }

    private func synchronizeColorScheme() {
        guard let engineStorage else { return }
        let scheme = TerminalColorScheme(appearance: effectiveAppearance)
        guard appliedColorScheme != scheme else { return }
        engineStorage.setColorScheme(scheme)
        appliedColorScheme = scheme
    }

    private var currentBackingSize: NSSize {
        if let renderHostView {
            return renderHostView.convertToBacking(renderHostView.bounds.size)
        }
        return convertToBacking(bounds.size)
    }

    private func synchronizeDisplayID() {
        guard
            let screen = window?.screen,
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return }
        let displayID = number.uint32Value
        guard appliedDisplayID != displayID else { return }
        engineStorage?.setDisplayID(displayID)
        appliedDisplayID = displayID
    }

    private func synchronizeOcclusion() {
        guard let window else {
            if appliedOcclusionVisible != nil {
                engineStorage?.setOcclusion(false)
                appliedOcclusionVisible = false
            }
            return
        }
        let visible = window.occlusionState.contains(.visible) ||
            (!hasCompletedInitialDraw && window.isVisible && !window.isMiniaturized)
        guard appliedOcclusionVisible != visible else { return }
        engineStorage?.setOcclusion(visible)
        appliedOcclusionVisible = visible
        if visible { schedulePendingDrawIfPossible() }
    }

    private func removeWindowObservers() {
        let center = NotificationCenter.default
        windowObservers.forEach(center.removeObserver)
        windowObservers.removeAll()
    }

    private func removeWorkspaceObservers() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.forEach(center.removeObserver)
        workspaceObservers.removeAll()
    }

    public override func layout() {
        super.layout()
        synchronizeFramebufferSize()
    }

    public override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        synchronizeFramebufferSize()
    }

    private func synchronizeFramebufferSize() {
        let backingSize = currentBackingSize
        appliedDrawableSize = backingSize
        let width = max(0, Int(backingSize.width.rounded()))
        let height = max(0, Int(backingSize.height.rounded()))
        guard width > 0, height > 0 else {
            appliedFramebufferSize = nil
            reportedGeometry = nil
            return
        }

        let widthPx = UInt32(width)
        let heightPx = UInt32(height)
        if let appliedFramebufferSize,
           appliedFramebufferSize.width == widthPx,
           appliedFramebufferSize.height == heightPx {
            schedulePendingDrawIfPossible()
            return
        }
        appliedFramebufferSize = (widthPx, heightPx)
        engine.setSize(widthPx: widthPx, heightPx: heightPx)
        accessibilityGeometryDidChange()
        updateReportedGeometry()
        schedulePendingDrawIfPossible()
    }

    private func updateReportedGeometry() {
        guard let size = engine.reportedSize() else {
            reportedGeometry = nil
            return
        }
        guard
            size.columns > 0,
            size.rows > 0,
            size.widthPx > 0,
            size.heightPx > 0,
            size.cellWidthPx > 0,
            size.cellHeightPx > 0
        else {
            reportedGeometry = nil
            return
        }
        reportedGeometry = TerminalGeometry(
            columns: Int(size.columns),
            rows: Int(size.rows),
            widthPx: Int(size.widthPx),
            heightPx: Int(size.heightPx),
            cellWidthPx: Double(size.cellWidthPx),
            cellHeightPx: Double(size.cellHeightPx)
        )
    }

    public func userClose() {
        guard !closed else { return }
        closed = true
        dismissSearchUI(restoreTerminalFocus: false)
        dismissNewOutputIndicator()
        pendingDraw = false
        needsDisplay = false
        accessibilitySurfaceWillClose()
        onUserClose?()
        engine.free()
        if let renderHostView {
            renderHostView.layer = nil
            renderHostView.wantsLayer = false
        }
        setSurfaceState(.exited(evidence: "user-close"))
    }

    func setSurfaceState(_ newState: TerminalSurfaceState) {
        let changed = surfaceState != newState
        surfaceState = newState
        if changed {
            accessibilityLifecycleDidChange()
        }
        notifyOutputStatusReconnect(reason: "state")
        onStateChange?(newState)
    }
}
