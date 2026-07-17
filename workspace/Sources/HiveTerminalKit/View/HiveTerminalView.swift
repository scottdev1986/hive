import AppKit
import Foundation
import HiveGhosttyC

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
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var highWater: UInt64 = 0
    public private(set) var lastTitle: String = ""
    public private(set) var lastPwd: String = ""

    private var engineStorage: ManualSurfaceEngine?
    private var applicatorStorage: OutputRangeApplicator?
    public var engine: ManualSurfaceEngine {
        guard let engineStorage else { preconditionFailure("terminal surface is not initialized") }
        return engineStorage
    }
    public var applicator: OutputRangeApplicator {
        guard let applicatorStorage else { preconditionFailure("terminal applicator is not initialized") }
        return applicatorStorage
    }
    public private(set) var attachClient: AttachReplayClient?

    public var onUserClose: (() -> Void)?
    public var onFirstCorrectFrame: ((UInt64) -> Void)?
    public var onStateChange: ((TerminalSurfaceState) -> Void)?
    public var onBell: (() -> Void)?

    public private(set) var focusStealAttempts = 0
    public var testingAllowFocusSteal = false
    public private(set) var drawScheduledCount = 0
    public private(set) var resizeFramesSent = 0
    public private(set) var reportedGeometry: TerminalGeometry?
    public private(set) var appliedContentScale = NSSize(width: 1, height: 1)
    public private(set) var appliedDisplayID: UInt32?
    public private(set) var appliedOcclusionVisible: Bool?

    private var viewerId: String
    private var resizeWorkItem: DispatchWorkItem?
    private var drawWorkItem: DispatchWorkItem?
    private var renderHostView: NSView?
    private var windowObservers: [NSObjectProtocol] = []
    private let resizeQuiescence: TimeInterval = 0.100
    // internal (not private): HiveTerminalView+Input.swift (gate 8) reads/writes these.
    var markedText: NSAttributedString?
    var pendingAuthoringHeld = false

    public init(frame frameRect: NSRect, engine: ManualSurfaceEngine, viewerId: String = "viewer-local") {
        self.engineStorage = engine
        self.viewerId = viewerId
        self.applicatorStorage = OutputRangeApplicator(engine: engine)
        super.init(frame: frameRect)
        wantsLayer = true
        wireBridgeEvents()
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
        drawWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.drawScheduledCount += 1
            self.engine.draw()
        }
        drawWorkItem = work
        DispatchQueue.main.async(execute: work)
    }

    // MARK: - Attach

    public func makeAttachClient() -> AttachReplayClient {
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
        setSurfaceState(.attaching)
        let client = attachClient ?? makeAttachClient()
        binding = SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
        applicator.bind(binding!, highWater: afterSeq)
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

    public func retarget(to newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        attachClient?.retarget(newBinding: newBinding, highWater: highWater)
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        setSurfaceState(.attaching)
        notifyOutputStatusReconnect(reason: "retarget-reconnect")
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
        let backingSize = convertToBacking(bounds.size)
        let fallbackScale = window?.backingScaleFactor ?? 1
        let xScale = bounds.width > 0 ? backingSize.width / bounds.width : fallbackScale
        let yScale = bounds.height > 0 ? backingSize.height / bounds.height : fallbackScale
        appliedContentScale = NSSize(width: xScale, height: yScale)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ghosttyRenderingLayer?.contentsScale = fallbackScale
        CATransaction.commit()

        if let surface = engineStorage?.surfaceHandle {
            ghostty_surface_set_content_scale(surface, xScale, yScale)
            synchronizeDisplayID(surface: surface)
        }
        synchronizeOcclusion()
        scheduleResizeIfNeeded()
    }

    private func synchronizeDisplayID(surface: ghostty_surface_t) {
        guard
            let screen = window?.screen,
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return }
        let displayID = number.uint32Value
        ghostty_surface_set_display_id(surface, displayID)
        appliedDisplayID = displayID
    }

    private func synchronizeOcclusion() {
        guard let surface = engineStorage?.surfaceHandle else { return }
        let visible = window?.occlusionState.contains(.visible) ?? false
        guard appliedOcclusionVisible != visible else { return }
        ghostty_surface_set_occlusion(surface, visible)
        appliedOcclusionVisible = visible
    }

    private func removeWindowObservers() {
        let center = NotificationCenter.default
        windowObservers.forEach(center.removeObserver)
        windowObservers.removeAll()
    }

    // MARK: - Geometry / RESIZE (M10)

    public override func layout() {
        super.layout()
        scheduleResizeIfNeeded()
    }

    public override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        scheduleResizeIfNeeded()
    }

    private func scheduleResizeIfNeeded() {
        resizeWorkItem?.cancel()
        let backingSize = convertToBacking(bounds.size)
        let width = max(0, Int(backingSize.width))
        let height = max(0, Int(backingSize.height))
        guard width > 0, height > 0 else { return }

        let work = DispatchWorkItem { [weak self] in
            self?.commitResize(widthPx: UInt32(width), heightPx: UInt32(height))
        }
        resizeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + resizeQuiescence, execute: work)
    }

    private func commitResize(widthPx: UInt32, heightPx: UInt32) {
        guard widthPx > 0, heightPx > 0 else { return }
        engine.setSize(widthPx: widthPx, heightPx: heightPx)
        guard let surface = engine.surfaceHandle else { return }

        let size = ghostty_surface_size(surface)
        guard
            size.columns > 0,
            size.rows > 0,
            size.width_px > 0,
            size.height_px > 0,
            size.cell_width_px > 0,
            size.cell_height_px > 0
        else {
            reportedGeometry = nil
            return
        }
        let geometry = TerminalGeometry(
            columns: Int(size.columns),
            rows: Int(size.rows),
            widthPx: Int(size.width_px),
            heightPx: Int(size.height_px),
            cellWidthPx: Double(size.cell_width_px),
            cellHeightPx: Double(size.cell_height_px)
        )
        reportedGeometry = geometry
        if binding != nil, let client = attachClient {
            guard (try? client.sendResize(geometry)) != nil else { return }
            resizeFramesSent += 1
        }
    }

    // MARK: - Close

    public func userClose() {
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
