import AppKit
import Darwin
import Foundation
import HiveGhosttyC

// Gate 3 (M1-B1) engine-scope live proof: LIFETIME / THREADING / EVENT LOOP at
// the C ABI boundary of the shipped GhosttyKit artifact (live-proof matrix
// row E). Every stage drives the REAL engine — no fakes, no Swift wrapper — so
// the properties are measured against the shipping library rather than against
// HiveTerminalKit's discipline (which XCTest qualifies separately, under the
// same sanitizers, in the same evidence run).
//
// Stages: wakeup-tick, copy-before-return, no-callback-after-free,
// free-ordering, multi-surface, rapid-create-free, inflight-close.
//
// Every stage's assertion is backed by a DEFECT MODE (`--defect=<name>`) that
// reintroduces the corresponding fault and drives the SAME assertion. The
// qualification runner requires each defect run to exit non-zero: an assertion
// that cannot go RED is not evidence.
//
// Engine calls are main-thread-confined exactly as production is: the main
// thread runs the run loop and worker code marshals through `onMain`.

private let defectFlagPrefix = "--defect="
private let defect: String? = CommandLine.arguments
    .first { $0.hasPrefix(defectFlagPrefix) }
    .map { String($0.dropFirst(defectFlagPrefix.count)) }

private func emit(stage: String, facts: [String: Any] = [:]) {
    var object = facts
    object["stage"] = stage
    object["pid"] = ProcessInfo.processInfo.processIdentifier
    object["defect"] = defect ?? "none"
    guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: bytes, encoding: .utf8) else {
        FileHandle.standardError.write(Data("GATE3_PROBE_FAIL encode \(stage)\n".utf8))
        Darwin.exit(1)
    }
    print(line)
    fflush(stdout)
}

/// A failed assertion is the probe's only exit-1 path. In a defect run this is
/// the expected outcome: the runner requires it.
private func fail(_ message: String) -> Never {
    emit(stage: "failed", facts: ["error": message])
    Darwin.exit(1)
}

private func check(_ condition: Bool, _ message: String) {
    if !condition { fail(message) }
}

// MARK: - Main-thread marshalling

private func onMain<T>(_ body: () -> T) -> T {
    Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
}

// MARK: - Callback recording

/// Records every engine-originated callback with the surface it was attributed
/// to and whether that surface had already been freed when it arrived.
private final class CallbackRecorder: @unchecked Sendable {
    struct Delivery {
        var label: String
        var bytes: Data
        var afterFree: Bool
        var thread: String
    }

    private let lock = NSLock()
    private var deliveries: [Delivery] = []
    private var freedLabels: Set<String> = []
    /// Defect `retain-callback-pointer`: the last raw callback pointer, kept
    /// past the callback's return in violation of the header's
    /// callback-lifetime-only contract.
    private var retainedPointer: UnsafePointer<UInt8>?
    private var retainedLength = 0
    private var retainedExpectation = Data()

    func record(label: String, bytes: UnsafePointer<UInt8>?, length: Int) {
        let copy: Data = (length > 0 && bytes != nil) ? Data(bytes: bytes!, count: length) : Data()
        lock.lock()
        let afterFree = freedLabels.contains(label)
        deliveries.append(Delivery(
            label: label,
            bytes: copy,
            afterFree: afterFree,
            thread: Thread.isMainThread ? "main" : "worker"
        ))
        if defect == "retain-callback-pointer", length > 0, let bytes {
            retainedPointer = bytes
            retainedLength = length
            retainedExpectation = copy
        }
        lock.unlock()
    }

    func markFreed(_ label: String) {
        lock.lock()
        freedLabels.insert(label)
        lock.unlock()
    }

    func snapshot() -> [Delivery] {
        lock.lock()
        defer { lock.unlock() }
        return deliveries
    }

    func bytes(for label: String) -> Data {
        snapshot().filter { $0.label == label }.reduce(into: Data()) { $0.append($1.bytes) }
    }

    func deliveriesAfterFree() -> [Delivery] {
        snapshot().filter(\.afterFree)
    }

    /// Defect `callback-after-free`: injects one delivery attributed to an
    /// already-freed surface through the SAME recorder the engine uses, so the
    /// `no-callback-after-free` assertion is proved capable of going RED.
    func injectPostFreeDelivery(label: String) {
        lock.lock()
        deliveries.append(Delivery(
            label: label,
            bytes: Data("injected".utf8),
            afterFree: freedLabels.contains(label),
            thread: "worker"
        ))
        lock.unlock()
    }

