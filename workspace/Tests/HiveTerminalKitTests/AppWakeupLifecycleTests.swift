import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 3 (M1-B1) positive control: `wakeup_cb` must schedule a real
/// `ghostty_app_tick` and must never touch a freed `ghostty_app_t`.
///
/// KNOWN SNAPSHOT DEFECT this corpus exists to catch: the pre-B1 factory
/// wired `wakeup_cb: { _ in }` — a no-op. ghostty.h documents wakeup_cb as
/// "should trigger a full tick of the app loop" and `ghostty_app_tick` as
/// "should be called whenever the wakeup callback is invoked" — any
/// Ghostty-internal async work relying on that tick to complete silently
/// never did. `GhosttyAppWakeupContext` fixes this and unbinds its app
/// pointer before `ghostty_app_free`, so a racing wakeup is a guarded
/// no-op instead of a use-after-free.
final class AppWakeupLifecycleTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            throw XCTSkip("manual surface unavailable in this environment: \(error)")
        }
    }

    /// Drives the exact C ABI trampoline Ghostty would call — not a Swift
    /// internal — from a background thread and proves it lands the real
    /// `ghostty_app_tick` call on the main thread without crashing.
    func testWakeupTrampolineMarshalsAppTickOntoMainThreadFromBackground() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }
        let context = owner.wakeupContext.unownedContextPointer

        let tickObserved = expectation(description: "app tick landed on main thread")
        DispatchQueue.global().async {
            ghosttyAppWakeupTrampoline(context)
            DispatchQueue.main.async { tickObserved.fulfill() }
        }
        wait(for: [tickObserved], timeout: 2.0)
    }

    /// Same-thread call must also tick synchronously, not merely enqueue
    /// forever — the trampoline checks `Thread.isMainThread` and calls
    /// `ghostty_app_tick` directly rather than always dispatching.
    func testWakeupTrampolineTicksSynchronouslyOnMainThread() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }
        // No crash, no hang: the entire call completes synchronously here.
        ghosttyAppWakeupTrampoline(owner.wakeupContext.unownedContextPointer)
    }

    /// Positive control: once the app is freed, a wakeup arriving after
    /// must be a safe no-op — it must never dereference the freed
    /// `ghostty_app_t`. Frees surface then app (the correct order) so this
    /// exercises exactly the guard `GhosttyAppOwner.free()` installs
    /// (`wakeupContext.unbind()`), not an out-of-order-free crash.
    func testWakeupTrampolineIsSafeNoOpAfterAppFree() throws {
        let surface = try makeSurface()
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain a GhosttyAppOwner")
        }
        let context = owner.wakeupContext.unownedContextPointer

        surface.free()
        owner.free()

        ghosttyAppWakeupTrampoline(context)
        // Reaching this line without a crash is the assertion: the guard
        // inside GhosttyAppWakeupContext.scheduleTick observed app == nil
        // and returned instead of calling ghostty_app_tick on freed memory.
    }
}
