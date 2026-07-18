import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 9 (M1-B1): action/security matrix controls.
/// Policy source: planning/gate9-action-security-matrix.md + queen rulings
/// 2026-07-18 (strip B-class keybinds; deny SECURE_INPUT; bridge-deny
/// DESKTOP_NOTIFICATION).
final class Gate9ActionPolicyTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 9 live proof, got: \(error)")
            throw error
        }
    }

    /// Parses ONLY the `ghostty_action_tag_e` enum block out of the PINNED
    /// vendored header and counts its members. Cross-vendor review
    /// (2026-07-18) corrected the earlier claim that publicHeaderSha256
    /// guarded this — that pin hashes the BRIDGE header, which has no action
    /// enum, so a bump appending tag 66 passed every check. This reads the
    /// real enum from vendor/ghostty/include/ghostty.h (itself pinned by the
    /// tree hash in ghostty-upstream-tree.txt), so a new tag changes this
    /// count and turns the completeness test RED.
    private func pinnedActionEnumMemberCount() throws -> Int {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveTerminalKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // workspace
            .deletingLastPathComponent() // repo root
        let header = repoRoot.appendingPathComponent("vendor/ghostty/include/ghostty.h")
        let text = try String(contentsOf: header, encoding: .utf8)
        guard let closeRange = text.range(of: "} ghostty_action_tag_e;") else {
            XCTFail("ghostty_action_tag_e not found in pinned header \(header.path)")
            return -1
        }
        let head = String(text[text.startIndex..<closeRange.lowerBound])
        guard let openRange = head.range(of: "typedef enum {", options: .backwards) else {
            XCTFail("action enum opening brace not found before ghostty_action_tag_e")
            return -1
        }
        let block = String(head[openRange.upperBound...])
        // Each enumerator name appears exactly once inside the block.
        return block.components(separatedBy: "GHOSTTY_ACTION_").count - 1
    }

    private var classifiedSetCount: Int {
        HiveGhosttyActionPolicy.handledByEffectsTags.count
            + HiveGhosttyActionPolicy.deniedPolicyTags.count
            + HiveGhosttyActionPolicy.deniedGestureTags.count
            + HiveGhosttyActionPolicy.engineInertTags.count
    }

    /// Completeness: every tag value at the pinned header (0..<count) has
    /// exactly one verdict; the first value past the range has none; and the
    /// classified-set size EQUALS the member count parsed live from the
    /// pinned action enum — so an upstream bump that appends a tag turns
    /// this RED and demands a verdict.
    func testEveryPinnedActionTagHasExactlyOneVerdictAndMatchesTheHeader() throws {
        let pinnedCount = try pinnedActionEnumMemberCount()
        XCTAssertEqual(pinnedCount, classifiedSetCount,
                       "the number of GHOSTTY_ACTION_ tags in the pinned enum (\(pinnedCount)) must equal the " +
                       "classified-set size (\(classifiedSetCount)); a mismatch means upstream changed the enum " +
                       "and a tag lost/needs its verdict")
        XCTAssertEqual(GHOSTTY_ACTION_COPY_TITLE_TO_CLIPBOARD.rawValue, UInt32(pinnedCount - 1),
                       "last pinned tag must be \(pinnedCount - 1)")
        for raw in 0..<UInt32(pinnedCount) {
            let tag = ghostty_action_tag_e(rawValue: raw)
            let memberships = [
                HiveGhosttyActionPolicy.handledByEffectsTags.contains(where: { $0 == tag }),
                HiveGhosttyActionPolicy.deniedPolicyTags.contains(where: { $0 == tag }),
                HiveGhosttyActionPolicy.deniedGestureTags.contains(where: { $0 == tag }),
                HiveGhosttyActionPolicy.engineInertTags.contains(where: { $0 == tag }),
            ].filter { $0 }.count
            XCTAssertEqual(memberships, 1,
                           "tag rawValue \(raw) must be classified in exactly one category, got \(memberships)")
            XCTAssertNotNil(HiveGhosttyActionPolicy.classify(tag))
        }
        XCTAssertNil(HiveGhosttyActionPolicy.classify(ghostty_action_tag_e(rawValue: UInt32(pinnedCount))),
                     "a value past the pinned range must be unclassified — no silent catch-all")
    }

    /// Security rulings are pinned as data: a rewrite that reclassifies
    /// (say) DESKTOP_NOTIFICATION as handled goes RED here.
    func testSecurityRulingsArePinned() {
        XCTAssertEqual(HiveGhosttyActionPolicy.classify(GHOSTTY_ACTION_DESKTOP_NOTIFICATION), .deniedPolicy)
        XCTAssertEqual(HiveGhosttyActionPolicy.classify(GHOSTTY_ACTION_SECURE_INPUT), .deniedPolicy)
        XCTAssertEqual(HiveGhosttyActionPolicy.classify(GHOSTTY_ACTION_OPEN_URL), .deniedPolicy)
        XCTAssertEqual(HiveGhosttyActionPolicy.classify(GHOSTTY_ACTION_SET_TITLE), .handledByEffects)
        XCTAssertEqual(HiveGhosttyActionPolicy.classify(GHOSTTY_ACTION_QUIT), .deniedGesture)
    }

    /// BEHAVIOR, not the table (cross-vendor review 2026-07-18): the earlier
    /// controls asserted classify() the data table while handle() discarded
    /// the verdict and blanket-returned false. This drives the REAL callback
    /// body for one representative of each verdict and asserts the spy
    /// observed the verdict handle ROUTED it through — RED if handle
    /// regresses to a blanket false that ignores classify().
    func testHandleRoutesThroughTheVerdictNotABlanketFalse() {
        var seen: [(UInt32, HiveGhosttyActionPolicy.Verdict?)] = []
        HiveGhosttyActionPolicy.setObserver { seen.append(($0.rawValue, $1)) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }

        let cases: [(ghostty_action_tag_e, HiveGhosttyActionPolicy.Verdict)] = [
            (GHOSTTY_ACTION_RING_BELL, .handledByEffects),
            (GHOSTTY_ACTION_DESKTOP_NOTIFICATION, .deniedPolicy),
            (GHOSTTY_ACTION_QUIT, .deniedGesture),
            (GHOSTTY_ACTION_SCROLLBAR, .engineInert),
        ]
        for (tag, _) in cases {
            XCTAssertFalse(HiveGhosttyActionPolicy.handle(tag), "B1: every action resolves to false")
        }
        XCTAssertEqual(seen.count, cases.count, "handle must invoke the spy once per call")
        for (i, (tag, expected)) in cases.enumerated() {
            XCTAssertEqual(seen[i].0, tag.rawValue)
            XCTAssertEqual(seen[i].1, expected,
                           "handle must ROUTE \(tag.rawValue) through \(expected) — a blanket false that ignores " +
                           "classify() would report a wrong/nil verdict here")
        }
    }

    /// LIVE per-verdict routing: a real action reaching the callback from a
    /// real surface must carry the verdict handle routed it through, and it
    /// must match classify(). Non-vacuous: scrolling output reliably emits
    /// SCROLLBAR (engineInert), so the callback must fire at least once.
    func testLiveCallbackFiringsCarryTheCorrectVerdict() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let lock = NSLock()
        var seen: [(UInt32, HiveGhosttyActionPolicy.Verdict?)] = []
        HiveGhosttyActionPolicy.setObserver { tag, verdict in
            lock.lock(); seen.append((tag.rawValue, verdict)); lock.unlock()
        }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }

        // Enough lines to scroll a 24-row terminal → SCROLLBAR fires.
        var out = Data()
        for i in 0..<60 { out.append(Data("line \(i)\r\n".utf8)) }
        XCTAssertEqual(surface.processOutput(bytes: out, streamSeq: 0), .success)
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            Thread.sleep(forTimeInterval: 0.01)
        }

        lock.lock(); let firings = seen; lock.unlock()
        XCTAssertFalse(firings.isEmpty,
                       "the real action callback must fire from scrolling output — an empty set makes the " +
                       "per-verdict assertion vacuous")

        // The scroll stimulus specifically drives SCROLLBAR (rawValue 26,
        // engineInert). Assert it is actually observed routed through
        // .engineInert — a generic "every firing is classified" check would
        // pass even for a gesture tag, which for scrolling output would be a
        // real leak.
        XCTAssertTrue(firings.contains { $0.0 == GHOSTTY_ACTION_SCROLLBAR.rawValue && $0.1 == .engineInert },
                      "scrolling output must route SCROLLBAR (raw \(GHOSTTY_ACTION_SCROLLBAR.rawValue)) through " +
                      ".engineInert; observed \(firings)")

        // And NOTHING gesture-class or unclassified may reach the callback
        // from scroll output — every firing must route to the CONCRETE
        // .engineInert verdict. (Asserting verdict == classify(raw) here
        // would be circular — the observer verdict IS classify's result — so
        // it's a hard-coded expected value, not self-comparison.)
        let deniedGestureRaws = Set(HiveGhosttyActionPolicy.deniedGestureTags.map(\.rawValue))
        for (raw, verdict) in firings {
            XCTAssertEqual(verdict, .engineInert,
                           "scroll output must only emit engine-inert actions; rawValue \(raw) routed \(String(describing: verdict))")
            XCTAssertFalse(deniedGestureRaws.contains(raw),
                           "no gesture-class action (rawValue \(raw)) may reach the callback from scroll output")
        }
    }

    /// B-class strip (queen ruling 1): the manual config carries
    /// `keybind = clear`, so Ghostty's default window/tab/split bindings
    /// are unreachable-by-construction. Observable: cmd+N (default
    /// new_window) reports NOT-a-binding on the live surface. RED if the
    /// strip is removed: cmd+N is a default binding in a stock config.
    func testDefaultWindowBindingsAreStrippedFromManualConfig() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let handle = surface.surfaceHandle else {
            return XCTFail("real surface required")
        }

        var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_PRESS
        key.keycode = 45 // macOS virtual keycode for 'n'
        key.mods = GHOSTTY_MODS_SUPER
        key.consumed_mods = ghostty_input_mods_e(rawValue: 0)
        key.unshifted_codepoint = 0x6E // 'n'
        key.composing = false
        key.text = nil

        XCTAssertFalse(ghostty_surface_key_is_binding(handle, key, nil),
                       "cmd+N must NOT be a binding on a manual surface — the gate-9 strip " +
                       "(keybind = clear) makes Ghostty's window management unreachable-by-construction")

        var actionsSeen: [UInt32] = []
        HiveGhosttyActionPolicy.setObserver { tag, _ in actionsSeen.append(tag.rawValue) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }
        _ = surface.sendKey(key)
        XCTAssertFalse(actionsSeen.contains(GHOSTTY_ACTION_NEW_WINDOW.rawValue),
                       "a stripped binding must never reach the action callback as NEW_WINDOW")
    }

    /// DESKTOP_NOTIFICATION deny (queen ruling 3), live-fire: OSC 9 from
    /// the untrusted byte stream must not post anything — and must not
    /// crash or poison the stream. No notification API is ever touched by
    /// the bridge (HiveTerminalKit imports no UserNotifications).
    func testOSC9NotificationBytesAreInertAndDoNotPoisonTheStream() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        var actionsSeen: [UInt32] = []
        HiveGhosttyActionPolicy.setObserver { tag, _ in actionsSeen.append(tag.rawValue) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }

        let osc9 = Data("\u{1B}]9;pwned by agent\u{07}".utf8)
        XCTAssertEqual(surface.processOutput(bytes: osc9, streamSeq: 0), .success)

        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: UInt64(osc9.count)), .success)
        XCTAssertEqual(writes, [Data("\u{1B}[?62;22c".utf8)],
                       "OSC 9 must produce no reply and must not poison the following query")

        for raw in actionsSeen {
            XCTAssertEqual(raw, GHOSTTY_ACTION_DESKTOP_NOTIFICATION.rawValue,
                           "only the denied notification tag may appear for OSC 9, saw rawValue \(raw)")
        }
    }
}
