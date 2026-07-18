import AppKit
import Foundation

/// L1 `HiveTerminalView` — one edge-to-edge NSView bound to exactly one
/// SessionLocator/generation (§26).
///
/// Focus: first responder only on direct click / explicit focus action.
/// Output/status/reconnect never steal focus.
///
/// Input (M8): native NSEvent → ghostty_surface_key/text/preedit/mouse →
/// claim-bound write callback (encoder out).
///
/// Render (M9): INVALIDATE schedules main-thread draw; CLOSE_REQUEST → terminate seam.
public final class HiveTerminalView: NSView, NSTextInputClient {
    public private(set) var surfaceState: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var sessionLocator: SessionLocator?
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var highWater: UInt64 = 0
    public private(set) var lastTitle: String = ""
    public private(set) var lastPwd: String = ""

    private var engineStorage: ManualSurfaceEngine?
    private var applicatorStorage: OutputRangeApplicator?
    var engine: ManualSurfaceEngine {
        guard let engineStorage else { preconditionFailure("terminal surface is not initialized") }
        return engineStorage
    }
    var applicator: OutputRangeApplicator {
        guard let applicatorStorage else { preconditionFailure("terminal applicator is not initialized") }
        return applicatorStorage
    }
    private(set) var attachClient: AttachReplayClient?

    public var onUserClose: (() -> Void)?
    public var onFirstCorrectFrame: ((UInt64) -> Void)?
    public var onStateChange: ((TerminalSurfaceState) -> Void)?
    public var onBell: (() -> Void)?
    public var onRendererHealthChange: ((RendererHealth) -> Void)?

    public private(set) var focusStealAttempts = 0
    public var testingAllowFocusSteal = false
    public private(set) var drawScheduledCount = 0
    public private(set) var resizeFramesSent = 0
    public private(set) var reportedGeometry: TerminalGeometry?
    public private(set) var appliedContentScale = NSSize(width: 1, height: 1)
    public private(set) var appliedDrawableSize = NSSize.zero
    public private(set) var appliedDisplayID: UInt32?
    public private(set) var appliedOcclusionVisible: Bool?
    public private(set) var rendererHealthy = true
    public private(set) var sleepTransitionCount = 0
    public private(set) var wakeTransitionCount = 0

    private var viewerId: String
    private var resizeWorkItem: DispatchWorkItem?
    private var drawWorkItem: DispatchWorkItem?
    private var renderHostView: NSView?
    private var windowObservers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var pendingDraw = false
    private var renderingSuspended = false
    private var closed = false
    private var appliedFramebufferSize: (width: UInt32, height: UInt32)?
    private let resizeQuiescence: TimeInterval = 0.100
    // internal (not private): HiveTerminalView+Input.swift (gate 8) reads/writes these.
    var markedText: NSAttributedString?
    var pendingAuthoringHeld = false

    init(frame frameRect: NSRect, engine: ManualSurfaceEngine, viewerId: String = "viewer-local") {
        self.engineStorage = engine
        self.viewerId = viewerId
        self.applicatorStorage = OutputRangeApplicator(engine: engine)
        super.init(frame: frameRect)
        wantsLayer = true
        wireBridgeEvents()
        wireWorkspaceEvents()
    }

    /// Creates the production view and binds Ghostty's renderer to an
    /// edge-to-edge AppKit host owned by this view.
    public init(frame frameRect: NSRect, viewerId: String = "viewer-local") throws {
        self.viewerId = viewerId
        super.init(frame: frameRect)
        wantsLayer = true

        let renderHost = NSView(frame: bounds)
        renderHost.autoresizingMask = [.width, .height]
        addSubview(renderHost)
        renderHostView = renderHost

        let backingSize = convertToBacking(bounds.size)
        let widthPx = UInt32(max(1, Int(backingSize.width)))
        let heightPx = UInt32(max(1, Int(backingSize.height)))
        let engine = try GhosttyBridgeFactory.makeManualSurface(
            hostView: renderHost,
            widthPx: widthPx,
            heightPx: heightPx
        )
        engineStorage = engine
        applicatorStorage = OutputRangeApplicator(engine: engine)
        wireBridgeEvents()
        wireWorkspaceEvents()
        synchronizeRenderingState()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        drawWorkItem?.cancel()
        resizeWorkItem?.cancel()
        removeWindowObservers()
        removeWorkspaceObservers()
        engineStorage?.free()
    }

