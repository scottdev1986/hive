import Foundation

/// GhosttyResult from vendor/ghostty terminal/c/result.zig.
public enum GhosttyBridgeResult: Int32, Equatable, Sendable {
    case success = 0
    case outOfMemory = -1
    case invalidValue = -2
    case outOfSpace = -3
    case noValue = -4
}

/// L0 surface engine seam — production uses Ghostty; tests inject fakes.
///
/// Real implementation calls the six §23 `_v1` bridge ABI symbols and stock
/// `ghostty_surface_*` APIs. The program ships UAF bugs when ownership is
/// wrong; every caller must go through `BridgeCallbackContext` copies.
public protocol ManualSurfaceEngine: AnyObject {
    var callbackContext: BridgeCallbackContext { get }
    /// Exclusive high-water after last successful apply/restore.
    var throughSeq: UInt64 { get }
    func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult
    func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult
    func setFocus(_ focused: Bool)
    func setSize(widthPx: UInt32, heightPx: UInt32)
    func free()
}

/// In-process fake for L1/L2 unit tests (no GhosttyKit). Records applies.
public final class FakeManualSurface: ManualSurfaceEngine {
    public let callbackContext = BridgeCallbackContext()
    public private(set) var throughSeq: UInt64 = 0
    public private(set) var appliedRanges: [(streamSeq: UInt64, bytes: Data)] = []
    public private(set) var restored: [(throughSeq: UInt64, payload: Data)] = []
    public private(set) var focusCalls: [Bool] = []
    public private(set) var sizeCalls: [(UInt32, UInt32)] = []
    public private(set) var freed = false

    /// Mirrors bridge ledger: contiguous ordered ranges; duplicate-equal ignored;
    /// gap/digest conflict → invalidValue (caller maps to rebase).
    private var committed: [(streamSeq: UInt64, bytes: Data, digest: Data)] = []

    public init() {}

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        if bytes.isEmpty { return .invalidValue }
        let digest = sha256(bytes)
        if let existing = committed.first(where: { $0.streamSeq == streamSeq && $0.bytes.count == bytes.count }) {
            return existing.digest == digest ? .success : .invalidValue
        }
        if streamSeq + UInt64(bytes.count) <= throughSeq {
            // Fully behind high-water without an exact match → invalid (stale).
            return .invalidValue
        }
        if streamSeq != throughSeq {
            return .invalidValue
        }
        committed.append((streamSeq, bytes, digest))
        appliedRanges.append((streamSeq, bytes))
        throughSeq = streamSeq + UInt64(bytes.count)
        return .success
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        if payload.isEmpty { return .invalidValue }
        restored.append((throughSeq, payload))
        committed.removeAll()
        self.throughSeq = throughSeq
        return .success
    }

    public func setFocus(_ focused: Bool) {
        focusCalls.append(focused)
    }

    public func setSize(widthPx: UInt32, heightPx: UInt32) {
        sizeCalls.append((widthPx, heightPx))
    }

    public func free() {
        freed = true
    }
}

/// L0 thin wrappers over the six §23 `_v1` symbols.
///
/// Linked against GhosttyKit.xcframework. Callbacks are wired through
/// `BridgeCallbackContext` (copy-before-return). Stock surface APIs are
/// exposed as methods that forward to `ghostty_surface_*`.
public final class GhosttyManualSurface: ManualSurfaceEngine {
    public let callbackContext: BridgeCallbackContext
    public private(set) var throughSeq: UInt64 = 0

    private var surface: OpaquePointer?
    private var ownsSurface: Bool

    /// Create a wrapper around an already-created manual surface handle.
    /// The factory path that calls `hive_ghostty_surface_new_manual_v1` lives
    /// in `GhosttyBridgeFactory` so App/config setup stays optional for tests.
    public init(surface: OpaquePointer, callbackContext: BridgeCallbackContext, ownsSurface: Bool = true) {
        self.surface = surface
        self.callbackContext = callbackContext
        self.ownsSurface = ownsSurface
    }

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        guard let surface else { return .invalidValue }
        let result = bytes.withUnsafeBytes { raw -> Int32 in
            let ptr = raw.bindMemory(to: UInt8.self).baseAddress
            return hive_ghostty_surface_process_output_v1(surface, ptr, raw.count, streamSeq)
        }
        let mapped = GhosttyBridgeResult(rawValue: result) ?? .invalidValue
        if mapped == .success {
            // Exclusive high-water advances only on accept; duplicates leave it.
            // Bridge returns success for both accept and duplicate-equal.
            // Track optimistic high-water for APPLIED; duplicate does not go backward.
            let end = streamSeq + UInt64(bytes.count)
            if end > throughSeq { throughSeq = end }
        }
        return mapped
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        guard let surface else { return .invalidValue }
        let result = payload.withUnsafeBytes { raw -> Int32 in
            let ptr = raw.bindMemory(to: UInt8.self).baseAddress
            return hive_ghostty_surface_restore_checkpoint_v1(surface, ptr, raw.count, throughSeq)
        }
        let mapped = GhosttyBridgeResult(rawValue: result) ?? .invalidValue
        if mapped == .success {
            self.throughSeq = throughSeq
        }
        return mapped
    }

    public func setFocus(_ focused: Bool) {
        guard let surface else { return }
        ghostty_surface_set_focus_shim(surface, focused)
    }

    public func setSize(widthPx: UInt32, heightPx: UInt32) {
        guard let surface else { return }
        ghostty_surface_set_size_shim(surface, widthPx, heightPx)
    }

    public func free() {
        guard ownsSurface, let surface else { return }
        ghostty_surface_free_shim(surface)
        self.surface = nil
    }

    deinit {
        free()
    }

    /// §23 engine build id (hex C string). Requires GhosttyKit linkage.
    public static func engineBuildId() -> String {
        guard let cstr = hive_ghostty_engine_build_id_v1() else { return "" }
        return String(cString: cstr)
    }
}

