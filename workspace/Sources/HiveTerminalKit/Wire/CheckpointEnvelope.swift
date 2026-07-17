import Foundation
import CryptoKit

/// §20/§23 wire checkpoint envelope: 116-byte `HVTCP001` header + opaque payload.
///
/// Authority: docs/design/terminal-stack-transition.html §23 checkpoint table
/// and `CHECKPOINT_HEADER` in `src/schemas/session-protocol.ts` (projected into
/// `SessionProtocol.generated.swift` as `SessionProtocolGenerated.Checkpoint`).
/// The opaque payload is what `hive_ghostty_surface_restore_checkpoint_v1`
/// consumes (engine format).
public struct CheckpointEnvelope: Equatable, Sendable {
    public static let headerBytes = SessionProtocolGenerated.Checkpoint.headerBytes
    public static let magic = SessionProtocolGenerated.Checkpoint.magic
    public static let version: UInt16 = SessionProtocolGenerated.Checkpoint.version
    public static let headerBytesField: UInt16 = UInt16(SessionProtocolGenerated.Checkpoint.headerBytes)
    public static let flags: UInt32 = SessionProtocolGenerated.Checkpoint.flags

    /// HVTCP001 field offsets — sourced from the generated projection
    /// (`SessionProtocolGenerated.Checkpoint.Offset`). Do not hardcode elsewhere.
    public typealias FieldOffset = SessionProtocolGenerated.Checkpoint.Offset

    public var throughSeq: UInt64
    public var createdMonoNanos: UInt64
    public var columns: UInt32
    public var rows: UInt32
    public var cellWidthPxFixed: UInt32
    public var cellHeightPxFixed: UInt32
    /// Raw 32-byte engine build id from the header.
    public var engineBuildId: Data
    public var payloadLength: UInt32
    public var payloadSha256: Data
    public var payload: Data

    public var engineBuildIdHex: String {
        engineBuildId.map { String(format: "%02x", $0) }.joined()
    }

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case tooShort(Int)
        case badMagic
        case badVersion(UInt16)
        case badHeaderBytes(UInt16)
        case badFlags(UInt32)
        case incompletePayload(have: Int, need: Int)
        case payloadDigestMismatch
        case engineMismatch(expected: String, found: String)

