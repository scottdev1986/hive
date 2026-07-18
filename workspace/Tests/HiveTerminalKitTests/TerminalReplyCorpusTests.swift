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

    /// OSC 52 clipboard READ policy (story:14 requires it stated
    /// explicitly; gate 9 security surface): an agent's output stream must
    /// never read the host clipboard. A permissive terminal answers
    /// `OSC 52 ; c ; ? ST` with the clipboard contents base64-encoded —
    /// host-data exfiltration by untrusted bytes. Hive's policy is DENY:
    /// read_clipboard_cb returns false, and the protocol-visible behavior
    /// is silence (the requesting TUI gets no reply). A clipboard-read
    /// reply would arrive asynchronously via the io thread (same delivery
    /// as key encodings), so this drains the run loop before asserting
    /// emptiness — without the drain, "no bytes" would be vacuous.
    func testOSC52ClipboardReadIsDeniedNoReplyEver() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let writesLock = NSLock()
        var writes: [Data] = []
        surface.callbackContext.onWrite = { data in
            writesLock.lock(); writes.append(data); writesLock.unlock()
        }

        // OSC 52, clipboard 'c', '?' = read request, BEL-terminated; then
        // ST-terminated variant for completeness.
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}]52;c;?\u{07}".utf8), streamSeq: 0), .success)
        let second = Data("\u{1B}]52;c;?\u{1B}\\".utf8)
        XCTAssertEqual(surface.processOutput(bytes: second, streamSeq: 9), .success)

        // Drain: give any (wrongly) queued async reply its chance to land.
        let deadline = Date().addingTimeInterval(0.3)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            Thread.sleep(forTimeInterval: 0.01)
        }

        writesLock.lock()
        let observed = writes
        writesLock.unlock()
        XCTAssertTrue(observed.isEmpty,
                      "an OSC 52 read must never produce a reply — host clipboard bytes would be " +
                      "exfiltrated into the agent's input stream; got \(observed)")

        // Positive control for the observation channel: the surface still
        // answers a legitimate query through the same callback, so the
        // emptiness above is a real denial, not a broken write path.
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: 9 + UInt64(second.count)), .success)
        writesLock.lock()
        let after = writes
        writesLock.unlock()
        XCTAssertEqual(after, [Data("\u{1B}[?62;22c".utf8)],
                       "DA1 must still answer — proving the write channel was live while OSC 52 stayed silent")
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

    /// DCS queries use the same stream parser as CSI/OSC. The pre-gate
    /// manual path discarded dcs_hook/dcs_put/dcs_unhook, so these produced
    /// no bytes even though Ghostty's exec-mode handler supports both.
    func testDCSRepliesMatchPinnedGhosttyExactlyOnceAndInOrder() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let decrqss = Data("\u{1B}P$qm\u{1B}\\".utf8)
        let xtgettcap = Data("\u{1B}P+q544E\u{1B}\\".utf8) // TN
        XCTAssertEqual(
            surface.processOutput(bytes: decrqss + xtgettcap, streamSeq: 0),
            .success
        )

        XCTAssertEqual(writes, [
            Data("\u{1B}P1$r0m\u{1B}\\".utf8),
            Data("\u{1B}P1+r544E=67686F73747479\u{1B}\\".utf8),
        ], "DECRQSS then XTGETTCAP must each reply once in parser order")
    }
}
