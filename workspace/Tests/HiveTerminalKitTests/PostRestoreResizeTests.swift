import AppKit
import XCTest
@testable import HiveTerminalKit

/// Post-restore geometry repair: a checkpoint restore lands the VT core at
/// the checkpoint's (stale) grid while ghostty's embedded `updateSize`
/// early-returns on unchanged framebuffer pixels, so the plain post-attach
/// `setSize` cannot repair the grid. The view must force ONE real resize
/// (pixel nudge, then the real size) so the terminal core adopts the live
/// geometry — the same repair a window drag performs.
final class PostRestoreResizeTests: XCTestCase {
    private let liveSize = ManualSurfaceSize(
        columns: 85,
        rows: 52,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    private func staleSnapshot(columns: Int, rows: Int) -> ManualSurfaceSemanticSnapshot {
        ManualSurfaceSemanticSnapshot(
            generation: 1,
            text: "",
            textUTF16Length: 0,
            visibleRows: [],
            selection: nil,
            cursor: ManualSurfaceSemanticCursor(
                utf16Offset: nil,
                line: nil,
                column: 0,
                row: 0,
                framePixels: .zero,
                isVisible: false,
                isPendingWrap: false
            ),
            viewport: ManualSurfaceSemanticViewport(
                total: 0,
                offset: 0,
                length: 0,
                followsBottom: true
            ),
            geometry: ManualSurfaceSemanticGeometry(
                columns: columns,
                rows: rows,
                widthPixels: 800,
                heightPixels: 480,
                cellWidthPixels: 10,
                cellHeightPixels: 20,
                paddingTopPixels: 0,
                paddingBottomPixels: 0,
                paddingRightPixels: 0,
                paddingLeftPixels: 0
            )
        )
    }

    private func sizeCallDescriptions(_ engine: FakeManualSurface) -> [String] {
        engine.sizeCalls.map { "\($0.0)x\($0.1)" }
    }

    /// The framebuffer size AppKit layout applied (backing-scale dependent),
    /// and the one-pixel nudge the forced resize must precede it with.
    private func appliedAndNudgedSizes(
        _ engine: FakeManualSurface
    ) throws -> (applied: String, nudged: String) {
        let first = try XCTUnwrap(engine.sizeCalls.first, "layout applied a framebuffer size")
        return ("\(first.0)x\(first.1)", "\(first.0 - 1)x\(first.1)")
    }

    private func makeView(engine: FakeManualSurface) -> HiveTerminalView {
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "post-restore-resize"
        )
        // Applies the framebuffer size (engine.setSize) the way AppKit layout
        // would before an attach; reported geometry comes from the fake.
        view.setFrameSize(NSSize(width: 800, height: 480))
        return view
    }

    private func attach(
        _ view: HiveTerminalView,
        host: FakeHost,
        locator: SessionLocator = makeTestLocator(),
        afterSeq: UInt64 = 0
    ) throws {
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        host.enqueueSnapshotEnvelope(throughSeq: afterSeq, enginePayload: Data("snapshot".utf8))
        host.enqueueOutput(streamSeq: afterSeq, bytes: Data("ready".utf8))
        _ = try view.attach(
            grant: host.makeGrant(locator: locator),
            geometry: makeGeometry(),
            afterSeq: afterSeq,
            transport: host.clientTransport
        )
    }

    /// Stale 80x24 semantic grid vs live 85x52 reported geometry: the refresh
    /// must nudge the pixel size (defeating ghostty's unchanged-size early
    /// return) and then restore the real size, and the RESIZE the host
    /// receives must carry the LIVE geometry.
    func testStaleCheckpointGridForcesRealResizeToLiveGeometry() throws {
        let engine = FakeManualSurface()
        engine.fakeReportedSize = liveSize
        // What a stale 80x24 checkpoint restore leaves behind.
        engine.fakeSemanticSnapshot = staleSnapshot(columns: 80, rows: 24)
        let view = makeView(engine: engine)
        let sizes = try appliedAndNudgedSizes(engine)
        XCTAssertEqual(
            sizeCallDescriptions(engine),
            [sizes.applied],
            "layout applies the framebuffer size"
        )

        let host = FakeHost(connectionId: "post-restore-force")
        try attach(view, host: host)

        XCTAssertEqual(
            sizeCallDescriptions(engine).suffix(3),
            [sizes.applied, sizes.nudged, sizes.applied],
            "plain refresh setSize, then one-pixel nudge, then the real size"
        )
        XCTAssertEqual(view.reportedGeometry?.columns, 85)
        XCTAssertEqual(view.reportedGeometry?.rows, 52)

        try host.harvestViewerFrames()
        let resize = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .resize })
        let object = try FrameCodec.parseJSONObject(resize.payload)
        let window = try XCTUnwrap(object["window"] as? [String: Any])
        XCTAssertEqual(window["columns"] as? Int, 85)
        XCTAssertEqual(window["rows"] as? Int, 52)
    }

    /// A matching semantic grid means the checkpoint already reflects the
    /// live geometry — no nudge, just the plain refresh setSize.
    func testMatchingSemanticGridDoesNotForceResize() throws {
        let engine = FakeManualSurface()
        engine.fakeReportedSize = liveSize
        engine.fakeSemanticSnapshot = staleSnapshot(columns: 85, rows: 52)
        let view = makeView(engine: engine)
        let sizes = try appliedAndNudgedSizes(engine)

        let host = FakeHost(connectionId: "post-restore-match")
        try attach(view, host: host)

        XCTAssertEqual(
            sizeCallDescriptions(engine),
            [sizes.applied, sizes.applied],
            "layout size plus the plain refresh — no nudge pair"
        )
    }

    /// No semantic snapshot (e.g. a surface that cannot provide one) must
    /// never trigger the forced resize.
    func testMissingSemanticSnapshotDoesNotForceResize() throws {
        let engine = FakeManualSurface()
        engine.fakeReportedSize = liveSize
        engine.fakeSemanticSnapshot = nil
        let view = makeView(engine: engine)
        let sizes = try appliedAndNudgedSizes(engine)

        let host = FakeHost(connectionId: "post-restore-no-snapshot")
        try attach(view, host: host)

        XCTAssertEqual(sizeCallDescriptions(engine), [sizes.applied, sizes.applied])
    }

    /// The forced resize is one-shot per attach but re-arms on the next one:
    /// a re-attach restoring another stale checkpoint must repair again.
    func testReattachRearmsForcedResize() throws {
        let locator = makeTestLocator()
        let engine = FakeManualSurface()
        engine.fakeReportedSize = liveSize
        engine.fakeSemanticSnapshot = staleSnapshot(columns: 80, rows: 24)
        let view = makeView(engine: engine)

        let sizes = try appliedAndNudgedSizes(engine)
        let hostA = FakeHost(connectionId: "post-restore-first")
        try attach(view, host: hostA, locator: locator)
        XCTAssertEqual(engine.sizeCalls.count, 4, "first attach forced exactly one nudge pair")

        let hostB = FakeHost(connectionId: "post-restore-second")
        try attach(view, host: hostB, locator: locator, afterSeq: view.highWater)
        XCTAssertEqual(
            sizeCallDescriptions(engine).suffix(3),
            [sizes.applied, sizes.nudged, sizes.applied],
            "re-attach re-arms the one-shot forced resize"
        )
    }
}