    public var renderEvidence: HiveTerminalRenderEvidence {
        let layer = ghosttyRenderingLayer
        return HiveTerminalRenderEvidence(
            engine: .current,
            locator: sessionLocator,
            highWater: highWater,
            drawCount: drawScheduledCount,
            layerClass: layer.map { String(describing: type(of: $0)) },
            hasPresentedContents: layer?.contents != nil
        )
    }

    /// Wire §23 bridge events: INVALIDATE → render; CLOSE_REQUEST → terminate seam (M9).
    private func wireBridgeEvents() {
        engine.callbackContext.onEvent = { [weak self] event in
            guard let self else { return }
            // Main-thread confined (§23).
            if Thread.isMainThread {
                self.handleBridgeEvent(event)
            } else {
                DispatchQueue.main.async { self.handleBridgeEvent(event) }
            }
        }
        engine.callbackContext.onRendererHealth = { [weak self] health in
            self?.handleRendererHealth(health)
        }
    }

    private func handleBridgeEvent(_ event: BridgeEvent) {
        switch event.type {
        case .invalidate:
            scheduleDraw()
        case .title:
            lastTitle = String(data: event.bytes, encoding: .utf8) ?? ""
            notifyOutputStatusReconnect(reason: "title")
        case .pwd:
            lastPwd = String(data: event.bytes, encoding: .utf8) ?? ""
            notifyOutputStatusReconnect(reason: "pwd")
        case .bell:
            onBell?()
            notifyOutputStatusReconnect(reason: "bell")
        case .clipboardDenied:
            notifyOutputStatusReconnect(reason: "clipboard-denied")
        case .closeRequest:
            // §26: CLOSE_REQUEST → exact-generation TERMINATE seam, never DETACH.
            userClose()
        }
    }

    private func scheduleDraw() {
        pendingDraw = true
        schedulePendingDrawIfPossible()
    }

