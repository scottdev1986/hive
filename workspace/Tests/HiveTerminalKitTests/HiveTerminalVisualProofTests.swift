import AppKit
import CoreImage
import CryptoKit
import IOSurface
import XCTest
@testable import HiveTerminalKit

/// Opt-in pixels-on-disk proof for C1 theming and the B2.4 initial resize.
/// Set `HIVE_C1_RENDER_PROOF_PATH` to compile and run this production-surface
/// path without making framebuffer availability part of the default test gate.
@MainActor
final class HiveTerminalVisualProofTests: XCTestCase {
    func testAuthenticClaudeJournalWritesC11WindowPNG() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let journalPath = environment["HIVE_C11_JOURNAL_PATH"],
              let outputPath = environment["HIVE_C11_RENDER_PROOF_PATH"],
              !journalPath.isEmpty,
              !outputPath.isEmpty else {
            throw XCTSkip("set HIVE_C11_JOURNAL_PATH and HIVE_C11_RENDER_PROOF_PATH to opt in")
        }

        let journal = try Data(contentsOf: URL(fileURLWithPath: journalPath))
        XCTAssertEqual(
            SHA256.hash(data: journal).map { String(format: "%02x", $0) }.joined(),
            "c0ff7ee10c6fab47913de59b25f262b68569a517a95b391686241429a19584ad"
        )
        XCTAssertGreaterThan(journal.count, 16)
        let startSequence = journal.prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        let endSequence = journal.dropFirst(8).prefix(8).reduce(UInt64(0)) {
            ($0 << 8) | UInt64($1)
        }
        let payload = journal.dropFirst(16)
        XCTAssertEqual(endSequence - startSequence, UInt64(payload.count))

        _ = NSApplication.shared
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 1_200, height: 700),
            viewerId: "c11-claude-window-proof"
        )
        defer { view.userClose() }
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Hive C1.1 Typography — Authenticated Claude Journal"
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        defer {
            window.orderOut(nil)
            window.contentView = nil
        }

        let surface = try XCTUnwrap(view.engine as? GhosttyManualSurface)
        surface.setOcclusion(true)
        XCTAssertEqual(
            surface.processOutput(bytes: Data(payload), streamSeq: startSequence),
            .success
        )
        let snapshot = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertTrue(snapshot.text.contains("⏸"))
        XCTAssertTrue(snapshot.text.contains("manual"))
        for _ in 0 ..< 10 {
            surface.draw()
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
        let layer = try XCTUnwrap(view.ghosttyRenderingLayer)
        XCTAssertTrue(waitUntil(timeout: 3) { layer.contents is IOSurface })

        try capture(window: window, at: outputPath)
        let png = try Data(contentsOf: URL(fileURLWithPath: outputPath))
        XCTAssertGreaterThan(png.count, 10_000)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: png))
        assertRepresentativeForeground(bitmap)
    }

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
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.contentView = nil
        }
        let surface = try XCTUnwrap(view.engine as? GhosttyManualSurface)
        surface.setOcclusion(true)
        let layer = try XCTUnwrap(view.ghosttyRenderingLayer)
        let provisionalGeometry = try XCTUnwrap(view.reportedGeometry)
        XCTAssertGreaterThan(provisionalGeometry.columns, 100)
        XCTAssertNotEqual([provisionalGeometry.columns, provisionalGeometry.rows], [80, 24])

        var surfaceOperations: [(String, GhosttyOperationPhase)] = []
        var drawStates: [TerminalSurfaceState] = []
        surface.operationObserver = { operation, phase in
            surfaceOperations.append((operation, phase))
            if operation == "draw" { drawStates.append(view.surfaceState) }
        }
        var callbackState: TerminalSurfaceState?
        view.onFirstCorrectFrame = { _ in callbackState = view.surfaceState }

        let host = FakeHost(connectionId: "c1-offscreen-proof")
        let locator = makeTestLocator(sessionSuffix: "c1000000-7bbb-4ccc-8ddd-eeeeeeeeeeee")
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        host.enqueueOutput(streamSeq: 0, bytes: Data("\u{1b}[2J\u{1b}[H".utf8))

        let outcome = try view.attach(
            grant: host.makeGrant(locator: locator),
            geometry: provisionalGeometry,
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("expected a first correct production frame, got \(outcome)")
        }
        XCTAssertEqual(view.surfaceState, .attaching)
        XCTAssertEqual(view.resizeFramesSent, 0)
        XCTAssertEqual(
            surfaceOperations.filter { $0.0 == "surfaceUpdateConfig" }.map(\.1),
            [.begin, .end],
            "the composed C1 config must reach the live surface exactly once"
        )
        XCTAssertTrue(
            waitUntil(timeout: 3) { view.surfaceState == .live },
            "the live surface did not finalize after Ghostty's deferred config tick"
        )
        XCTAssertEqual(callbackState, .live)
        XCTAssertEqual(view.resizeFramesSent, 1)

        let geometry = try XCTUnwrap(view.reportedGeometry)
        XCTAssertGreaterThan(geometry.columns, 80)
        XCTAssertGreaterThan(geometry.rows, 24)
        let content = representativeContent(columns: geometry.columns, rows: geometry.rows)
        let binding = try XCTUnwrap(view.binding)
        view.pumpHostFrame(
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: view.highWater,
                payload: Data(content.ansi.utf8)
            ),
            frameBinding: binding
        )
        surface.draw()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertTrue(drawStates.allSatisfy { $0 == .live })

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
        assertRepresentativeForeground(bitmap)

        try host.harvestViewerFrames()
        XCTAssertEqual(host.receivedFromViewer.filter { $0.type == .resize }.count, 1)
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

    private func assertRepresentativeForeground(_ bitmap: NSBitmapImageRep) {
        var foregroundSamples = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 4) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 4) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if color.redComponent > 0.25 || color.greenComponent > 0.25 || color.blueComponent > 0.25 {
                    foregroundSamples += 1
                }
            }
        }
        XCTAssertGreaterThan(foregroundSamples, 500, "PNG contains only the C1 background")
    }

    private func capture(window: NSWindow, at path: String) throws {
        let outputURL = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(window.windowNumber), path]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
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
