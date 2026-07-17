import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 3 (M1-B1) positive control: `wakeup_cb` must schedule a REAL
/// `ghostty_app_tick` — observed actually firing, on the right thread,
/// with the right app pointer — and must never race a concurrent free.
///
/// Cross-vendor review (2026-07-17) found the first version of this file
/// insufficient: it only asserted `scheduleTick`/the trampoline returned
/// without crashing, which stays green even if `wakeup_cb` regresses to a
/// no-op, and it drove the Swift trampoline directly so the FACTORY's own
/// wiring (`ghostty_runtime_config_s.wakeup_cb`/`userdata`) could regress
/// undetected. It also only tested "free, then wakeup" — never a tick
/// genuinely in flight while free is requested. This version fixes all
/// three: `testFactory...` inspects the real config the factory builds;
/// `GhosttyAppWakeupContext.tickOverride` is a spy seam that proves a real
/// tick call happened (RED if the trampoline becomes a no-op); and
/// `testFreeWaitsForInFlightTick...` races an in-flight tick against a
/// concurrent free and asserts strict ordering, not just absence of a crash.
///
/// `makeSurface()` fails loudly (XCTFail) rather than XCTSkip when the real
/// surface can't be created — a fully-skipped suite reports as "passed" in
/// XCTest's summary, which is exactly the false-green this gate exists to
/// prevent (matches the review finding on TerminalReplyCorpusTests too).
final class AppWakeupLifecycleTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 3 live proof, got: \(error)")
            throw error
        }
    }

    /// Closes the "factory wiring can regress undetected" gap: inspects the
    /// REAL `ghostty_runtime_config_s` the factory builds (the same
    /// `makeRuntimeConfig` `makeManualSurface` itself calls), not just the
    /// trampoline function in isolation.
    func testFactoryWiresTheRealTrampolineAndContext() {
        let context = GhosttyAppWakeupContext()
        let config = GhosttyBridgeFactory.makeRuntimeConfig(wakeupContext: context)

        XCTAssertEqual(config.userdata, context.unownedContextPointer,
                       "runtime userdata must be this context, not some other/no context")

        func rawPointer(of fn: ghostty_runtime_wakeup_cb) -> UnsafeRawPointer {
            unsafeBitCast(fn, to: UnsafeRawPointer.self)
        }
        XCTAssertEqual(rawPointer(of: config.wakeup_cb), rawPointer(of: ghosttyAppWakeupTrampoline),
                       "wakeup_cb must be the real trampoline, not a stub/no-op closure")
    }

    /// The actual positive control review asked for: prove a tick REALLY
    /// executes, on the right thread, with the right app pointer — not
    /// merely that the call returns. Uses `tickOverride` as a spy on the
    /// real `ghostty_app_tick` call site; this goes RED if `scheduleTick`
    /// or the trampoline ever stops calling through to it.
    func testWakeupTrampolineActuallyInvokesTickOnMainThreadWithRealAppPointer() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }

        var observedApp: ghostty_app_t?
        var observedOnMain = false
        let ticked = expectation(description: "real tick observed")
        // Ghostty's own internals can call wakeup_cb spontaneously (e.g.
        // background timers), independent of the explicit trigger below —
        // observed while developing this test. Every firing must still be
        // on-main with the real app pointer, so allow more than one.
        ticked.assertForOverFulfill = false
        owner.wakeupContext.tickOverride = { app in
            observedApp = app
            observedOnMain = Thread.isMainThread
            ticked.fulfill()
        }

        DispatchQueue.global().async {
            ghosttyAppWakeupTrampoline(owner.wakeupContext.unownedContextPointer)
        }
        wait(for: [ticked], timeout: 2.0)

        XCTAssertTrue(observedOnMain, "the tick must execute on the main thread")
        XCTAssertEqual(observedApp, owner.app, "the tick must receive the real owning app's handle")
    }

    /// Same-thread call must tick synchronously, not merely enqueue
    /// forever — the trampoline checks `Thread.isMainThread` and calls
    /// through directly rather than always dispatching.
    func testWakeupTrampolineTicksSynchronouslyOnMainThread() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }

        var ticked = false
        owner.wakeupContext.tickOverride = { _ in ticked = true }
        ghosttyAppWakeupTrampoline(owner.wakeupContext.unownedContextPointer)
        XCTAssertTrue(ticked, "an on-main call must tick before returning, not merely enqueue")
    }

    /// Positive control: once freed, a wakeup arriving after must be a
    /// safe no-op that never invokes tick at all — observed via the spy,
    /// not inferred from the absence of a crash.
    func testWakeupTrampolineDoesNotTickAfterFree() throws {
        let surface = try makeSurface()
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }

        surface.free()
        owner.free()

        // Installed only after free, so any pre-free spontaneous Ghostty
        // wakeup (observed while developing this suite) can't be mistaken
        // for a post-free violation — only calls from here on count.
        var tickCountAfterFree = 0
        owner.wakeupContext.tickOverride = { _ in tickCountAfterFree += 1 }

        ghosttyAppWakeupTrampoline(owner.wakeupContext.unownedContextPointer)
        XCTAssertEqual(tickCountAfterFree, 0, "a wakeup after free must never reach ghostty_app_tick")
    }

    /// The race the first version of this suite didn't cover: a tick
    /// genuinely IN FLIGHT (not "free happened first, then a wakeup
    /// arrives") concurrent with a free requested from another thread.
    /// `tickOverride` sleeps mid-tick to hold the main queue's current
    /// work item open; `free()` is dispatched from a background thread so
    /// its `DispatchQueue.main.sync` genuinely queues behind it instead of
    /// racing inline. If tick/free serialization ever regresses (e.g. back
    /// to copy-pointer-then-unlock-then-call), this observes free
    /// completing (or the app pointer going nil) WHILE the tick is still
    /// recorded as running, and fails.
    func testFreeWaitsForInFlightTickToFinishBeforeFreeing() throws {
        let surface = try makeSurface()
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }
        let context = owner.wakeupContext.unownedContextPointer

        let eventsLock = NSLock()
        var events: [String] = []
        func record(_ event: String) {
            eventsLock.lock(); events.append(event); eventsLock.unlock()
        }

        let tickStarted = expectation(description: "tick started")
        // Ghostty's own internals can call wakeup_cb spontaneously (see
        // testWakeupTrampolineActuallyInvokesTick...), so more than one
        // start/end pair may legitimately be recorded before or after the
        // one this test deliberately triggers.
        tickStarted.assertForOverFulfill = false
        owner.wakeupContext.tickOverride = { _ in
            record("tick-start")
            tickStarted.fulfill()
            Thread.sleep(forTimeInterval: 0.2)
            record("tick-end")
        }

        DispatchQueue.global().async {
            ghosttyAppWakeupTrampoline(context)
        }
        wait(for: [tickStarted], timeout: 2.0)

        // Correct teardown order (surface, then owning app) even under
        // race conditions — freeing the app first leaves the surface
        // referencing a dead app and hangs/crashes independent of the
        // wakeup/tick race this test targets.
        let freeCompleted = expectation(description: "free completed")
        DispatchQueue.global().async {
            surface.free()
            owner.free()
            freeCompleted.fulfill()
        }
        wait(for: [freeCompleted], timeout: 2.0)

        eventsLock.lock()
        let recorded = events
        eventsLock.unlock()
        // Ordering property, not an exact transcript (spontaneous extra
        // ticks are legitimate — see above): every tick that started must
        // have finished, and the log must not end mid-tick. If tick/free
        // serialization ever regresses, free() can complete while the
        // main-queue tick closure is still inside its sleep, and this
        // observes the log ending on "tick-start" instead of "tick-end".
        XCTAssertFalse(recorded.isEmpty, "expected at least the deliberately-triggered tick to be recorded")
        XCTAssertEqual(recorded.last, "tick-end",
                       "free() must not complete while a tick is still in flight — recorded \(recorded)")
        let starts = recorded.filter { $0 == "tick-start" }.count
        let ends = recorded.filter { $0 == "tick-end" }.count
        XCTAssertEqual(starts, ends, "every tick that started must have finished before free completed — recorded \(recorded)")

        // And the trampoline is now a safe no-op — no further ticks recorded.
        var tickCountAfterFree = 0
        owner.wakeupContext.tickOverride = { _ in tickCountAfterFree += 1 }
        ghosttyAppWakeupTrampoline(context)
        XCTAssertEqual(tickCountAfterFree, 0, "a wakeup arriving after free must not tick again")
    }
}
