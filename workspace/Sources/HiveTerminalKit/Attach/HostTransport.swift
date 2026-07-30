import Foundation

/// Bidirectional wire-frame transport (UDS in production; test double in Tests).
///
/// ## L3 SEAM
/// Production session-host binding implements this protocol over UDS using the
/// grant endpoint. Callers must not assume a pre-queued FakeHost shape.
///
/// ## Async-host shape
/// - `receive()` returns `nil` **only** when the transport is closed.
/// - While open, `receive()` **blocks** until a frame arrives or the optional
///   timeout elapses (timeout → `WireError.receiveTimeout`, not nil).
/// - Production can implement this with a UDS read loop without changing callers.
public protocol HostTransport: AnyObject {
    /// Connection identity used to cancel obsolete attaches on retarget.
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
