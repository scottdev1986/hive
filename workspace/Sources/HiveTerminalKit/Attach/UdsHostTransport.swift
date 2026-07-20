import Foundation

/// L3 production `HostTransport`: one blocking Unix-domain-socket connection to
/// a sessiond host endpoint, framed by `FrameCodec` (§20).
///
/// Reads block until a full frame arrives, the optional timeout elapses
/// (`WireError.receiveTimeout`), or the host closes the stream (`nil`).
/// `connectionId` is unique per connection so a retargeted surface rejects
/// frames from an obsolete connection (§26).
public final class UdsHostTransport: HostTransport {
    public let connectionId: String
    public private(set) var isClosed = false

    private var fd: Int32
    private var pendingBytes = Data()
    private let lock = NSLock()
    /// Serial background writer: keeps the blocking `write(2)` loop off the
    /// caller's (usually main) thread while preserving per-transport FIFO
    /// order. The fd is closed ONLY as a barrier on this queue (see `close`),
    /// so a queued write can never land on a recycled fd.
    private let writeQueue = DispatchQueue(label: "hive.uds-host-transport.write")

    public static func connect(endpoint: String) throws -> UdsHostTransport {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw WireError.malformedFrame("socket: errno \(errno)")
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(endpoint.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path) - 1
        guard pathBytes.count <= capacity else {
            Darwin.close(fd)
            throw WireError.malformedFrame("endpoint path too long")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, length)
            }
        }
        guard connected == 0 else {
            let code = errno
            Darwin.close(fd)
            throw WireError.malformedFrame("connect \(endpoint): errno \(code)")
        }
        return UdsHostTransport(fd: fd)
    }

    init(fd: Int32) {
        self.fd = fd
        self.connectionId = "uds-\(UInt64.random(in: UInt64.min...UInt64.max))"
    }

    deinit {
        close()
    }

    /// Enqueues the frame on the serial background writer and returns without
    /// blocking the caller on `write(2)`. Throws synchronously only when the
    /// transport is already closed (or the frame fails to encode); a write
    /// that fails on the queue closes the transport, which the read side
    /// surfaces as end-of-stream. The enqueue happens under `lock` so FIFO
    /// order matches caller order even with concurrent senders.
    public func send(_ frame: WireFrame) throws {
        let bytes = try FrameCodec.encode(frame)
        lock.lock()
        guard !isClosed else {
            lock.unlock()
            throw WireError.closed
        }
        writeQueue.async { [weak self] in
            self?.writeAll(bytes)
        }
        lock.unlock()
    }

    /// Runs on `writeQueue`; `self` is retained for the duration of the call,
    /// so the fd snapshot taken under `lock` stays valid until the barrier
    /// close (queued after this block) runs.
    private func writeAll(_ bytes: Data) {
        lock.lock()
        let open = !isClosed
        let fd = self.fd
        lock.unlock()
        guard open, fd >= 0 else { return }
        var written = 0
        let failed: Bool = bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            while written < raw.count {
                let sent = write(fd, raw.baseAddress!.advanced(by: written), raw.count - written)
                if sent > 0 {
                    written += sent
                    continue
                }
                if sent < 0 && errno == EINTR { continue }
                return true
            }
            return false
        }
        if failed { close() }
    }

    public func receive(timeout: TimeInterval?) throws -> WireFrame? {
        while true {
            if let frame = try dequeueFrame() {
                return frame
            }
            if isClosed { return nil }
            guard try waitReadable(timeout: timeout) else {
                throw WireError.receiveTimeout
            }
            var storage = [UInt8](repeating: 0, count: 64 * 1024)
            let count = read(fd, &storage, storage.count)
            if count > 0 {
                pendingBytes.append(contentsOf: storage[0..<count])
                continue
            }
            if count < 0 && errno == EINTR { continue }
            // 0 = orderly EOF; <0 = reset. Both end this connection.
            close()
            if pendingBytes.isEmpty { return nil }
            throw WireError.malformedFrame("stream closed mid-frame")
        }
    }

    /// Marks the transport closed immediately (new sends fail, queued writes
    /// self-drop, `receive` winds down) and closes the fd as a BARRIER on the
    /// write queue: it runs after every already-enqueued write, so an
    /// in-flight or pending write always completes on the real fd and never
    /// on a recycled one. Returns without waiting for the queue.
    public func close() {
        lock.lock()
        let staleFd = isClosed ? -1 : fd
        isClosed = true
        fd = -1
        lock.unlock()
        guard staleFd >= 0 else { return }
        writeQueue.async { Darwin.close(staleFd) }
    }

    /// Complete frame from the accumulation buffer, if one is fully buffered.
    private func dequeueFrame() throws -> WireFrame? {
        while true {
            guard pendingBytes.count >= FrameCodec.headerBytes else { return nil }
            let header = Data(pendingBytes.prefix(FrameCodec.headerBytes))
            let decoded = try FrameCodec.decodeHeader(header)
            let total = FrameCodec.headerBytes + decoded.payloadLength
            guard pendingBytes.count >= total else { return nil }
            let payload = Data(pendingBytes[
                pendingBytes.index(pendingBytes.startIndex, offsetBy: FrameCodec.headerBytes)
                    ..< pendingBytes.index(pendingBytes.startIndex, offsetBy: total)
            ])
            pendingBytes.removeFirst(total)
            if let frame = try FrameCodec.decodeFrame(header: header, payload: payload) {
                return frame
            }
            // Ignorable optional frame: keep scanning.
        }
    }

    private func waitReadable(timeout: TimeInterval?) throws -> Bool {
        var fds = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let milliseconds: Int32
        if let timeout {
            milliseconds = Int32(max(0, min(timeout * 1000, Double(Int32.max))))
        } else {
            milliseconds = -1
        }
        while true {
            let ready = poll(&fds, 1, milliseconds)
            if ready > 0 { return true }
            if ready == 0 { return false }
            if errno == EINTR { continue }
            close()
            throw WireError.closed
        }
    }
}
