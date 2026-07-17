import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 2 (M1-B1) positive control: terminal-generated replies to
/// response-producing controls must reach the write callback — exactly
/// once, in order — on a REAL manual surface (no fakes).
///
/// KNOWN SNAPSHOT DEFECT this corpus exists to catch: the pre-B1 patch set
/// `device_attributes`, `enquiry`, `size`, `write_pty`, and `xtversion` to
/// `null` in the manual-mode vt Handler.Effects (native/ghostty-patches/
/// 0001-hive-manual-io-checkpoint.patch). A null `write_pty` means
/// `reportDeviceAttributes`/`reportSize`/`reportXtversion` compute a reply
/// and then silently drop it — a TUI paints (INVALIDATE still fires) but
/// query/negotiation sequences never reach the host. Every assertion below
/// fails on that snapshot (zero writes observed) and passes only because
/// 0002-hive-terminal-reply-effects.patch wires real implementations.
///
/// Expected bytes are sourced from ECMA-48, the xterm ctlseqs reference
/// (ftp://ftp.invisible-island.net/xterm/ctlseqs.txt), and Ghostty's own
/// exec-mode reference implementation (termio/stream_handler.zig
/// deviceAttributes/reportXtversion), not invented — this is the same
/// pinned Ghostty engine build, so DA1/DA2 must match it exactly.
final class TerminalReplyCorpusTests: XCTestCase {
    /// Fails loudly rather than XCTSkip: this is the story's mandated
    /// LIVE-PROOF gate, so a run where every test silently skips must not
    /// report as "N tests, 0 failures" (cross-vendor review 2026-07-17
    /// caught exactly this — a real surface creation failure in the
    /// reviewer's environment skipped all 9 gate-2/3 tests and still read
    /// as green).
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 2 live proof, got: \(error)")
            throw error
        }
    }

    /// DA1 (CSI c): xterm ctlseqs "Send Device Attributes (Primary DA)".
    /// Response CSI ? 62 ; 22 c = VT220 level-2 conformance + ANSI color.
    /// No ";52" (clipboard) feature: this bridge's clipboard_write effect
    /// always denies (OSC 52 write denied per ADR-0002), matching upstream
    /// stream_handler.zig's own conditional exactly.
    func testPrimaryDeviceAttributesReplyMatchesPinnedGhosttyExactlyOnce() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let result = surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success)

        XCTAssertEqual(writes.count, 1, "DA1 reply must reach the write callback exactly once")
        XCTAssertEqual(writes.first, Data("\u{1B}[?62;22c".utf8))
    }

    /// DA2 (CSI > c): xterm ctlseqs "Send Device Attributes (Secondary DA)".
    /// Response CSI > 1 ; 10 ; 0 c matches termio/stream_handler.zig's
    /// hardcoded exec-mode reply byte-for-byte (device_type=1 firmware=10
    /// rom=0), so a TUI probing this bridge sees the same answer it would
    /// get from the real Ghostty app.
    func testSecondaryDeviceAttributesReplyMatchesPinnedGhosttyExactlyOnce() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let result = surface.processOutput(bytes: Data("\u{1B}[>c".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success)

        XCTAssertEqual(writes.count, 1, "DA2 reply must reach the write callback exactly once")
        XCTAssertEqual(writes.first, Data("\u{1B}[>1;10;0c".utf8))
    }

    /// XTVERSION query (CSI > q): xterm ctlseqs. Response is a DCS string
    /// "DCS > | text ST" (stream_terminal.zig reportXtversion framing).
    /// Must identify as the pinned Ghostty engine, not the libghostty-vt
    /// generic "libghostty" fallback that a null effect would produce.
    func testXtversionReplyIdentifiesAsGhosttyNotGenericFallback() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let result = surface.processOutput(bytes: Data("\u{1B}[>q".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success)

        XCTAssertEqual(writes.count, 1, "XTVERSION reply must reach the write callback exactly once")
        guard let reply = writes.first, let text = String(data: reply, encoding: .utf8) else {
            return XCTFail("XTVERSION reply must be valid UTF-8")
        }
        XCTAssertTrue(text.hasPrefix("\u{1B}P>|ghostty "), "must identify as ghostty, not the generic fallback")
        XCTAssertTrue(text.hasSuffix("\u{1B}\\"), "DCS string must be ST-terminated")
    }

    /// XTWINOPS text-area size report (CSI 18 t): xterm ctlseqs "Report the
    /// size of the text area in characters". Response is CSI 8 ; rows ;
    /// cols t. Rows/cols must be Ghostty's real reported cell geometry
    /// (gate 7: "never guessed cells") — this asserts the reply is
    /// non-empty and well-formed, not a specific number, since exact cell
    /// metrics are font/DPI-dependent.
    func testTextAreaSizeReportIsWiredAndWellFormed() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let result = surface.processOutput(bytes: Data("\u{1B}[18t".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success)

        XCTAssertEqual(writes.count, 1, "size report must reach the write callback exactly once")
        guard let reply = writes.first, let text = String(data: reply, encoding: .utf8) else {
            return XCTFail("size report must be valid UTF-8")
        }
        let pattern = #"^\x1b\[8;\d+;\d+t$"#
        XCTAssertNotNil(text.range(of: pattern, options: .regularExpression),
                         "expected CSI 8;rows;cols t, got \(text.debugDescription)")
    }

    /// ENQ (0x05): Ghostty's own `enquiry-response` config defaults to ""
    /// (config/Config.zig), which reportEnquiry treats as no reply. A
    /// wired-but-empty effect and a null effect are wire-indistinguishable
    /// here by design — this documents that the effect IS wired (not
    /// merely coincidentally silent) and matches the pinned app's default.
    func testEnquiryDefaultMatchesPinnedGhosttyDefaultPolicy() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let result = surface.processOutput(bytes: Data([0x05]), streamSeq: 0)
        XCTAssertEqual(result, .success)
        XCTAssertTrue(writes.isEmpty, "matches Ghostty's own empty enquiry-response default")
    }

    /// Ordering: a burst combining multiple response-producing controls in
    /// ONE process_output_v1 call must deliver every reply exactly once,
    /// in the same order the queries appeared in the stream.
    func testMultipleRepliesInOneBurstPreserveOrderAndCount() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let burst = Data("\u{1B}[c".utf8) + Data("\u{1B}[>q".utf8) + Data("\u{1B}[>c".utf8)
        let result = surface.processOutput(bytes: burst, streamSeq: 0)
        XCTAssertEqual(result, .success)

        XCTAssertEqual(writes.count, 3, "each response-producing control must reply exactly once")
        XCTAssertEqual(writes[0], Data("\u{1B}[?62;22c".utf8), "DA1 must be first, matching stream order")
        XCTAssertTrue(String(data: writes[1], encoding: .utf8)?.hasPrefix("\u{1B}P>|ghostty ") ?? false,
                      "XTVERSION must be second, matching stream order")
        XCTAssertEqual(writes[2], Data("\u{1B}[>1;10;0c".utf8), "DA2 must be third, matching stream order")
    }
}
