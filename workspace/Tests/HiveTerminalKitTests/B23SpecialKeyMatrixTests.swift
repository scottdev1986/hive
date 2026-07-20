import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — editing / navigation / function key rows.
///
/// Acceptance clause (planning/story-m1-b2-hive-terminal-view.md): key
/// handling preserves physical key, layout-derived text, ... function and
/// navigation keys.
///
/// Before this file the only special-key coverage was Ctrl+H and an assertion
/// that an arrow's AppKit private-use scalar is NOT injected as text. Nothing
/// asserted what these keys actually encode, which is the exact bug class this
/// codebase has already hit once: a documented "zero writes for special keys"
/// blocker (see KittyKeyboardGoldenTests' header) where every navigation key
/// silently encoded nothing.
///
/// Two levels of claim, deliberately separated:
///  - Arrows are pinned to exact bytes. CSI A/B/C/D in the default (cursor
///    key) mode is spec-certain, and the repo already cites left -> "\u{1B}[D".
///  - The remaining keys assert NON-EMPTY and MUTUALLY DISTINCT encodings.
///    That is weaker than a byte golden on purpose: those sequences vary with
///    DECCKM/keypad state and pinning a value read back from this build would
///    record current behavior rather than test it. Non-empty catches the
///    historical silent-drop bug; distinctness catches two keys collapsing
///    onto one sequence. Both bite without asserting anything unverified.
final class B23SpecialKeyMatrixTests: XCTestCase {
    private struct Key {
        let name: String
        let keyCode: UInt16
        /// AppKit reports function/navigation keys as private-use scalars.
        let scalar: UnicodeScalar
    }

    // macOS virtual key codes paired with the AppKit function-key scalars.
    private static let arrows: [(key: Key, expected: String)] = [
        (Key(name: "up", keyCode: 126, scalar: UnicodeScalar(0xF700)!), "\u{1B}[A"),
        (Key(name: "down", keyCode: 125, scalar: UnicodeScalar(0xF701)!), "\u{1B}[B"),
        (Key(name: "right", keyCode: 124, scalar: UnicodeScalar(0xF703)!), "\u{1B}[C"),
        (Key(name: "left", keyCode: 123, scalar: UnicodeScalar(0xF702)!), "\u{1B}[D"),
    ]

    private static let navigationAndFunction: [Key] = [
        Key(name: "home", keyCode: 115, scalar: UnicodeScalar(0xF729)!),
        Key(name: "end", keyCode: 119, scalar: UnicodeScalar(0xF72B)!),
        Key(name: "pageUp", keyCode: 116, scalar: UnicodeScalar(0xF72C)!),
        Key(name: "pageDown", keyCode: 121, scalar: UnicodeScalar(0xF72D)!),
        Key(name: "forwardDelete", keyCode: 117, scalar: UnicodeScalar(0xF728)!),
        Key(name: "f1", keyCode: 122, scalar: UnicodeScalar(0xF704)!),
        Key(name: "f2", keyCode: 120, scalar: UnicodeScalar(0xF705)!),
        Key(name: "f5", keyCode: 96, scalar: UnicodeScalar(0xF708)!),
        Key(name: "f12", keyCode: 111, scalar: UnicodeScalar(0xF70F)!),
    ]

    /// The sole reader for every row and control.
    private func encode(_ key: Key) throws -> String {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
        terminal.keyDown(with: Self.makeEvent(key))

        // Encoder bytes arrive on the surface io thread. A synchronous read
        // is the documented measurement error behind the earlier false
        // "zero writes for special keys" report, so drain, then settle.
        _ = drain(log, until: 1)
        drainIdle(0.25)

        let joined = log.snapshot().reduce(into: Data(), { $0.append($1) })
        return String(decoding: joined, as: UTF8.self)
    }

    /// Arrows: exact bytes.
    func testArrowKeysEncodePinnedCursorSequences() throws {
        for (key, expected) in Self.arrows {
            XCTAssertEqual(
                try encode(key), expected,
                "\(key.name) arrow must encode \(expected.debugDescription)"
            )
        }
    }

    /// Navigation and function keys: each must encode SOMETHING. This is the
    /// row that would have caught the historical silent-drop blocker.
    func testNavigationAndFunctionKeysAllEncodeNonEmptySequences() throws {
        for key in Self.navigationAndFunction {
            let encoded = try encode(key)
            XCTAssertFalse(
                encoded.isEmpty,
                "\(key.name) encoded nothing; navigation and function keys must reach the terminal"
            )
        }
    }

    /// ...and no two of them may collapse onto the same sequence.
    func testSpecialKeysEncodeMutuallyDistinctSequences() throws {
        var seen: [String: String] = [:]
        for key in Self.arrows.map(\.key) + Self.navigationAndFunction {
            let encoded = try encode(key)
            if let owner = seen[encoded] {
                XCTFail(
                    "\(key.name) and \(owner) both encode \(encoded.debugDescription); "
                        + "distinct physical keys must not collapse onto one sequence"
                )
            }
            seen[encoded] = key.name
        }
        XCTAssertEqual(
            seen.count, Self.arrows.count + Self.navigationAndFunction.count,
            "every key must contribute a distinct sequence"
        )
    }

    /// Positive control through the same reader: an ordinary printable key
    /// must come back as its own text. If this fails the reader is not
    /// observing the encoder at all, and every row above is unattributable —
    /// including the non-empty assertions, which would then be measuring
    /// nothing.
    func testPositiveControlPrintableKeyIsObservableThroughSameReader() throws {
        let a = Key(name: "a", keyCode: 0, scalar: UnicodeScalar("a"))
        XCTAssertEqual(
            try encode(a), "a",
            "the reader did not observe a plain printable key; "
                + "every special-key row in this file is unattributable until this passes"
        )
    }

    // MARK: - Helpers

    private static func makeEvent(_ key: Key) -> NSEvent {
        let text = String(Character(key.scalar))
        return NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: text,
            charactersIgnoringModifiers: text,
            isARepeat: false,
            keyCode: key.keyCode
        )!
    }

    private final class WriteLog {
        private let lock = NSLock()
        private var writes: [Data] = []
        func append(_ data: Data) {
            lock.lock(); writes.append(data); lock.unlock()
        }
        func snapshot() -> [Data] {
            lock.lock(); defer { lock.unlock() }
            return writes
        }
    }

    private func drain(_ log: WriteLog, until count: Int, timeout: TimeInterval = 2) -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while log.snapshot().count < count && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        return log.snapshot()
    }

    private func drainIdle(_ interval: TimeInterval) {
        let deadline = Date().addingTimeInterval(interval)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}
