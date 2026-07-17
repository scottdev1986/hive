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