    /// Defect `retain-callback-pointer`: reads the engine's callback buffer
    /// after the callback returned. Under ASan this is the expected report;
    /// without ASan the bytes are expected to have changed. Either way the
    /// assertion below must fail — copying is not optional.
    func assertRetainedPointerStillValid() {
        lock.lock()
        let pointer = retainedPointer
        let length = retainedLength
        let expected = retainedExpectation
        lock.unlock()
        guard let pointer, length > 0 else {
            fail("retain-callback-pointer: no callback bytes were captured to retain")
        }
        let late = Data(bytes: pointer, count: length)
        check(
            late == expected,
            "retained callback pointer no longer yields the callback's bytes — " +
            "the header's callback-lifetime-only contract is real and copying is mandatory"
        )
    }
}

private let recorder = CallbackRecorder()

/// Per-surface callback context. The engine holds an unowned pointer to it for
/// the surface's lifetime; the probe owns it and keeps it alive past the free.
private final class SurfaceContext {
    let label: String
    init(label: String) { self.label = label }
}

private var liveContexts: [SurfaceContext] = []

private let probeWriteCallback: hive_ghostty_write_fn = { context, bytes, length in
    guard let context else { return }
    let ctx = Unmanaged<SurfaceContext>.fromOpaque(context).takeUnretainedValue()
    recorder.record(label: ctx.label, bytes: bytes, length: Int(length))
}

private let probeEventCallback: hive_ghostty_event_fn = { context, event in
    guard let context, let event else { return }
    let ctx = Unmanaged<SurfaceContext>.fromOpaque(context).takeUnretainedValue()
    let value = event.pointee
    recorder.record(label: "\(ctx.label)#event", bytes: value.bytes, length: value.length)
}

// MARK: - Wakeup / tick accounting

/// Mirrors production's wakeup discipline: `wakeup_cb` NEVER ticks inline (the
/// engine can invoke it synchronously from inside a Ghostty call, so an inline
/// tick would re-enter `ghostty_app_tick`); it defers the tick to the main
/// queue. The counters make "a tick actually executed" measurable rather than
/// inferred from `wakeup_cb` returning.
private final class WakeupLedger: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var wakeups = 0
    private(set) var ticks = 0
    private(set) var ticksOnMain = 0
    private(set) var inlineTicks = 0
    private var insideWakeup = 0
    var app: ghostty_app_t?

    func wakeupBegan() {
        lock.lock(); wakeups += 1; insideWakeup += 1; lock.unlock()
    }

    func wakeupEnded() {
        lock.lock(); insideWakeup -= 1; lock.unlock()
    }

    func tickRan(onMain: Bool) {
        lock.lock()
        ticks += 1
        if onMain { ticksOnMain += 1 }
        if insideWakeup > 0 { inlineTicks += 1 }
        lock.unlock()
    }

    func currentApp() -> ghostty_app_t? {
        lock.lock(); defer { lock.unlock() }
        return app
    }
}

private let wakeupLedger = WakeupLedger()

private let probeWakeupCallback: ghostty_runtime_wakeup_cb = { _ in
    wakeupLedger.wakeupBegan()
    // Deferred, exactly like production's GhosttyAppWakeupContext.scheduleTick.
    DispatchQueue.main.async {
        guard let app = wakeupLedger.currentApp() else { return }
        ghostty_app_tick(app)
        wakeupLedger.tickRan(onMain: Thread.isMainThread)
    }
    wakeupLedger.wakeupEnded()
}

// MARK: - Engine helpers

private func processOutput(
    _ surface: ghostty_surface_t,
    _ data: Data,
    at sequence: UInt64
) -> ghostty_result_e {
    data.withUnsafeBytes { raw in
        hive_ghostty_surface_process_output_v1(
            surface,
            raw.bindMemory(to: UInt8.self).baseAddress,
            raw.count,
            sequence
        )
    }
}

