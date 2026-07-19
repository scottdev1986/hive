import AppKit
import CoreImage
import IOSurface
import XCTest
@testable import HiveTerminalKit

/// Opt-in pixels-on-disk proof for C1 theming and the B2.4 initial resize.
/// Set `HIVE_C1_RENDER_PROOF_PATH` to compile and run this production-surface
/// path without making framebuffer availability part of the default test gate.
@MainActor
final class HiveTerminalVisualProofTests: XCTestCase {
    func testProductionSurfaceWritesC1PNGAtLiveGeometry() throws {
        guard let outputPath = ProcessInfo.processInfo.environment["HIVE_C1_RENDER_PROOF_PATH"],
              !outputPath.isEmpty else {
            throw XCTSkip("set HIVE_C1_RENDER_PROOF_PATH to opt in")
        }

        _ = NSApplication.shared
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 1_200, height: 700),
            viewerId: "c1-offscreen-proof"
        )
        defer { view.userClose() }
        let surface = try XCTUnwrap(view.engine as? GhosttyManualSurface)
        let layer = try XCTUnwrap(view.ghosttyRenderingLayer)
        let geometry = try XCTUnwrap(view.reportedGeometry)
        XCTAssertGreaterThan(geometry.columns, 100)
        XCTAssertGreaterThan(geometry.rows, 30)
        XCTAssertNotEqual([geometry.columns, geometry.rows], [80, 24])

        var surfaceOperations: [(String, GhosttyOperationPhase)] = []
        surface.operationObserver = { surfaceOperations.append(($0, $1)) }

        let host = FakeHost(connectionId: "c1-offscreen-proof")
        let locator = makeTestLocator(sessionSuffix: "c1000000-7bbb-4ccc-8ddd-eeeeeeeeeeee")
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        let content = representativeContent(columns: geometry.columns, rows: geometry.rows)
        host.enqueueOutput(streamSeq: 0, bytes: Data(content.ansi.utf8))

        let outcome = try view.attach(
            grant: host.makeGrant(locator: locator),
            geometry: geometry,
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("expected a first correct production frame, got \(outcome)")
        }
        XCTAssertEqual(
            surfaceOperations.filter { $0.0 == "surfaceUpdateConfig" }.map(\.1),
            [.begin, .end],
            "the composed C1 config must reach the live surface exactly once"
        )

        let snapshot = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertEqual(snapshot.geometry.columns, geometry.columns)
        XCTAssertEqual(snapshot.geometry.rows, geometry.rows)
        for row in content.plainRows {
            XCTAssertTrue(snapshot.text.contains(row), "representative row wrapped or disappeared: \(row)")
        }

        XCTAssertTrue(
            waitUntil(timeout: 3) { layer.contents is IOSurface },
            "Ghostty did not present its production IOSurface"
        )
        let ioSurface = try XCTUnwrap(layer.contents as? IOSurface)
        let image = CIImage(ioSurface: ioSurface)
        let outputURL = URL(fileURLWithPath: outputPath)
        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        try CIContext().writePNGRepresentation(
            of: image,
            to: outputURL,
            format: .RGBA8,
            colorSpace: colorSpace
        )

        let png = try Data(contentsOf: outputURL)
        XCTAssertGreaterThan(png.count, 10_000)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: png))
        XCTAssertEqual(bitmap.pixelsWide, IOSurfaceGetWidth(ioSurface))
        XCTAssertEqual(bitmap.pixelsHigh, IOSurfaceGetHeight(ioSurface))
        assertC1Background(try XCTUnwrap(bitmap.colorAt(x: 3, y: 3)))

        try host.harvestViewerFrames()
        let resize = try XCTUnwrap(
            host.receivedFromViewer.first { $0.type == .resize },
            "the live first frame must send its measured grid to the PTY"
        )
        let resizeObject = try FrameCodec.parseJSONObject(resize.payload)
        let resizeWindow = try XCTUnwrap(resizeObject["window"] as? [String: Any])
        XCTAssertEqual(resizeWindow["columns"] as? Int, geometry.columns)
        XCTAssertEqual(resizeWindow["rows"] as? Int, geometry.rows)
        XCTAssertEqual(resizeWindow["widthPixels"] as? Int, geometry.widthPx)
        XCTAssertEqual(resizeWindow["heightPixels"] as? Int, geometry.heightPx)
        XCTAssertEqual(resizeObject["revision"] as? String, "1")
        XCTAssertEqual(view.resizeFramesSent, 1)
    }

    private func representativeContent(
        columns: Int,
        rows: Int
    ) -> (ansi: String, plainRows: [String]) {
        let columnWidth = min(28, max(20, (columns - 3) / 4))
        let entries = [
            ("workspace/", "34"), ("Sources/", "34"), ("Tests/", "34"), ("Vendor/", "34"),
            ("Package.swift", "36"), ("README.md", "37"), ("hive", "32"), ("terminal.log", "33"),
            ("agent-gene", "35"), ("agent-fiona", "35"), ("sessiond", "32"), ("theme.conf", "36"),
        ]
        var ansiRows: [String] = []
        var plainRows: [String] = []
        for start in stride(from: 0, to: entries.count, by: 4) {
            let group = entries[start ..< min(start + 4, entries.count)]
            let plain = group.map { entry in
                entry.0.padding(toLength: columnWidth, withPad: " ", startingAt: 0)
            }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            let ansi = group.map { entry in
                "\u{1b}[\(entry.1)m\(entry.0)\u{1b}[0m" +
                    String(repeating: " ", count: max(0, columnWidth - entry.0.count))
            }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            XCTAssertLessThan(plain.count, columns)
            plainRows.append(plain)
            ansiRows.append(ansi)
        }

        let title = "HIVE TERMINAL  ·  C1 LIVE RENDER  ·  GRID \(columns)x\(rows)"
        let rule = String(repeating: "─", count: min(columns - 1, 92))
        let footer = "truecolor  •  JetBrains Mono  •  live config  •  measured PTY geometry"
        plainRows.insert(title, at: 0)
        plainRows.append(footer)
        let ansi = [
            "\u{1b}[2J\u{1b}[H\u{1b}[1;38;2;139;233;253m\(title)\u{1b}[0m",
            "\u{1b}[38;2;82;89;112m\(rule)\u{1b}[0m",
            "",
        ] + ansiRows + [
            "",
            "\u{1b}[38;2;166;227;161m✓\u{1b}[0m  \(footer)",
            "",
            "\u{1b}[38;2;246;193;119m$\u{1b}[0m \u{1b}[38;2;248;250;253mready for input\u{1b}[0m",
        ]
        return (ansi.joined(separator: "\r\n"), plainRows)
    }

    private func assertC1Background(_ color: NSColor) {
        let rgb = color.usingColorSpace(.sRGB) ?? color
        XCTAssertEqual(rgb.redComponent, 15.0 / 255.0, accuracy: 0.08)
        XCTAssertEqual(rgb.greenComponent, 17.0 / 255.0, accuracy: 0.08)
        XCTAssertEqual(rgb.blueComponent, 23.0 / 255.0, accuracy: 0.08)
        XCTAssertGreaterThan(rgb.alphaComponent, 0.95)
    }

    private func waitUntil(
        timeout: TimeInterval,
        _ condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        } while Date() < deadline
        return condition()
    }
}
