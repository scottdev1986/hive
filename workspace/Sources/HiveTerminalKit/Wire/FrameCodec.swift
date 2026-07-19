import Foundation

/// §20 local wire protocol v1 — 32-byte frame header, network byte order.
public enum FrameType: UInt16, CaseIterable, Sendable {
    case hello = 0x0001
    case welcome = 0x0002
    case error = 0x0003
    case ping = 0x0004
    case pong = 0x0005
    case attachRequest = 0x0200
    case attachGrant = 0x0201
    case hostAttach = 0x0202
    case snapshotBegin = 0x0203
    case snapshotBytes = 0x0204
    case output = 0x0205
    case applied = 0x0206
    case resize = 0x0207
    case detach = 0x0208
    case event = 0x0209
    case claimAcquire = 0x0300
    case claimResult = 0x0301
    case humanInput = 0x0302
    case claimRelease = 0x0303
    case gestureInput = 0x0304
    case inputSubmit = 0x0305
}

public struct FrameFlags: OptionSet, Sendable {
    public let rawValue: UInt16
    public init(rawValue: UInt16) { self.rawValue = rawValue }
    public static let response = FrameFlags(rawValue: 1 << 0)
    public static let final = FrameFlags(rawValue: 1 << 1)
    public static let error = FrameFlags(rawValue: 1 << 2)
    public static let contentSensitive = FrameFlags(rawValue: 1 << 3)
    public static let allowedMask: UInt16 = 0x000f
}

public struct WireFrame: Equatable, Sendable {
    public var type: FrameType
    public var flags: FrameFlags
    public var requestId: UInt64
    public var streamSeq: UInt64
    public var payload: Data

    public init(
        type: FrameType,
        flags: FrameFlags = [],
        requestId: UInt64 = 0,
        streamSeq: UInt64 = 0,
        payload: Data = Data()
    ) {
        self.type = type
        self.flags = flags
        self.requestId = requestId
        self.streamSeq = streamSeq
        self.payload = payload
    }
}

public enum WireError: Error, Equatable, CustomStringConvertible {
    case malformedFrame(String)
    case protocolMismatch(String)
    case unsupportedFrame(UInt16)
    case frameTooLarge(type: FrameType, length: Int)
    case malformedPayload(String)
    case bindingMismatch(String)
    case rebaseRequired(String)
    case notConnected
    case closed
    case receiveTimeout

    public var description: String {
        switch self {
        case .malformedFrame(let m): return "MALFORMED_FRAME: \(m)"
        case .protocolMismatch(let m): return "PROTOCOL_MISMATCH: \(m)"
        case .unsupportedFrame(let t): return "UNSUPPORTED_FRAME: \(t)"
        case .frameTooLarge(let t, let n): return "FRAME_TOO_LARGE: \(t) \(n)"
        case .malformedPayload(let m): return "MALFORMED_PAYLOAD: \(m)"
        case .bindingMismatch(let m): return "BINDING_MISMATCH: \(m)"
        case .rebaseRequired(let m): return "REBASE_REQUIRED: \(m)"
        case .notConnected: return "NOT_CONNECTED"
        case .closed: return "CLOSED"
        case .receiveTimeout: return "RECEIVE_TIMEOUT"
        }
    }
}

public enum FrameCodec {
    public static let headerBytes = 32
    public static let magic: [UInt8] = [0x48, 0x56, 0x54, 0x31] // HVT1
    public static let protocolMajor: UInt8 = 1
    public static let protocolMinor: UInt8 = 0
    public static let controlFrameMaxBytes = 256 * 1024
    public static let streamChunkMaxBytes = 64 * 1024
    public static let inputTransactionMaxBytes = 128 * 1024
    public static let optionalTypeBit: UInt16 = 0x8000

    private static let rawByteTypes: Set<FrameType> = [
        .snapshotBytes, .output, .humanInput,
    ]

    public static func encode(_ frame: WireFrame) throws -> Data {
        let cap = rawByteTypes.contains(frame.type) ? streamChunkMaxBytes : controlFrameMaxBytes
        if frame.payload.count > cap {
            throw WireError.frameTooLarge(type: frame.type, length: frame.payload.count)
        }
        var data = Data(count: headerBytes + frame.payload.count)
        data.replaceSubrange(0..<4, with: magic)
        data[4] = protocolMajor
        data[5] = protocolMinor
        writeUInt16(frame.type.rawValue, into: &data, at: 6)
        writeUInt16(frame.flags.rawValue, into: &data, at: 8)
        writeUInt16(0, into: &data, at: 10)
        writeUInt32(UInt32(frame.payload.count), into: &data, at: 12)
        writeUInt64(frame.requestId, into: &data, at: 16)
        writeUInt64(frame.streamSeq, into: &data, at: 24)
        if !frame.payload.isEmpty {
            data.replaceSubrange(headerBytes..<(headerBytes + frame.payload.count), with: frame.payload)
        }
        return data
    }

