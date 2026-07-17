import Foundation

/// Bidirectional §20 frame transport (UDS in production; FakeHost in tests).
///
/// ## L3 SEAM (OUT OF SCOPE for WP5 L0–L2)
/// The real WP4 session-host binding swaps the injected `HostTransport`
/// implementation for a UDS client that speaks to the live host endpoint
/// from an `AttachGrant.endpoint`. Do **not** hardcode host module paths.
/// L0–L2 only require this protocol + `FakeHostTransport` in the test target.
public protocol HostTransport: AnyObject {
    /// Connection identity used to cancel obsolete attaches on retarget (§26).
    var connectionId: String { get }
    func send(_ frame: WireFrame) throws
    func receive() throws -> WireFrame?
    func close()
}

/// In-memory duplex used by unit tests and as a local FakeHost peer.
public final class InMemoryHostTransport: HostTransport {
    public let connectionId: String
    private var inbound: [WireFrame] = []
    private var closed = false
    /// Peer queue this transport writes into (the other side's inbound).
    private weak var peer: InMemoryHostTransport?
    private let lock = NSLock()

    public init(connectionId: String = UUID().uuidString) {
        self.connectionId = connectionId
    }

    /// Wire two transports as peers.
    public static func makePair(
        clientId: String = "client-\(UUID().uuidString)",
        hostId: String = "host-\(UUID().uuidString)"
    ) -> (client: InMemoryHostTransport, host: InMemoryHostTransport) {
        let client = InMemoryHostTransport(connectionId: clientId)
        let host = InMemoryHostTransport(connectionId: hostId)
        client.peer = host
        host.peer = client
        return (client, host)
    }

    public func enqueueInbound(_ frame: WireFrame) {
        lock.lock()
        inbound.append(frame)
        lock.unlock()
    }

    public func send(_ frame: WireFrame) throws {
        lock.lock()
        defer { lock.unlock() }
        if closed { throw WireError.closed }
        guard let peer else { throw WireError.notConnected }
        peer.enqueueInbound(frame)
    }

    public func receive() throws -> WireFrame? {
        lock.lock()
        defer { lock.unlock() }
        if closed { throw WireError.closed }
        guard !inbound.isEmpty else { return nil }
        return inbound.removeFirst()
    }

    public func close() {
        lock.lock()
        closed = true
        inbound.removeAll()
        lock.unlock()
    }
}
