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
    ///
    /// Second-pass fix (cross-vendor review 2026-07-17): the first version
    /// used `wait(for: [tickStarted])` — an `XCTestExpectation` fulfilled
    /// *inside* the same `DispatchQueue.main.async`-dispatched closure that
    /// then calls `Thread.sleep`. That doesn't work: `wait(for:)` can only
    /// notice a fulfillment by servicing the main run loop, and it can't
    /// service the run loop while that very closure is still running
    /// (synchronous work on a thread isn't preemptible by the run loop it's
    /// blocking). So `wait(for: [tickStarted])` silently waited for the
    /// ENTIRE closure — sleep included — to finish before returning, and
    /// free() was dispatched only after the tick had already ended. This
    /// version signals "tick started" via a `DispatchSemaphore` waited on
    /// from a background thread instead: a semaphore wake-up is a kernel
    /// primitive, not a run-loop notification, so it fires the moment
    /// `signal()` runs on main regardless of what that closure does next.
    /// `free()` is then dispatched from that SAME background thread while
    /// main is still genuinely inside the tick's sleep.
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

        let tickStartedSemaphore = DispatchSemaphore(value: 0)
        owner.wakeupContext.tickOverride = { _ in
            record("tick-start")
            tickStartedSemaphore.signal()
            Thread.sleep(forTimeInterval: 0.2)
            record("tick-end")
        }

        let raceCompleted = expectation(description: "tick/free race sequence completed")
        DispatchQueue.global().async {
            // Trigger the tick asynchronously onto main.
            ghosttyAppWakeupTrampoline(context)

            // Block THIS background thread (not main, not the test's own
            // thread) until the tick has genuinely started on main and is
            // now inside its 0.2s sleep.
            guard tickStartedSemaphore.wait(timeout: .now() + 2) == .success else {
                record("tick-start-timeout")
                raceCompleted.fulfill()
                return
            }

            // Request free while the tick is still in flight. Correct
            // teardown order (surface, then owning app) even under race
            // conditions — freeing the app first leaves the surface
            // referencing a dead app and hangs/crashes independent of the
            // wakeup/tick race this test targets.
            record("free-dispatch")
            surface.free()
            owner.free()
            record("free-completed")
            raceCompleted.fulfill()
        }
        wait(for: [raceCompleted], timeout: 3.0)

        eventsLock.lock()
        let recorded = events
        eventsLock.unlock()

        XCTAssertTrue(recorded.contains("free-dispatch"), "free must have been attempted — recorded \(recorded)")
        XCTAssertTrue(recorded.contains("free-completed"), "free must have completed — recorded \(recorded)")
        guard let tickEndIndex = recorded.firstIndex(of: "tick-end"),
              let freeCompletedIndex = recorded.firstIndex(of: "free-completed") else {
            return XCTFail("expected both tick-end and free-completed — recorded \(recorded)")
        }
        // The actual serialization property: free() must not complete
        // until the in-flight tick has fully finished. If tick/free
        // serialization regresses (e.g. back to copy-pointer-then-unlock-
        // then-call, or freeIfNeeded running inline off-queue), free
        // completes almost immediately after "free-dispatch" — well
        // before "tick-end" — and this goes RED.
        XCTAssertLessThan(tickEndIndex, freeCompletedIndex,
                          "free() completed before the in-flight tick finished — recorded \(recorded)")

        // And the trampoline is now a safe no-op — no further ticks recorded.
        var tickCountAfterFree = 0
        owner.wakeupContext.tickOverride = { _ in tickCountAfterFree += 1 }
        ghosttyAppWakeupTrampoline(context)
        XCTAssertEqual(tickCountAfterFree, 0, "a wakeup arriving after free must not tick again")
    }
}
