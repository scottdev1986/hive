import AppKit
import XCTest
@testable import HiveTerminalKit

final class OwnedSurfaceTests: XCTestCase {
    func testOwnedSurfaceExecsAChild() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-owned-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeOwnedSurfaceForTesting(
                workingDirectory: directory.path
            )
        } catch {
            throw XCTSkip("owned Ghostty surface unavailable: \(error)")
        }
        defer { surface.free() }

        XCTAssertNotNil(surface.surfaceHandle)
        var pid: UInt64 = 0
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            pid = surface.foregroundPID()
            if pid != 0 { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertNotEqual(pid, 0, "stock Ghostty surface must own a PTY child")
    }

    func testHiveTerminalViewLaunchInitDoesNotAttach() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-view-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let view: HiveTerminalView
        do {
            view = try HiveTerminalView(
                frame: NSRect(x: 0, y: 0, width: 400, height: 240),
                launch: .loginShell(workingDirectory: directory.path)
            )
        } catch {
            throw XCTSkip("owned HiveTerminalView unavailable: \(error)")
        }
        XCTAssertEqual(view.surfaceState, .live)
        view.userClose()
    }
}
