import Foundation

/// Bidirectional §20 frame transport (UDS in production; test double in Tests).
///
/// ## L3 SEAM (OUT OF SCOPE for WP5 L0–L2)
/// Real WP4 session-host binding implements this protocol over UDS using the
/// grant endpoint. L2 must not assume a pre-queued FakeHost shape.
///
/// ## Async-host shape (M6)
/// - `receive()` returns `nil` **only** when the transport is closed.
/// - While open, `receive()` **blocks** until a frame arrives or the optional
///   timeout elapses (timeout → `WireError.receiveTimeout`, not nil).
/// - L3 can implement this with a UDS read loop without changing L2.
public protocol HostTransport: AnyObject {
    /// Connection identity used to cancel obsolete attaches on retarget (§26).
    var connectionId: String { get }
    var isClosed: Bool { get }
    func send(_ frame: WireFrame) throws
    /// Next inbound frame. `nil` means closed. Never means "queue empty".
    func receive(timeout: TimeInterval?) throws -> WireFrame?
    func close()
}

public extension HostTransport {
    func receive() throws -> WireFrame? {
        try receive(timeout: nil)
    }
}

/// One coalesced pump turn: `first` plus the frames already buffered behind
/// it, in wire order.
public struct HostFrameBatch: Equatable, Sendable {
    public let frames: [WireFrame]
    /// The transport reported an orderly close while draining. Deliver
    /// `frames` first, then treat the connection as ended.
    public let hostClosed: Bool
}

public extension HostTransport {
    /// Drains `first` plus every frame already buffered behind it, without
    /// blocking, up to `maxFrames` total.
    ///
    /// Coalescing entry for the pane pump: an output burst reaches the main
    /// queue as ONE block instead of one block per 64 KiB frame, so queued
    /// output cannot pile hundreds of main-queue blocks ahead of keystrokes.
    /// Frame order is untouched and APPLIED acks still fire per frame from
    /// `pumpHostFrame` in applied order — only the main-queue block count
    /// changes. The cap keeps a single turn bounded so input blocks
    /// interleave between turns under a sustained flood.
    func drainAvailableFrames(first: WireFrame, maxFrames: Int) -> HostFrameBatch {
        var frames = [first]
        var hostClosed = false
        while frames.count < max(1, maxFrames) {
            do {
                guard let next = try receive(timeout: 0) else {
                    hostClosed = true
                    break
                }
                frames.append(next)
            } catch {
                // receiveTimeout = nothing more buffered right now; a hard
                // failure closes the transport and resurfaces as `nil` on the
                // pump's next blocking receive.
                break
            }
        }
        return HostFrameBatch(frames: frames, hostClosed: hostClosed)
    }
}