    public static func decodeHeader(_ bytes: Data) throws -> (
        type: FrameType?,
        typeCode: UInt16,
        flags: FrameFlags,
        payloadLength: Int,
        requestId: UInt64,
        streamSeq: UInt64,
        ignoreOptional: Bool
    ) {
        guard bytes.count == headerBytes else {
            throw WireError.malformedFrame("header length \(bytes.count)")
        }
        for i in 0..<4 where bytes[i] != magic[i] {
            throw WireError.malformedFrame("magic")
        }
        let major = bytes[4]
        let minor = bytes[5]
        if major != protocolMajor {
            throw WireError.protocolMismatch("major \(major)")
        }
        if minor != protocolMinor {
            throw WireError.protocolMismatch("minor \(minor)")
        }
        let typeCode = readUInt16(bytes, at: 6)
        let flagsRaw = readUInt16(bytes, at: 8)
        let reserved = readUInt16(bytes, at: 10)
        if (flagsRaw & ~FrameFlags.allowedMask) != 0 || reserved != 0 {
            throw WireError.malformedFrame("flags/reserved")
        }
        let payloadLength = Int(readUInt32(bytes, at: 12))
        let requestId = readUInt64(bytes, at: 16)
        let streamSeq = readUInt64(bytes, at: 24)
        if let type = FrameType(rawValue: typeCode) {
            let cap = rawByteTypes.contains(type) ? streamChunkMaxBytes : controlFrameMaxBytes
            if payloadLength > cap {
                throw WireError.frameTooLarge(type: type, length: payloadLength)
            }
            return (type, typeCode, FrameFlags(rawValue: flagsRaw), payloadLength, requestId, streamSeq, false)
        }
        if (typeCode & optionalTypeBit) != 0 {
            if payloadLength > controlFrameMaxBytes {
                throw WireError.malformedFrame("optional too large")
            }
            return (nil, typeCode, FrameFlags(rawValue: flagsRaw), payloadLength, requestId, streamSeq, true)
        }
        throw WireError.unsupportedFrame(typeCode)
    }

    public static func decodeFrame(header: Data, payload: Data) throws -> WireFrame? {
        let decoded = try decodeHeader(header)
        if decoded.ignoreOptional {
            return nil
        }
        guard let type = decoded.type else {
            throw WireError.unsupportedFrame(decoded.typeCode)
        }
        guard payload.count == decoded.payloadLength else {
            throw WireError.malformedFrame("payload length")
        }
        return WireFrame(
            type: type,
            flags: decoded.flags,
            requestId: decoded.requestId,
            streamSeq: decoded.streamSeq,
            payload: payload
        )
    }

    public static func jsonPayload(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    public static func parseJSONObject(_ data: Data) throws -> [String: Any] {
        let value = try JSONSerialization.jsonObject(with: data, options: [])
        guard let object = value as? [String: Any] else {
            throw WireError.malformedPayload("expected object")
        }
        return object
    }

    // MARK: - Network-endian helpers

    private static func writeUInt16(_ value: UInt16, into data: inout Data, at offset: Int) {
        data[offset] = UInt8((value >> 8) & 0xff)
        data[offset + 1] = UInt8(value & 0xff)
    }

    private static func writeUInt32(_ value: UInt32, into data: inout Data, at offset: Int) {
        data[offset] = UInt8((value >> 24) & 0xff)
        data[offset + 1] = UInt8((value >> 16) & 0xff)
        data[offset + 2] = UInt8((value >> 8) & 0xff)
        data[offset + 3] = UInt8(value & 0xff)
    }

    private static func writeUInt64(_ value: UInt64, into data: inout Data, at offset: Int) {
        for i in 0..<8 {
            data[offset + i] = UInt8((value >> (8 * (7 - i))) & 0xff)
        }
    }

    private static func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
        (UInt16(data[offset]) << 8) | UInt16(data[offset + 1])
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        (UInt32(data[offset]) << 24)
            | (UInt32(data[offset + 1]) << 16)
            | (UInt32(data[offset + 2]) << 8)
            | UInt32(data[offset + 3])
    }

    private static func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for i in 0..<8 {
            value = (value << 8) | UInt64(data[offset + i])
        }
        return value
    }
}