    private func schedulePendingDrawIfPossible() {
        guard pendingDraw, drawWorkItem == nil, canPresentGhosttyFrame else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.drawWorkItem = nil
            guard self.pendingDraw, self.canPresentGhosttyFrame else { return }
            self.pendingDraw = false
            self.drawScheduledCount += 1
            self.engine.draw()
        }
        drawWorkItem = work
        DispatchQueue.main.async(execute: work)
    }

    private var canPresentGhosttyFrame: Bool {
        !closed && rendererHealthy && !renderingSuspended && bounds.width > 0 && bounds.height > 0 &&
            appliedOcclusionVisible != false
    }

    /// AppKit may invoke this for view damage, but Ghostty has exactly one
    /// presentation entry: the coalesced INVALIDATE path above.
    public override func draw(_ dirtyRect: NSRect) {
        _ = dirtyRect
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

    // MARK: - Attach

    func makeAttachClient() -> AttachReplayClient {
        let client = AttachReplayClient(viewerId: viewerId, engine: engine)
        // Encoder-out write path → HUMAN_INPUT (client owns claim binding).
        engine.callbackContext.onWrite = { [weak client] bytes in
            client?.handleEncodedWrite(bytes)
        }
        // Event path stays on the view (INVALIDATE/CLOSE_REQUEST/…).
        engine.callbackContext.onEvent = { [weak self] event in
            self?.handleBridgeEventOnMain(event)
        }
        attachClient = client
        return client
    }

    private func handleBridgeEventOnMain(_ event: BridgeEvent) {
        if Thread.isMainThread {
            handleBridgeEvent(event)
        } else {
            DispatchQueue.main.async { [weak self] in self?.handleBridgeEvent(event) }
        }
    }

    @discardableResult
    public func attach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64 = 0,
        transport: HostTransport
    ) throws -> AttachReplayOutcome {
        try admitBinding(
            SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId),
            highWater: afterSeq
        )
        setSurfaceState(.attaching)
        let client = attachClient ?? makeAttachClient()
        let outcome = try client.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: afterSeq,
            transport: transport
        )
        highWater = client.highWater
        claimPresentation = client.claimPresentation
        switch outcome {
        case .firstCorrectFrame(let hw, _):
            highWater = hw
            setSurfaceState(.live)
            notifyOutputStatusReconnect(reason: "first-correct-frame")
            onFirstCorrectFrame?(hw)
            scheduleDraw()
        case .failed(let state):
            setSurfaceState(state)
        case .rejectedLateFrame, .continueReplay:
            break
        }
        return outcome
    }

    /// Binds this view to one exact locator. A reconnect may replace only the
    /// connection fence; a different locator or generation requires a new view.
    public func bind(to newBinding: SurfaceBinding, highWater: UInt64 = 0) throws {
        try admitBinding(newBinding, highWater: highWater)
        attachClient?.retarget(newBinding: newBinding, highWater: highWater)
        setSurfaceState(.attaching)
        notifyOutputStatusReconnect(reason: "binding-reconnect")
    }

    private func admitBinding(_ newBinding: SurfaceBinding, highWater: UInt64) throws {
        guard !closed else { throw HiveTerminalBindingError.closed }
        if let sessionLocator, sessionLocator != newBinding.locator {
            throw HiveTerminalBindingError.locatorChanged(
                expected: sessionLocator,
                attempted: newBinding.locator
            )
        }
        sessionLocator = newBinding.locator
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
    }

    public func applyOutput(
        bytes: Data,
        streamSeq: UInt64,
        frameBinding: SurfaceBinding
    ) -> OutputApplyResult {
        let result = applicator.apply(bytes: bytes, streamSeq: streamSeq, frameBinding: frameBinding)
        if case .applied(let hw) = result {
            highWater = hw
            notifyOutputStatusReconnect(reason: "output")
        }
        return result
    }

    public func applyStatusUpdate(evidence: String) {
        notifyOutputStatusReconnect(reason: "status:\(evidence)")
    }

    // MARK: - First responder / input (M8, gate 8): see HiveTerminalView+Input.swift

    public func notifyOutputStatusReconnect(reason: String) {
        _ = reason
        if testingAllowFocusSteal {
            focusStealAttempts += 1
            window?.makeFirstResponder(self)
            return
        }
    }

    // MARK: - AppKit renderer lifecycle

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
    }

    public override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        synchronizeRenderingState()
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
        let visible = window.occlusionState.contains(.visible)
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

    // MARK: - Geometry / RESIZE (M10)

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
            resizeWorkItem?.cancel()
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
        resizeWorkItem?.cancel()
        appliedFramebufferSize = (widthPx, heightPx)
        engine.setSize(widthPx: widthPx, heightPx: heightPx)
        updateReportedGeometry()
        schedulePendingDrawIfPossible()
    }

    private func scheduleResizeFrame(_ geometry: TerminalGeometry) {
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.bounds.width > 0, self.bounds.height > 0,
                  self.binding != nil, let client = self.attachClient else { return }
            guard (try? client.sendResize(geometry)) != nil else { return }
            self.resizeFramesSent += 1
        }
        resizeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + resizeQuiescence, execute: work)
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
        let geometry = TerminalGeometry(
            columns: Int(size.columns),
            rows: Int(size.rows),
            widthPx: Int(size.widthPx),
            heightPx: Int(size.heightPx),
            cellWidthPx: Double(size.cellWidthPx),
            cellHeightPx: Double(size.cellHeightPx)
        )
        reportedGeometry = geometry
        if binding != nil { scheduleResizeFrame(geometry) }
    }

    // MARK: - Close

    public func userClose() {
        guard !closed else { return }
        closed = true
        pendingDraw = false
        drawWorkItem?.cancel()
        resizeWorkItem?.cancel()
        onUserClose?()
        engine.free()
        if let renderHostView {
            renderHostView.layer = nil
            renderHostView.wantsLayer = false
        }
        binding = nil
        applicator.clearBinding()
        setSurfaceState(.exited(evidence: "user-close"))
    }

    // MARK: - State

    private func setSurfaceState(_ newState: TerminalSurfaceState) {
        surfaceState = newState
        notifyOutputStatusReconnect(reason: "state")
        onStateChange?(newState)
    }

}
