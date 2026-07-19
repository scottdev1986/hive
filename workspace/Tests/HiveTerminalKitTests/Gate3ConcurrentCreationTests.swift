import AppKit
import XCTest
@testable import HiveTerminalKit

/// Gate 3 (M1-B1) concurrent surface creation — multi-pane robustness.
///
/// `GhosttyBridgeFactory.makeManualSurface` admits construction to the main
/// queue so the Workspace can create panes concurrently without:
/// - HIToolbox TIS abort from concurrent `ghostty_app_new`, or
/// - a second constructor seeing a busy manual-backend install slot
///   (`surfaceFailed`).
///
/// Free uses that same main-queue operation domain. No independent creation
/// lock is needed, so there is no Swift-lock/renderer-mutex inversion. These
/// tests pump the run loop with XCTestExpectation (never block main with
/// `DispatchGroup.wait`) so marshaled work can complete.
final class Gate3ConcurrentCreationTests: XCTestCase {
    /// Positive control (GREEN path): N concurrent callers all succeed after
    /// the factory admits each complete constructor to the main queue.
    /// Removing that admission aborts in HIToolbox (measured: SIGABRT / TIS
    /// concurrent call) or returns surfaceFailed.
    func testConcurrentSurfaceCreationAllSucceed() throws {
        var constructionWasMain = true
        GhosttyBridgeFactory.creationObserver = { _ in
            constructionWasMain = constructionWasMain && Thread.isMainThread
        }
        defer { GhosttyBridgeFactory.creationObserver = nil }
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
        XCTAssertTrue(constructionWasMain, "every native construction entry must execute on main")
        XCTAssertEqual(GhosttyBridgeFactory.initializationCount, 1,
                       "Ghostty's single process-global state must never be reinitialized per surface")

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
    /// factory does not hold a secondary lock across free.
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

    func testBackgroundFactoryCallerRunsEveryNativeEntryOnMain() throws {
        var observed: [(String, Bool)] = []
        GhosttyBridgeFactory.creationObserver = { operation in
            observed.append((operation, Thread.isMainThread))
        }
        defer { GhosttyBridgeFactory.creationObserver = nil }

        var created: GhosttyManualSurface?
        let done = expectation(description: "background create/free")
        DispatchQueue.global().async {
            created = try? GhosttyBridgeFactory.makeManualSurfaceForTesting()
            created?.free()
            done.fulfill()
        }
        wait(for: [done], timeout: 10)

        XCTAssertEqual(
            observed.map(\.0).filter { $0 != "init" },
            ["configNew", "appNew", "surfaceNew", "surfaceUpdateConfig"]
        )
        XCTAssertTrue(observed.allSatisfy(\.1))
    }

    func testRapidBackgroundCreateFreeCyclesRemainSerialized() {
        let cycles = 32
        var failures: [String] = []
        let lock = NSLock()
        let done = expectation(description: "rapid create/free cycles")

        DispatchQueue.global(qos: .userInitiated).async {
            for cycle in 0..<cycles {
                do {
                    let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
                    surface.free()
                } catch {
                    lock.lock()
                    failures.append("cycle=\(cycle): \(error)")
                    lock.unlock()
                }
            }
            done.fulfill()
        }
        wait(for: [done], timeout: 60)

        XCTAssertTrue(failures.isEmpty, "rapid create/free failures: \(failures)")
    }
}