private func makeSurface(app: ghostty_app_t, label: String, replies: Bool) -> ghostty_surface_t {
    // Serial, main-thread creation: `hive_ghostty_surface_new_manual_v1` fills a
    // PROCESS-GLOBAL backend slot, so concurrent creation is a contract
    // violation, not a race to qualify. Production marshals creation to main
    // for the same reason (Gate3ConcurrentCreationTests covers that discipline).
    let context = SurfaceContext(label: label)
    liveContexts.append(context)
    let hostView = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
    hostViews.append(hostView)
    var config = ghostty_surface_config_new()
    config.platform_tag = GHOSTTY_PLATFORM_MACOS
    config.platform = ghostty_platform_u(
        macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(hostView).toOpaque())
    )
    config.scale_factor = 2
    config.font_size = 13
    let opaque = Unmanaged.passUnretained(context).toOpaque()
    guard let surface = hive_ghostty_surface_new_manual_v1(
        app,
        &config,
        UInt32(replies ? HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED : HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED),
        probeWriteCallback,
        opaque,
        probeEventCallback,
        opaque
    ) else {
        fail("manual surface creation failed for \(label)")
    }
    ghostty_surface_set_size(surface, 640, 360)
    return surface
}

private var hostViews: [NSView] = []

/// Runs the main queue for `seconds`, letting deferred ticks and any
/// engine-scheduled main-queue work actually execute. Called from the worker.
private func pumpMain(seconds: TimeInterval) {
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.signal() }
    done.wait()
}

/// Device Attributes request: a response-producing control that makes the real
/// engine emit real bytes through the write callback (the only way engine-owned
/// callback memory reaches the probe).
private let deviceAttributesRequest = Data("\u{1b}[c".utf8)

// MARK: - Probe body