// MARK: - C ABI imports (six _v1 symbols + stock surface shims)

/// These symbols live in GhosttyKit (hive patch + public ghostty.h).
/// Declared here so HiveTerminalKit does not need a separate C module for
/// the bridge header include graph.

@_silgen_name("hive_ghostty_engine_build_id_v1")
func hive_ghostty_engine_build_id_v1() -> UnsafePointer<CChar>?

@_silgen_name("hive_ghostty_surface_new_manual_v1")
func hive_ghostty_surface_new_manual_v1(
    _ app: OpaquePointer?,
    _ config: UnsafeRawPointer?,
    _ writeFn: (@convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Void)?,
    _ writeContext: UnsafeMutableRawPointer?,
    _ eventFn: (@convention(c) (UnsafeMutableRawPointer?, UnsafeRawPointer?) -> Void)?,
    _ eventContext: UnsafeMutableRawPointer?
) -> OpaquePointer?

@_silgen_name("hive_ghostty_surface_process_output_v1")
func hive_ghostty_surface_process_output_v1(
    _ surface: OpaquePointer?,
    _ bytes: UnsafePointer<UInt8>?,
    _ length: Int,
    _ streamSeq: UInt64
) -> Int32

@_silgen_name("hive_ghostty_surface_restore_checkpoint_v1")
func hive_ghostty_surface_restore_checkpoint_v1(
    _ surface: OpaquePointer?,
    _ payload: UnsafePointer<UInt8>?,
    _ length: Int,
    _ throughSeq: UInt64
) -> Int32

@_silgen_name("hive_ghostty_terminal_checkpoint_export_v1")
func hive_ghostty_terminal_checkpoint_export_v1(
    _ terminal: OpaquePointer?,
    _ allocFn: (@convention(c) (UnsafeMutableRawPointer?, Int, Int) -> UnsafeMutableRawPointer?)?,
    _ context: UnsafeMutableRawPointer?,
    _ payload: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?,
    _ length: UnsafeMutablePointer<Int>?
) -> Int32

@_silgen_name("hive_ghostty_terminal_checkpoint_import_v1")
func hive_ghostty_terminal_checkpoint_import_v1(
    _ terminal: OpaquePointer?,
    _ payload: UnsafePointer<UInt8>?,
    _ length: Int
) -> Int32

@_silgen_name("ghostty_surface_free")
func ghostty_surface_free_shim(_ surface: OpaquePointer?)

@_silgen_name("ghostty_surface_set_focus")
func ghostty_surface_set_focus_shim(_ surface: OpaquePointer?, _ focused: Bool)

@_silgen_name("ghostty_surface_set_size")
func ghostty_surface_set_size_shim(_ surface: OpaquePointer?, _ width: UInt32, _ height: UInt32)

@_silgen_name("ghostty_surface_key")
func ghostty_surface_key_shim(_ surface: OpaquePointer?, _ key: UnsafeRawPointer?) -> Bool

@_silgen_name("ghostty_surface_text")
func ghostty_surface_text_shim(_ surface: OpaquePointer?, _ text: UnsafePointer<CChar>?, _ len: Int)

@_silgen_name("ghostty_surface_preedit")
func ghostty_surface_preedit_shim(_ surface: OpaquePointer?, _ text: UnsafePointer<CChar>?, _ len: Int)

@_silgen_name("ghostty_surface_draw")
func ghostty_surface_draw_shim(_ surface: OpaquePointer?)

@_silgen_name("ghostty_surface_refresh")
func ghostty_surface_refresh_shim(_ surface: OpaquePointer?)

// MARK: - SHA-256 (CryptoKit when available; fallback for tests)

import CryptoKit

func sha256(_ data: Data) -> Data {
    Data(SHA256.hash(data: data))
}
