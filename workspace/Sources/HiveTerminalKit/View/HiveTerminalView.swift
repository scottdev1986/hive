import AppKit
import Foundation

/// L1 `HiveTerminalView` — one edge-to-edge NSView bound to exactly one
/// SessionLocator/generation (§26).
///
/// Focus rules (§07/§26):
/// - Becomes first responder **only** on direct click or explicit focus action
/// - Output, status, message, automation, reconnect **never** steal focus
///
/// Geometry (§26):
/// - Actual backing-pixel and cell geometry when attached
/// - One host resize after 100 ms quiescence; never 0×0
///
/// Close means terminate (§26) — never transport DETACH for user close.
/// User-close TERMINATE is owned by the embedding UI (WP6); this view exposes
/// `onUserClose` so the host can send exact-generation TERMINATE.
public final class HiveTerminalView: NSView {
    public private(set) var surfaceState: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var highWater: UInt64 = 0

    public let engine: ManualSurfaceEngine
    public let applicator: OutputRangeApplicator
    public private(set) var attachClient: AttachReplayClient?

    /// Fired when the user requests close (maps to exact-generation TERMINATE).
    public var onUserClose: (() -> Void)?
    /// Fired after first correct frame; does **not** change first responder.
    public var onFirstCorrectFrame: ((UInt64) -> Void)?
    /// Fired on state transitions (for status UI — must not steal focus).
    public var onStateChange: ((TerminalSurfaceState) -> Void)?

    /// Positive-control counter: how many times output/status/reconnect asked
    /// for focus. Always zero on the real path; tests assert it stays zero.
    public private(set) var focusStealAttempts = 0
    /// When true (tests only), simulate a buggy path that would steal focus.
    public var testingAllowFocusSteal = false

    private var viewerId: String
    private var resizeWorkItem: DispatchWorkItem?
    private var lastGeometry: TerminalGeometry?
    private let resizeQuiescence: TimeInterval = 0.100

    public init(frame frameRect: NSRect, engine: ManualSurfaceEngine, viewerId: String = "viewer-local") {
        self.engine = engine
        self.viewerId = viewerId
        self.applicator = OutputRangeApplicator(engine: engine)
        super.init(frame: frameRect)
        wantsLayer = true
        // Not first responder by default — explicit click required.
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - Attach

    /// Wire an attach client (L2). Host transport is injected (FakeHost or L3).
    public func makeAttachClient() -> AttachReplayClient {
        let client = AttachReplayClient(viewerId: viewerId, engine: engine)
        attachClient = client
        return client
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
            // §26: present first correct frame WITHOUT stealing focus.
            notifyOutputStatusReconnect(reason: "first-correct-frame")
            onFirstCorrectFrame?(hw)
        case .failed(let state):
            setSurfaceState(state)
        case .rejectedLateFrame, .continueReplay:
            break
        }
        return outcome
    }

    /// Retarget to a new locator/generation. Late frames for the old binding
    /// must be rejected (§26).
    public func retarget(to newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        attachClient?.retarget(newBinding: newBinding, highWater: highWater)
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        setSurfaceState(.attaching)
        // Reconnect must not steal focus.
        notifyOutputStatusReconnect(reason: "retarget-reconnect")
    }

    /// Apply an OUTPUT frame. Rejects wrong binding (late frame).
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
        if case .rejectedWrongBinding = result {
            // Explicit non-application of late frame.
        }
        return result
    }

    public func applyStatusUpdate(evidence: String) {
        // Status never steals focus (§26).
        notifyOutputStatusReconnect(reason: "status:\(evidence)")
    }

    // MARK: - First responder

    public override var acceptsFirstResponder: Bool { true }

    public override func mouseDown(with event: NSEvent) {
        // Explicit click — the only path that may become first responder
        // without an external explicit focus action.
        window?.makeFirstResponder(self)
        engine.setFocus(true)
        super.mouseDown(with: event)
    }

    /// Explicit focus action (keyboard navigation from embedding UI).
    public func focusExplicitly() {
        window?.makeFirstResponder(self)
        engine.setFocus(true)
    }

    public override func resignFirstResponder() -> Bool {
        engine.setFocus(false)
        return super.resignFirstResponder()
    }

    /// Called for output/status/reconnect. Must NOT call makeFirstResponder
    /// unless `testingAllowFocusSteal` is set (positive-control harness).
    public func notifyOutputStatusReconnect(reason: String) {
        _ = reason
        if testingAllowFocusSteal {
            focusStealAttempts += 1
            window?.makeFirstResponder(self)
            return
        }
        // Production path: never mutate first responder.
        // Count stays 0 — tests assert this after firing output/status/reconnect.
    }

    // MARK: - Geometry

    public override func layout() {
        super.layout()
        scheduleResizeIfNeeded()
    }

    public override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        scheduleResizeIfNeeded()
    }

    private func scheduleResizeIfNeeded() {
        let bounds = self.bounds
        let width = max(0, Int(bounds.width * (window?.backingScaleFactor ?? 1)))
        let height = max(0, Int(bounds.height * (window?.backingScaleFactor ?? 1)))
        // Never send 0×0 (§26).
        guard width > 0, height > 0 else { return }

        resizeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.commitResize(widthPx: UInt32(width), heightPx: UInt32(height))
        }
        resizeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + resizeQuiescence, execute: work)
    }

    private func commitResize(widthPx: UInt32, heightPx: UInt32) {
        guard binding != nil else { return } // detached surfaces do not resize PTY
        guard widthPx > 0, heightPx > 0 else { return }
        engine.setSize(widthPx: widthPx, heightPx: heightPx)
    }

    // MARK: - Close

    /// User close — exact-generation TERMINATE, never DETACH (§26).
    public func userClose() {
        onUserClose?()
        engine.free()
        binding = nil
        applicator.clearBinding()
        setSurfaceState(.exited(evidence: "user-close"))
    }

    // MARK: - State

    private func setSurfaceState(_ newState: TerminalSurfaceState) {
        surfaceState = newState
        // Status projection must not steal focus.
        notifyOutputStatusReconnect(reason: "state")
        onStateChange?(newState)
    }
}