private func runProbe() {
    _ = onMain { ghostty_init(0, nil) }
    guard let config = onMain({ ghostty_config_new() }) else { fail("ghostty_config_new") }
    onMain { ghostty_config_finalize(config) }

    var runtime = ghostty_runtime_config_s(
        userdata: nil,
        supports_selection_clipboard: false,
        wakeup_cb: probeWakeupCallback,
        action_cb: { _, _, _ in false },
        read_clipboard_cb: { _, _, _ in false },
        confirm_read_clipboard_cb: { _, _, _, _ in },
        write_clipboard_cb: { _, _, _, _, _ in },
        close_surface_cb: { _, _ in }
    )
    guard let app = onMain({ ghostty_app_new(&runtime, config) }) else { fail("ghostty_app_new") }
    wakeupLedger.app = app

    // ---- Stage: wakeup-tick -------------------------------------------------
    // Creating and driving a surface pushes onto App.Mailbox, which invokes
    // wakeup_cb synchronously on the pushing thread. The deferred tick must then
    // actually run, on main, and never inside the wakeup callback itself.
    let primary = onMain { makeSurface(app: app, label: "primary", replies: true) }
    onMain { _ = processOutput(primary, Data("gate3 wakeup probe\r\n".utf8), at: 0) }
    pumpMain(seconds: 0.25)
    check(wakeupLedger.wakeups > 0, "the engine never invoked wakeup_cb — a deferred tick can never run")
    check(wakeupLedger.ticks > 0, "wakeup_cb ran but no ghostty_app_tick ever executed")
    check(
        wakeupLedger.ticks == wakeupLedger.ticksOnMain,
        "a tick executed off the main thread (\(wakeupLedger.ticks - wakeupLedger.ticksOnMain) of \(wakeupLedger.ticks))"
    )
    check(
        wakeupLedger.inlineTicks == 0,
        "a tick executed INSIDE wakeup_cb — re-entrant ghostty_app_tick (\(wakeupLedger.inlineTicks))"
    )
    emit(stage: "wakeup-tick", facts: [
        "wakeups": wakeupLedger.wakeups,
        "ticks": wakeupLedger.ticks,
        "ticksOnMain": wakeupLedger.ticksOnMain,
        "inlineTicks": wakeupLedger.inlineTicks,
    ])

    // ---- Stage: copy-before-return -----------------------------------------
    // Real engine-owned callback bytes. Green mode copies inside the callback
    // and the copy survives; defect mode retains the raw pointer and reads it
    // after the callback returned (ASan report / changed bytes → RED).
    var sequence = UInt64("gate3 wakeup probe\r\n".utf8.count)
    onMain { _ = processOutput(primary, deviceAttributesRequest, at: sequence) }
    sequence += UInt64(deviceAttributesRequest.count)
    pumpMain(seconds: 0.25)
    let reply = recorder.bytes(for: "primary")
    check(
        !reply.isEmpty,
        "the reply-enabled surface produced no write callback — no engine-owned payload to qualify"
    )
    if defect == "retain-callback-pointer" {
        recorder.assertRetainedPointerStillValid()
    }
    emit(stage: "copy-before-return", facts: [
        "replyBytes": reply.count,
        "replyHex": reply.map { String(format: "%02x", $0) }.joined(),
    ])

    // ---- Stage: no-callback-after-free -------------------------------------
    // Feed output right up to the free, free on main, then keep the run loop
    // alive. Any delivery attributed to a surface already marked freed is RED.
    let transient = onMain { makeSurface(app: app, label: "transient", replies: true) }
    var transientSeq: UInt64 = 0
    for _ in 0 ..< 8 {
        onMain { _ = processOutput(transient, deviceAttributesRequest, at: transientSeq) }
        transientSeq += UInt64(deviceAttributesRequest.count)
    }
    onMain {
        recorder.markFreed("transient")
        ghostty_surface_free(transient)
    }
    if defect == "callback-after-free" {
        recorder.injectPostFreeDelivery(label: "transient")
    }
    pumpMain(seconds: 0.35)
    let late = recorder.deliveriesAfterFree()
    check(
        late.isEmpty,
        "\(late.count) callback(s) arrived after ghostty_surface_free: " +
        late.map(\.label).joined(separator: ",")
    )
    emit(stage: "no-callback-after-free", facts: [
        "deliveriesBeforeFree": recorder.snapshot().filter { $0.label == "transient" }.count,
        "deliveriesAfterFree": late.count,
    ])

    // ---- Stage: multi-surface ----------------------------------------------
    // Four live surfaces on one app, each with its own callback context. A
    // reply fed to one must reach only that one: no cross-attribution.
    var fleet: [(label: String, surface: ghostty_surface_t)] = []
    for index in 0 ..< 4 {
        let label = "fleet\(index)"
        fleet.append((label, onMain { makeSurface(app: app, label: label, replies: true) }))
    }
    let baseline = Dictionary(uniqueKeysWithValues: fleet.map { ($0.label, recorder.bytes(for: $0.label).count) })
    onMain { _ = processOutput(fleet[2].surface, deviceAttributesRequest, at: 0) }
    pumpMain(seconds: 0.25)
    for entry in fleet {
        let grew = recorder.bytes(for: entry.label).count > (baseline[entry.label] ?? 0)
        check(
            grew == (entry.label == fleet[2].label),
            "multi-surface cross-attribution: \(entry.label) grew=\(grew) but only \(fleet[2].label) was fed"
        )
    }
    emit(stage: "multi-surface", facts: [
        "surfaces": fleet.count,
        "fedSurface": fleet[2].label,
    ])

    // ---- Stage: inflight-close ---------------------------------------------
    // Close while output is in flight. Production serializes every engine entry
    // on the main queue; the probe does the same, so `free` cannot interleave
    // with `process_output`. The defect drops that serialization and feeds the
    // surface from a background thread concurrently with the free — a real
    // data race for ThreadSanitizer to report.
    let closing = onMain { makeSurface(app: app, label: "closing", replies: true) }
    let feeder = DispatchQueue(label: "gate3.feeder")
    let feedingStopped = DispatchSemaphore(value: 0)
    let stopFeeding = ManagedAtomicFlag()
    var feedCount = 0
    let feedLock = NSLock()
    feeder.async {
        var seq: UInt64 = 0
        while !stopFeeding.isSet {
            if defect == "unserialized-output" {
                // Contract violation on purpose: engine entry off the main
                // thread, unsynchronized with the free below.
                _ = processOutput(closing, deviceAttributesRequest, at: seq)
            } else {
                onMain {
                    guard !stopFeeding.isSet else { return }
                    _ = processOutput(closing, deviceAttributesRequest, at: seq)
                    ghostty_surface_draw(closing)
                }
            }
            seq += UInt64(deviceAttributesRequest.count)
            feedLock.lock(); feedCount += 1; feedLock.unlock()
        }
        feedingStopped.signal()
    }
    pumpMain(seconds: 0.3)
    if defect == "unserialized-output" {
        // Race the free against the still-running background feeder.
        onMain {
            recorder.markFreed("closing")
            ghostty_surface_free(closing)
        }
        stopFeeding.set()
    } else {
        stopFeeding.set()
        feedingStopped.wait()
        onMain {
            recorder.markFreed("closing")
            ghostty_surface_free(closing)
        }
    }
    _ = feedingStopped.wait(timeout: .now() + 2)
    pumpMain(seconds: 0.3)
    let closingLate = recorder.deliveriesAfterFree()
    check(
        closingLate.isEmpty,
        "\(closingLate.count) callback(s) arrived after the in-flight close"
    )
    feedLock.lock()
    let totalFeeds = feedCount
    feedLock.unlock()
    emit(stage: "inflight-close", facts: [
        "outputCallsWhileClosing": totalFeeds,
        "deliveriesAfterFree": closingLate.count,
    ])

    // ---- Stage: rapid-create-free ------------------------------------------
    // Serial create/free churn on the single process-global backend slot. Under
    // ASan this is the leak/UAF stress; the assertion is that every cycle both
    // creates and frees, and that no delivery escapes a freed surface.
    let cycles = 50
    for index in 0 ..< cycles {
        let label = "churn\(index)"
        let churn = onMain { makeSurface(app: app, label: label, replies: true) }
        onMain { _ = processOutput(churn, deviceAttributesRequest, at: 0) }
        onMain {
            recorder.markFreed(label)
            ghostty_surface_free(churn)
        }
    }
    pumpMain(seconds: 0.4)
    let churnLate = recorder.deliveriesAfterFree()
    check(churnLate.isEmpty, "\(churnLate.count) callback(s) escaped a freed surface during churn")
    emit(stage: "rapid-create-free", facts: [
        "cycles": cycles,
        "deliveriesAfterFree": churnLate.count,
    ])

    // ---- Stage: free-ordering ----------------------------------------------
    // surface → app → config. The defect frees the app first, leaving a live
    // surface pointing at freed app state: ASan's expected report.
    var order: [String] = []
    onMain {
        if defect == "free-app-before-surface" {
            order.append("app")
            ghostty_app_free(app)
            order.append("surface")
            for entry in fleet { ghostty_surface_free(entry.surface) }
            ghostty_surface_free(primary)
        } else {
            order.append("surface")
            for entry in fleet {
                recorder.markFreed(entry.label)
                ghostty_surface_free(entry.surface)
            }
            recorder.markFreed("primary")
            ghostty_surface_free(primary)
            order.append("app")
            ghostty_app_free(app)
        }
        order.append("config")
        ghostty_config_free(config)
    }
    check(
        order == ["surface", "app", "config"],
        "free order was \(order.joined(separator: "->")), contract is surface->app->config"
    )
    pumpMain(seconds: 0.2)
    let finalLate = recorder.deliveriesAfterFree()
    check(finalLate.isEmpty, "\(finalLate.count) callback(s) arrived after the app teardown")
    emit(stage: "free-ordering", facts: ["order": order])

    emit(stage: "complete", facts: [
        "totalDeliveries": recorder.snapshot().count,
        "wakeups": wakeupLedger.wakeups,
        "ticks": wakeupLedger.ticks,
        "engineBuildId": String(cString: hive_ghostty_engine_build_id_v1()),
    ])
    Darwin.exit(0)
}

/// Minimal cross-thread flag. NSLock rather than a raw Bool so the green run is
/// clean under ThreadSanitizer and only the deliberate defect races.
private final class ManagedAtomicFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool {
        lock.lock(); defer { lock.unlock() }
        return value
    }
    func set() {
        lock.lock(); value = true; lock.unlock()
    }
}

setbuf(stdout, nil)
emit(stage: "start", facts: ["arch": {
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) }
    }
}()])

// The main thread runs the run loop (production's Ghostty main thread); the
// probe body runs on a worker and marshals every engine call through `onMain`.
// A libdispatch queue rather than a raw `Thread`: an unjoined `Thread` that
// outlives the run is reported by ThreadSanitizer as a thread leak, which would
// put a probe artifact in evidence that has to be explained away.
DispatchQueue(label: "gate3-probe").async { runProbe() }
// A hung probe must not hang the qualification run.
DispatchQueue.main.asyncAfter(deadline: .now() + 300) {
    FileHandle.standardError.write(Data("GATE3_PROBE_TIMEOUT\n".utf8))
    Darwin.exit(2)
}
RunLoop.main.run()
