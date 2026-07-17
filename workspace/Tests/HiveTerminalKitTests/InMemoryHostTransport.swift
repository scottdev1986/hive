import Foundation
@testable import HiveTerminalKit

/// Test-only duplex transport (async-host-shaped). Not part of the product library.
///
/// - `receive` returns `nil` only when closed **or** when the inbound queue is
///   empty after a short wait (test convention: producer finished; L3 UDS would
///   block until the peer closes).
/// - With a positive timeout, empty queue past the deadline → `receiveTimeout`.
final class InMemoryHostTransport: HostTransport {
    let connectionId: String
    private var inbound: [WireFrame] = []
    private var closed = false
    private weak var peer: InMemoryHostTransport?
    private let lock = NSCondition()
    private(set) var sent: [WireFrame] = []

    var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed
    }

    init(connectionId: String = UUID().uuidString) {
        self.connectionId = connectionId
    }

    static func makePair(
        clientId: String = "client-\(UUID().uuidString)",
        hostId: String = "host-\(UUID().uuidString)"
    ) -> (client: InMemoryHostTransport, host: InMemoryHostTransport) {
        let client = InMemoryHostTransport(connectionId: clientId)
        let host = InMemoryHostTransport(connectionId: hostId)
        client.peer = host
        host.peer = client
        return (client, host)
    }

    func enqueueInbound(_ frame: WireFrame) {
        lock.lock()
        inbound.append(frame)
        lock.broadcast()
        lock.unlock()
    }

    func send(_ frame: WireFrame) throws {
        lock.lock()
        if closed {
            lock.unlock()
            throw WireError.closed
        }
        sent.append(frame)
        let peer = self.peer
        lock.unlock()
        guard let peer else { throw WireError.notConnected }
        peer.enqueueInbound(frame)
    }

    func receive(timeout: TimeInterval?) throws -> WireFrame? {
        lock.lock()
        defer { lock.unlock() }
        if let timeout {
            let deadline = Date().addingTimeInterval(timeout)
            while inbound.isEmpty && !closed {
                if Date() >= deadline {
                    throw WireError.receiveTimeout
                }
                lock.wait(until: min(deadline, Date().addingTimeInterval(0.05)))
            }
        } else {
            // Brief wait for a concurrent producer; then empty → end of stream.
            if inbound.isEmpty && !closed {
                lock.wait(until: Date().addingTimeInterval(0.02))
            }
        }
        if inbound.isEmpty {
            return nil
        }
        return inbound.removeFirst()
    }

    func close() {
        lock.lock()
        closed = true
        inbound.removeAll()
        lock.broadcast()
        lock.unlock()
    }
}
