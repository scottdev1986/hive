import Foundation
@testable import HiveTerminalKit

/// Thread-safe record of the bytes an engine wrote through `onWrite`.
///
/// A real manual surface delivers its write callback on Ghostty's I/O thread,
/// never on main. A test that appends to a plain `[Data]` inside the callback
/// and then reads that same array from the main thread — which every drain loop
/// does — has two threads on one Swift Array with no synchronization. That race
/// trapped as `ContiguousArrayBuffer.swift: Fatal error: Index out of range`
/// inside the drain predicate, and when it did not trap it corrupted the heap
/// and took the whole test process down with it, which reads as a truncated run
/// rather than as a failure. Recording behind a lock is what makes the reader
/// safe; there is no other correct way to read these bytes from the main thread.
final class WriteTranscript {
    private let lock = NSLock()
    private var recorded: [Data] = []

    init() {}

    /// Convenience for the usual shape: create and start recording in one step.
    convenience init(recording context: BridgeCallbackContext) {
        self.init()
        record(from: context)
    }

    /// Becomes the context's write handler, replacing whatever was there.
    func record(from context: BridgeCallbackContext) {
        context.onWrite = { [self] bytes in
            lock.lock()
            recorded.append(bytes)
            lock.unlock()
        }
    }

    /// Every write, in arrival order.
    var chunks: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    /// How many separate write callbacks arrived.
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return recorded.count
    }

    /// Forgets everything recorded so far, so a later phase of the same test
    /// reads only its own writes.
    func reset() {
        lock.lock()
        recorded.removeAll()
        lock.unlock()
    }

    /// Every write concatenated.
    var bytes: Data {
        lock.lock()
        defer { lock.unlock() }
        return recorded.reduce(into: Data()) { $0.append($1) }
    }

    /// Every write concatenated and decoded as UTF-8.
    var text: String {
        String(decoding: bytes, as: UTF8.self)
    }
}
