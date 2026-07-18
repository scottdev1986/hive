import AppKit
import XCTest
@testable import HiveTerminalKit

/// Gate 3 (M1-B1) concurrent surface creation — multi-pane robustness.
///
/// `GhosttyBridgeFactory.makeManualSurface` serializes construction so the
/// Workspace can create panes concurrently without:
/// - HIToolbox TIS abort from concurrent `ghostty_app_new`, or
/// - a second constructor seeing a busy manual-backend install slot
///   (`surfaceFailed`).
///
/// Free is marshaled onto main via `DispatchQueue.main.sync`. The factory
/// MUST release its creation lock before any free — holding the lock across
/// main.sync deadlocks when main is itself waiting to create. These tests
/// pump the run loop with XCTestExpectation (never block main with
/// `DispatchGroup.wait`) so marshaled frees can complete.
final class Gate3ConcurrentCreationTests: XCTestCase {
    override func tearDown() {
        // Always restore the production default if a test flipped the seam.
        GhosttyBridgeFactory.serializeCreation = true
        super.tearDown()
    }

    /// Positive control (GREEN path): N concurrent constructors all succeed
    /// under the factory lock. Regression detector — remove the lock and
    /// this aborts in HIToolbox (measured: SIGABRT / TIS concurrent call)
    /// or returns surfaceFailed.
    func testConcurrentSurfaceCreationAllSucceed() throws {
        let n = 8
        let group = DispatchGroup()
        let resultLock = NSLock()
        var successes = 0
        var failures: [String] = []
        var surfaces: [GhosttyManualSurface] = []
        let start = DispatchSemaphore(value: 0)

        for i in 0..<n {
            DispatchQueue.global(qos: .userInitiated).async(group: group) {
                start.wait()
                do {
                    let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
                    resultLock.lock()
                    surfaces.append(surface)
                    successes += 1
                    resultLock.unlock()
                } catch {
                    resultLock.lock()
                    failures.append("i=\(i): \(error)")
                    resultLock.unlock()
                }
            }
        }
        for _ in 0..<n { start.signal() }

        // Wait off-main via expectation so main can service free/sync work.
        let done = expectation(description: "concurrent creates finished")
        DispatchQueue.global().async {
            group.wait()
            done.fulfill()
        }
        wait(for: [done], timeout: 60)

        XCTAssertEqual(successes, n, "concurrent create failures: \(failures)")
        XCTAssertTrue(failures.isEmpty, "concurrent create failures: \(failures)")

        // Free from background (marshals to main.sync); pump run loop.
        let freed = expectation(description: "frees finished")
        DispatchQueue.global().async {
            for surface in surfaces { surface.free() }
            freed.fulfill()
        }
        wait(for: [freed], timeout: 30)
    }

    /// Deadlock control: concurrent create on background threads while
    /// another surface is freed (main.sync) must complete — proves the
    /// factory does not hold creationLock across free.
    func testConcurrentCreateDoesNotDeadlockWithMarshaledFree() throws {
        let preexisting = try GhosttyBridgeFactory.makeManualSurfaceForTesting()

        let n = 4
        let group = DispatchGroup()
        let resultLock = NSLock()
        var successes = 0
        var failures: [String] = []
        var created: [GhosttyManualSurface] = []
        let start = DispatchSemaphore(value: 0)

        for i in 0..<n {
            DispatchQueue.global(qos: .userInitiated).async(group: group) {
                start.wait()
                do {
                    let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
                    resultLock.lock()
                    created.append(surface)
                    successes += 1
                    resultLock.unlock()
                } catch {
                    resultLock.lock()
                    failures.append("i=\(i): \(error)")
                    resultLock.unlock()
                }
            }
        }
        // One worker frees the preexisting surface while others create.
        DispatchQueue.global(qos: .userInitiated).async(group: group) {
            start.wait()
            preexisting.free()
        }
        for _ in 0..<(n + 1) { start.signal() }

        let done = expectation(description: "create+free finished")
        DispatchQueue.global().async {
            group.wait()
            done.fulfill()
        }
        // Tight-ish timeout: a lock-across-free bug hangs until this fires.
        wait(for: [done], timeout: 30)

        XCTAssertEqual(successes, n, "failures: \(failures)")

        let freed = expectation(description: "cleanup frees")
        DispatchQueue.global().async {
            for surface in created { surface.free() }
            freed.fulfill()
        }
        wait(for: [freed], timeout: 30)
    }

    /// RED-verified positive control for the unlocked regression: with
    /// `serializeCreation = false`, concurrent `ghostty_app_new` aborts in
    /// HIToolbox (TIS concurrent call). Running that unlocked path inside
    /// XCTest would kill the process, so the RED measurement is recorded
    /// here as a documented offline control and the seam itself is asserted
    /// to default-on (so a regression that flips the default is caught).
    ///
    /// Offline measurement (clay, 2026-07-18, fresh env):
    ///   serializeCreation=false + 8 concurrent makeManualSurfaceForTesting
    ///   → process abort SIGABRT, ASI:
    ///   "Text Input Sources or Text Services Manager API is being called
    ///    in two threads concurrently" at ghostty_app_new.
    ///   serializeCreation=true (production) → 8/8 success, stable.
    func testCreationSerializationDefaultsOn() {
        XCTAssertTrue(
            GhosttyBridgeFactory.serializeCreation,
            "creation lock must default on; unlocked concurrent create aborts in TIS"
        )
    }
}