        public var description: String {
            switch self {
            case .tooShort(let n): return "checkpoint too short: \(n)"
            case .badMagic: return "checkpoint magic != HVTCP001"
            case .badVersion(let v): return "checkpoint version \(v)"
            case .badHeaderBytes(let h): return "headerBytes \(h)"
            case .badFlags(let f): return "flags \(f)"
            case .incompletePayload(let have, let need): return "payload \(have)/\(need)"
            case .payloadDigestMismatch: return "payloadSha256 mismatch"
            case .engineMismatch(let e, let f): return "ENGINE_MISMATCH want \(e) got \(f)"
            }
        }
    }

    /// Parse a complete envelope (header + payload) from accumulated SNAPSHOT_BYTES.
    public static func parse(_ data: Data) throws -> CheckpointEnvelope {
        guard data.count >= headerBytes else {
            throw ParseError.tooShort(data.count)
        }
        let magicBytes = Data(magic.utf8)
        guard Data(data[FieldOffset.magic..<(FieldOffset.magic + 8)]) == magicBytes else {
            throw ParseError.badMagic
        }
        let version = readU16(data, FieldOffset.version)
        guard version == Self.version else { throw ParseError.badVersion(version) }
        let hdr = readU16(data, FieldOffset.headerBytes)
        guard hdr == headerBytesField else { throw ParseError.badHeaderBytes(hdr) }
        let flags = readU32(data, FieldOffset.flags)
        guard flags == Self.flags else { throw ParseError.badFlags(flags) }
        let throughSeq = readU64(data, FieldOffset.throughSeq)
        let created = readU64(data, FieldOffset.createdMonoNanos)
        let columns = readU32(data, FieldOffset.columns)
        let rows = readU32(data, FieldOffset.rows)
        let cellW = readU32(data, FieldOffset.cellWidthPx)
        let cellH = readU32(data, FieldOffset.cellHeightPx)
        let engineId = Data(data[FieldOffset.engineBuildId..<(FieldOffset.engineBuildId + SessionProtocolGenerated.Checkpoint.engineBuildIdBytes)])
        let payloadLength = readU32(data, FieldOffset.payloadLength)
        let digest = Data(data[FieldOffset.payloadSha256..<(FieldOffset.payloadSha256 + SessionProtocolGenerated.Checkpoint.payloadSha256Bytes)])
        let need = headerBytes + Int(payloadLength)
        guard data.count >= need else {
            throw ParseError.incompletePayload(have: data.count - headerBytes, need: Int(payloadLength))
        }
        let payload = Data(data[headerBytes..<need])
        let actual = Data(SHA256.hash(data: payload))
        guard actual == digest else { throw ParseError.payloadDigestMismatch }
        return CheckpointEnvelope(
            throughSeq: throughSeq,
            createdMonoNanos: created,
            columns: columns,
            rows: rows,
            cellWidthPxFixed: cellW,
            cellHeightPxFixed: cellH,
            engineBuildId: engineId,
            payloadLength: payloadLength,
            payloadSha256: digest,
            payload: payload
        )
    }

    /// True when accumulated bytes contain a full header+payload.
    public static func isComplete(_ data: Data) -> Bool {
        guard data.count >= headerBytes else { return false }
        let payloadLength = Int(readU32(data, FieldOffset.payloadLength))
        return data.count >= headerBytes + payloadLength
    }

    /// How many total bytes (header+payload) are required once the header is present.
    public static func requiredTotalBytes(_ data: Data) -> Int? {
        guard data.count >= headerBytes else { return nil }
        return headerBytes + Int(readU32(data, FieldOffset.payloadLength))
    }

    /// Build a wire envelope. Callers (including FakeHost) must pass the real
    /// local engine build id — no default test sentinel (MF2).
    public static func encode(
        throughSeq: UInt64,
        payload: Data,
        engineBuildId: Data,
        columns: UInt32 = 80,
        rows: UInt32 = 24
    ) -> Data {
        var out = Data(count: headerBytes + payload.count)
        out.replaceSubrange(FieldOffset.magic..<(FieldOffset.magic + 8), with: Data(magic.utf8))
        writeU16(version, into: &out, at: FieldOffset.version)
        writeU16(headerBytesField, into: &out, at: FieldOffset.headerBytes)
        writeU32(flags, into: &out, at: FieldOffset.flags)
        writeU64(throughSeq, into: &out, at: FieldOffset.throughSeq)
        writeU64(0, into: &out, at: FieldOffset.createdMonoNanos)
        writeU32(columns, into: &out, at: FieldOffset.columns)
        writeU32(rows, into: &out, at: FieldOffset.rows)
        writeU32(0, into: &out, at: FieldOffset.cellWidthPx)
        writeU32(0, into: &out, at: FieldOffset.cellHeightPx)
        var engine = engineBuildId
        let engineBytes = SessionProtocolGenerated.Checkpoint.engineBuildIdBytes
        if engine.count < engineBytes { engine.append(Data(repeating: 0, count: engineBytes - engine.count)) }
        out.replaceSubrange(
            FieldOffset.engineBuildId..<(FieldOffset.engineBuildId + engineBytes),
            with: engine.prefix(engineBytes)
        )
        writeU32(UInt32(payload.count), into: &out, at: FieldOffset.payloadLength)
        let digest = Data(SHA256.hash(data: payload))
        let shaBytes = SessionProtocolGenerated.Checkpoint.payloadSha256Bytes
        out.replaceSubrange(
            FieldOffset.payloadSha256..<(FieldOffset.payloadSha256 + shaBytes),
            with: digest
        )
        if !payload.isEmpty {
            out.replaceSubrange(headerBytes..<(headerBytes + payload.count), with: payload)
        }
        return out
    }

    private static func readU16(_ d: Data, _ o: Int) -> UInt16 {
        (UInt16(d[o]) << 8) | UInt16(d[o + 1])
    }
    private static func readU32(_ d: Data, _ o: Int) -> UInt32 {
        (UInt32(d[o]) << 24) | (UInt32(d[o + 1]) << 16) | (UInt32(d[o + 2]) << 8) | UInt32(d[o + 3])
    }
    private static func readU64(_ d: Data, _ o: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(d[o + i]) }
        return v
    }
    private static func writeU16(_ v: UInt16, into d: inout Data, at o: Int) {
        d[o] = UInt8((v >> 8) & 0xff); d[o + 1] = UInt8(v & 0xff)
    }
    private static func writeU32(_ v: UInt32, into d: inout Data, at o: Int) {
        d[o] = UInt8((v >> 24) & 0xff); d[o + 1] = UInt8((v >> 16) & 0xff)
        d[o + 2] = UInt8((v >> 8) & 0xff); d[o + 3] = UInt8(v & 0xff)
    }
    private static func writeU64(_ v: UInt64, into d: inout Data, at o: Int) {
        for i in 0..<8 { d[o + i] = UInt8((v >> (8 * (7 - i))) & 0xff) }
    }
}
