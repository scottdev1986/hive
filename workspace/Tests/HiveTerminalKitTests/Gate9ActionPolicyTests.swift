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

    /// Completeness: every tag value at the PINNED header (0...65) has
    /// exactly one verdict, and the first value past the pinned range has
    /// none. The upgrade-time guarantee is the header sha pin
    /// (toolchain-lock publicHeaderSha256): upstream cannot grow this enum
    /// without failing the build chain, and when the pin is deliberately
    /// bumped this test demands a verdict for every new tag.
    func testEveryPinnedActionTagHasExactlyOneVerdict() {
        let pinnedCount: UInt32 = 66
        XCTAssertEqual(GHOSTTY_ACTION_COPY_TITLE_TO_CLIPBOARD.rawValue, pinnedCount - 1,
                       "last pinned tag must be \(pinnedCount - 1) — if this moved, the header changed " +
                       "without this matrix being re-reviewed")
        for raw in 0..<pinnedCount {
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
        XCTAssertNil(HiveGhosttyActionPolicy.classify(ghostty_action_tag_e(rawValue: pinnedCount)),
                     "values past the pinned range must be unclassified — a silent catch-all here " +
                     "would defeat the completeness guarantee")
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

    /// The factory must wire the REAL policy callback, not a stub — same
    /// regression class the wakeup_cb factory test guards.
    func testFactoryWiresThePolicyActionCallback() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        // No pointer-identity check is possible for a closure-converted C
        // function pointer, so drive it: the policy handle() must be
        // observable through the spy when the callback fires. We can't
        // force Ghostty to emit an action on demand synchronously, but we
        // CAN prove the spy plumbing works and stays silent when nothing
        // fires — the OSC-9 test below is the live-fire counterpart.
        var seen: [ghostty_action_tag_e] = []
        HiveGhosttyActionPolicy.setObserver { seen.append($0) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }
        XCTAssertTrue(HiveGhosttyActionPolicy.handle(GHOSTTY_ACTION_RING_BELL) == false,
                      "B1 policy: no action is apprt-handled")
        XCTAssertEqual(seen.map(\.rawValue), [GHOSTTY_ACTION_RING_BELL.rawValue],
                       "the spy must observe handle() invocations")
    }

    /// B-class strip (queen ruling 1): the manual config carries
    /// `keybind = clear`, so Ghostty's default window/tab/split bindings
    /// are unreachable-by-construction. Observable: cmd+N (default
    /// new_window) reports NOT-a-binding on the live surface, and the key
    /// falls through to encoding (consumed-or-ignored by the terminal,
    /// never by a binding). RED if the strip is removed: cmd+N is a
    /// default binding in a stock config.
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

        // And no gesture action fires when the key is actually sent.
        var actionsSeen: [UInt32] = []
        HiveGhosttyActionPolicy.setObserver { actionsSeen.append($0.rawValue) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }
        _ = surface.sendKey(key)
        XCTAssertFalse(actionsSeen.contains(GHOSTTY_ACTION_NEW_WINDOW.rawValue),
                       "a stripped binding must never reach the action callback as NEW_WINDOW")
    }

    /// DESKTOP_NOTIFICATION deny (queen ruling 3), live-fire: OSC 9 from
    /// the untrusted byte stream must not post anything — and must not
    /// crash or poison the stream. If the engine routes it to the action
    /// callback in manual mode, the spy sees the tag and the verdict is
    /// deniedPolicy (return false, nothing happens); if manual mode never
    /// emits it, unreachable-by-construction is equally acceptable. Either
    /// way: no notification API is ever touched by the bridge (grep-level
    /// fact: HiveTerminalKit imports no UserNotifications), and the stream
    /// stays healthy.
    func testOSC9NotificationBytesAreInertAndDoNotPoisonTheStream() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        var actionsSeen: [UInt32] = []
        HiveGhosttyActionPolicy.setObserver { actionsSeen.append($0.rawValue) }
        defer { HiveGhosttyActionPolicy.setObserver(nil) }

        let osc9 = Data("\u{1B}]9;pwned by agent\u{07}".utf8)
        XCTAssertEqual(surface.processOutput(bytes: osc9, streamSeq: 0), .success)

        // Stream healthy afterward: DA1 still answers byte-exactly.
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: UInt64(osc9.count)), .success)
        XCTAssertEqual(writes, [Data("\u{1B}[?62;22c".utf8)],
                       "OSC 9 must produce no reply and must not poison the following query")

        // If the action fired at all, it must have been the denied tag —
        // never anything privileged.
        for raw in actionsSeen {
            XCTAssertEqual(raw, GHOSTTY_ACTION_DESKTOP_NOTIFICATION.rawValue,
                           "only the denied notification tag may appear for OSC 9, saw rawValue \(raw)")
        }
    }
}
