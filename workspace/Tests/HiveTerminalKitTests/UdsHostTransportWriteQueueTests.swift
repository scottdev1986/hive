import Foundation
import XCTest
@testable import HiveTerminalKit

/// L3 write path: `UdsHostTransport.send` must not run its blocking `write(2)`
/// loop on the caller's (main) thread. A serial background writer preserves
/// per-transport FIFO order, and `close` during a pending write returns
/// promptly, drops queued writes safely, and never writes to a recycled fd.
final class UdsHostTransportWriteQueueTests: XCTestCase {
    private func makeSocketPair() -> (transport: UdsHostTransport, peer: Int32) {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        return (UdsHostTransport(fd: fds[0]), fds[1])
    }

    /// Accumulates from `fd` until `target` bytes, EOF, or the deadline.
    private func readFromPeer(_ fd: Int32, target: Int, deadline: Date) -> Data {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while buffer.count < target && Date() < deadline {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, 100)
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { continue }
            let count = read(fd, &chunk, chunk.count)
            if count > 0 {
                buffer.append(contentsOf: chunk[0..<count])
            } else if count == 0 {
                break // EOF
            } else if errno != EINTR {
                break
            }
        }
        return buffer
    }

    /// 200 frames sent back-to-back arrive byte-for-byte in send order, even
    /// though the writes run on the transport's background queue.
    func testBackgroundWriterPreservesFifoOrder() throws {
        let (transport, peer) = makeSocketPair()
        defer {
            transport.close()
            Darwin.close(peer)
        }

        let frames = (0..<200).map { index in
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: UInt64(index * 100),
                payload: Data("frame-\(String(format: "%03d", index))-payload".utf8)
            )
        }
        let expected = try frames.reduce(Data()) { try $0 + FrameCodec.encode($1) }

        for frame in frames {
            try transport.send(frame)
        }
        let received = readFromPeer(
            peer,
            target: expected.count,
            deadline: Date().addingTimeInterval(10)
        )
        XCTAssertEqual(received, expected, "wire bytes must arrive in exact FIFO send order")
    }

    /// With the peer not reading and a full socket buffer, `send` and `close`
    /// both return promptly (no main-thread blocking), queued writes are
    /// dropped rather than misdirected, and the bytes that did get written
    /// stay a clean prefix of the encoded stream.
    func testCloseDuringPendingWriteIsPromptAndSafe() throws {
        let (transport, peer) = makeSocketPair()
        defer { Darwin.close(peer) }

        // Shrink the peer's receive buffer so the writer blocks quickly.
        var receiveBuffer: Int32 = 4096
        setsockopt(peer, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, socklen_t(MemoryLayout<Int32>.size))

        let frames = (0..<200).map { index in
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: UInt64(index * 8192),
                payload: Data(repeating: UInt8(index % 251), count: 8192)
            )
        }
        let expected = try frames.reduce(Data()) { try $0 + FrameCodec.encode($1) }

        // Nobody reads the peer: ~1.6 MB cannot drain. Sends must still
        // return immediately — the whole point of the background writer.
        let sendStart = Date()
        for frame in frames {
            try transport.send(frame)
        }
        XCTAssertLessThan(
            Date().timeIntervalSince(sendStart),
            1.0,
            "send must not block the caller behind a stuck host"
        )

        let closeStart = Date()
        transport.close()
        XCTAssertLessThan(
            Date().timeIntervalSince(closeStart),
            1.0,
            "close must not wait for pending writes"
        )
        XCTAssertTrue(transport.isClosed)
        XCTAssertThrowsError(try transport.send(frames[0])) { error in
            XCTAssertEqual(error as? WireError, .closed)
        }

        // Drain the peer so the in-flight write unblocks; the transport's fd
        // then closes (barrier behind the queued writes) and the peer sees EOF.
        let received = readFromPeer(
            peer,
            target: expected.count,
            deadline: Date().addingTimeInterval(10)
        )
        XCTAssertLessThan(
            received.count,
            expected.count,
            "queued writes must self-drop once closed"
        )
        XCTAssertEqual(
            received,
            expected.prefix(received.count),
            "written bytes stay a clean FIFO prefix — no reordered or torn frames"
        )
        XCTAssertEqual(
            received.count % (FrameCodec.headerBytes + 8192),
            0,
            "only whole frames reach the wire"
        )
    }
}
