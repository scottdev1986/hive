import Foundation

// =============================================================================
// TEMPORARY DIAGNOSTIC — REMOVE BEFORE MERGE
//
// Exists to answer one question with data instead of reasoning: what is
// actually happening on the render path while a pane floods, and is the app
// presenting frames out of band with Ghostty's own renderer thread?
//
// Ghostty's renderer thread paces itself (DRAW_INTERVAL = 8 ms, cursor blink
// 600 ms) and presents through a display link. HiveTerminalView ALSO calls
// engine.draw() on every INVALIDATE, and INVALIDATE now arrives from the
// terminal I/O thread at output rate. If that is the flicker, these counters
// show it directly: invalidates/s and draws/s will track chunks/s rather than
// display refresh, and drawMaxUs will show how long a present blocks main.
//
// Everything here is off the hot path except a few counter increments under an
// uncontended lock. The aggregate line is written once a second from a
// background queue.
//
// Read with:  tail -f ~/.hive/terminal-telemetry.log
// =============================================================================

public final class TerminalTelemetry: @unchecked Sendable {
    public static let shared = TerminalTelemetry()

    private let lock = NSLock()
    private var outputFrames = 0
    private var outputBytes = 0
    private var invalidates = 0
    private var drawsExecuted = 0
    private var drawTotalUs = 0
    private var drawMaxUs = 0
    private var feedTotalUs = 0
    private var feedMaxUs = 0
    private var axRefreshes = 0
    private var axMaxUs = 0
    private var attaches = 0
    private var attachTotalUs = 0
    private var attachMaxUs = 0
    private var hopSamples: [Double] = []
    private var started = false

    private let queue = DispatchQueue(label: "hive.terminal-telemetry")
    private var handle: FileHandle?

    /// Called once when the first pane attaches. Safe to call repeatedly.
    public func startIfNeeded() {
        // Never inside XCTest: the sampler hops to the main queue 20×/second,
        // which would perturb the very main-queue latency the pane stress test
        // measures. This is for the live app only.
        guard NSClassFromString("XCTestCase") == nil else { return }
        lock.lock()
        let alreadyStarted = started
        started = true
        lock.unlock()
        guard !alreadyStarted else { return }

        let path = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".hive/terminal-telemetry.log")
        FileManager.default.createFile(atPath: path, contents: nil)
        handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
        write("=== terminal telemetry started \(Date()) ===")

        // Sampler: main-queue scheduling latency, the live equivalent of the
        // regression test's probe. A keystroke is main-queue work, so this is
        // what "typing feels laggy" looks like as a number. Waiting off-main
        // means this can never deadlock against the main thread.
        queue.async { [weak self] in
            while true {
                guard let self else { return }
                for _ in 0..<20 {
                    let t0 = ProcessInfo.processInfo.systemUptime
                    let hop = DispatchSemaphore(value: 0)
                    DispatchQueue.main.async { hop.signal() }
                    hop.wait()
                    let elapsed = ProcessInfo.processInfo.systemUptime - t0
                    self.lock.lock()
                    self.hopSamples.append(elapsed)
                    self.lock.unlock()
                    Thread.sleep(forTimeInterval: 0.05)
                }
                self.flush()
            }
        }
    }

    public func noteOutputFrame(bytes: Int) {
        lock.lock()
        outputFrames += 1
        outputBytes += bytes
        lock.unlock()
    }

    public func noteInvalidate() {
        lock.lock()
        invalidates += 1
        lock.unlock()
    }

    public func noteDraw(microseconds: Int) {
        lock.lock()
        drawsExecuted += 1
        drawTotalUs += microseconds
        drawMaxUs = max(drawMaxUs, microseconds)
        lock.unlock()
    }

    public func noteFeed(microseconds: Int) {
        lock.lock()
        feedTotalUs += microseconds
        feedMaxUs = max(feedMaxUs, microseconds)
        lock.unlock()
    }

    /// Main-thread accessibility refresh. This is the suspect for the residual
    /// main-queue latency: the semantic export takes Ghostty's
    /// renderer_state.mutex, which the terminal I/O thread holds for the whole
    /// chunk parse — so main can block behind a feed even though the parse
    /// itself was moved off main. If axMaxUs tracks mainHopMaxMs, that is it.
    public func noteAccessibilityRefresh(microseconds: Int) {
        lock.lock()
        axRefreshes += 1
        axMaxUs = max(axMaxUs, microseconds)
        lock.unlock()
    }

    /// One pane's attach handshake, timed where it runs: the MAIN thread.
    ///
    /// `SessiondPaneTerminal.completeAttach` hops to main and calls
    /// `AttachReplayClient.attach`, which sends HELLO, then blocks in
    /// `transport.receive(timeout: handshakeTimeout)` — a 5 second timeout —
    /// waiting for WELCOME, then loops receiving SNAPSHOT_BYTES and the whole
    /// retained journal, restoring and parsing all of it inline. Every second
    /// of that is a second the main queue cannot run anything else, and ten
    /// agents spawning at once means ten of them back to back.
    public func noteAttach(microseconds: Int) {
        lock.lock()
        attaches += 1
        attachTotalUs += microseconds
        attachMaxUs = max(attachMaxUs, microseconds)
        lock.unlock()
    }

    private func flush() {
        lock.lock()
        let frames = outputFrames
        let bytes = outputBytes
        let inval = invalidates
        let draws = drawsExecuted
        let drawAvg = draws > 0 ? drawTotalUs / draws : 0
        let drawMax = drawMaxUs
        let feedAvg = frames > 0 ? feedTotalUs / frames : 0
        let feedMax = feedMaxUs
        let axCount = axRefreshes
        let axMax = axMaxUs
        let attachCount = attaches
        let attachMax = attachMaxUs
        let hops = hopSamples.sorted()
        outputFrames = 0; outputBytes = 0; invalidates = 0
        drawsExecuted = 0; drawTotalUs = 0; drawMaxUs = 0
        feedTotalUs = 0; feedMaxUs = 0; hopSamples = []
        axRefreshes = 0; axMaxUs = 0
        attaches = 0; attachTotalUs = 0; attachMaxUs = 0
        lock.unlock()

        let hopP50 = hops.isEmpty ? 0 : hops[hops.count / 2]
        let hopMax = hops.last ?? 0
        // A quiet second is not interesting — UNLESS the main queue stalled.
        // Suppressing on "no output" threw away exactly the evidence of a UI
        // freeze during agent spawn, when panes are attaching and not yet
        // producing output. A stall is always worth a line.
        guard frames > 0 || draws > 0 || inval > 0 || attachCount > 0 || hopMax > 0.100
        else { return }
        write(
            "frames=\(frames) kb=\(bytes / 1024) invalidates=\(inval) draws=\(draws) "
                + "drawAvgUs=\(drawAvg) drawMaxUs=\(drawMax) "
                + "feedAvgUs=\(feedAvg) feedMaxUs=\(feedMax) "
                + "axRefreshes=\(axCount) axMaxUs=\(axMax) "
                + "attaches=\(attachCount) attachMaxUs=\(attachMax) "
                + "mainHopP50Ms=\(String(format: "%.2f", hopP50 * 1000)) "
                + "mainHopMaxMs=\(String(format: "%.2f", hopMax * 1000))"
        )
    }

    private func write(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
        handle?.write(data)
    }
}
