import Foundation

/// Production `HostTransport`: one blocking Unix-domain-socket connection to a sessiond host endpoint, framed by `FrameCodec`. Reads block until a full frame arrives, the optional timeout elapses (`WireError.receiveTimeout`), or the host closes the stream (`nil`). `connectionId` is unique per connection so a retargeted surface rejects frames from an obsolete connection.
public final class UdsHostTransport: HostTransport {
    public let connectionId: String
    public private(set) var isClosed = false

    private var fd: Int32
    private var pendingBytes = Data()
    private var failure: String?
    private let lock = NSLock()
    private var inputWrites: [Data] = []
    private var inputWriteIndex = 0
    private var controlWrites: [Data] = []
    private var controlWriteIndex = 0
    private var writerScheduled = false
    /// One background writer keeps frame bytes contiguous. Interactive input
    /// is selected before queued acknowledgements and control traffic.
    private let writeQueue = DispatchQueue(label: "hive.uds-host-transport.write")

    public var failureEvidence: String? {
        lock.lock()
        defer { lock.unlock() }
        return failure
    }

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

    public func send(_ frame: WireFrame) throws {
        try enqueue(FrameCodec.encode(frame), input: false)
    }

    public func sendInput(_ bytes: Data) throws {
        guard !bytes.isEmpty else { return }
        try enqueue(FrameCodec.encode(WireFrame(
            type: .userInput,
            flags: [.contentSensitive],
            payload: bytes
        )), input: true)
    }

    private func enqueue(_ bytes: Data, input: Bool) throws {
        lock.lock()
        guard !isClosed else {
            lock.unlock()
            throw WireError.closed
        }
        if input {
            inputWrites.append(bytes)
        } else {
            controlWrites.append(bytes)
        }
        let shouldSchedule = !writerScheduled
        writerScheduled = true
        lock.unlock()
        if shouldSchedule {
            writeQueue.async { [weak self] in
                self?.drainWrites()
            }
        }
    }

    private func drainWrites() {
        while true {
            lock.lock()
            guard !isClosed else {
                discardQueuedWrites()
                writerScheduled = false
                lock.unlock()
                return
            }
            let bytes: Data?
            if inputWriteIndex < inputWrites.count {
                bytes = inputWrites[inputWriteIndex]
                inputWriteIndex += 1
            } else if controlWriteIndex < controlWrites.count {
                bytes = controlWrites[controlWriteIndex]
                controlWriteIndex += 1
            } else {
                discardQueuedWrites()
                writerScheduled = false
                lock.unlock()
                return
            }
            let fd = self.fd
            lock.unlock()
            guard let bytes else { continue }
            if !writeAll(bytes, fd: fd) { return }
        }
    }

    private func discardQueuedWrites() {
        inputWrites.removeAll(keepingCapacity: true)
        inputWriteIndex = 0
        controlWrites.removeAll(keepingCapacity: true)
        controlWriteIndex = 0
    }

    private func writeAll(_ bytes: Data, fd: Int32) -> Bool {
        guard fd >= 0 else { return false }
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
        if failed {
            let code = errno
            fail("write errno \(code)")
            return false
        }
        return true
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
            if count == 0 {
                close()
                if pendingBytes.isEmpty { return nil }
                throw WireError.malformedFrame("stream closed mid-frame")
            }
            let code = errno
            fail("read errno \(code)")
            throw WireError.malformedFrame("read errno \(code)")
        }
    }

    /// Marks the transport closed immediately (new sends fail, queued writes self-drop, `receive` winds down) and closes the fd as a BARRIER on the write queue: it runs after every already-enqueued write, so an in-flight or pending write always completes on the real fd and never on a recycled one. Returns without waiting for the queue.
    public func close() {
        lock.lock()
        let staleFd = isClosed ? -1 : fd
        isClosed = true
        fd = -1
        lock.unlock()
        guard staleFd >= 0 else { return }
        writeQueue.async { Darwin.close(staleFd) }
    }

    private func fail(_ evidence: String) {
        lock.lock()
        if failure == nil { failure = evidence }
        lock.unlock()
        close()
    }

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
            let code = errno
            fail("poll errno \(code)")
            throw WireError.closed
        }
    }
}
