import Foundation

/// Exact generation identity for a session. Never recover by name.
public struct SessionLocator: Equatable, Sendable, Hashable {
    public var schemaVersion: Int
    public var instanceId: String
    public var subjectKind: String
    public var agentId: String?
    public var generation: Int
    public var sessionId: String
    public var hostKind: String
    public var engineBuildId: String?

    public init(
        schemaVersion: Int = 1,
        instanceId: String,
        subjectKind: String,
        agentId: String? = nil,
        generation: Int,
        sessionId: String,
        hostKind: String,
        engineBuildId: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.instanceId = instanceId
        self.subjectKind = subjectKind
        self.agentId = agentId
        self.generation = generation
        self.sessionId = sessionId
        self.hostKind = hostKind
        self.engineBuildId = engineBuildId
    }

    public func jsonObject() -> [String: Any] {
        var subject: [String: Any] = ["kind": subjectKind]
        if let agentId {
            subject["agentId"] = agentId
        }
        var object: [String: Any] = [
            "schemaVersion": schemaVersion,
            "instanceId": instanceId,
            "subject": subject,
            "generation": generation,
            "sessionId": sessionId,
            "hostKind": hostKind,
            "engineBuildId": engineBuildId as Any,
        ]
        if engineBuildId == nil {
            object["engineBuildId"] = NSNull()
        }
        return object
    }

    public static func parse(_ object: [String: Any]) throws -> SessionLocator {
        guard let schemaVersion = object["schemaVersion"] as? Int,
              let instanceId = object["instanceId"] as? String,
              let subject = object["subject"] as? [String: Any],
              let subjectKind = subject["kind"] as? String,
              let generation = object["generation"] as? Int,
              let sessionId = object["sessionId"] as? String,
              let hostKind = object["hostKind"] as? String
        else {
            throw WireError.malformedPayload("SessionLocator")
        }
        let engine: String?
        if object["engineBuildId"] is NSNull || object["engineBuildId"] == nil {
            engine = nil
        } else {
            engine = object["engineBuildId"] as? String
        }
        return SessionLocator(
            schemaVersion: schemaVersion,
            instanceId: instanceId,
            subjectKind: subjectKind,
            agentId: subject["agentId"] as? String,
            generation: generation,
            sessionId: sessionId,
            hostKind: hostKind,
            engineBuildId: engine
        )
    }
}

/// Surface binding: exactly one locator + generation + connection identity.
public struct SurfaceBinding: Equatable, Sendable, Hashable {
    public var locator: SessionLocator
    public var connectionId: String

    public init(locator: SessionLocator, connectionId: String) {
        self.locator = locator
        self.connectionId = connectionId
    }

    public var generation: Int { locator.generation }
}

/// Terminal pixel/cell geometry — never 0×0 for attached terminals.
public struct TerminalGeometry: Equatable, Sendable, Encodable {
    public var columns: Int
    public var rows: Int
    public var widthPx: Int
    public var heightPx: Int
    public var cellWidthPx: Double
    public var cellHeightPx: Double

    public init(
        columns: Int,
        rows: Int,
        widthPx: Int,
        heightPx: Int,
        cellWidthPx: Double,
        cellHeightPx: Double
    ) {
        self.columns = columns
        self.rows = rows
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.cellWidthPx = cellWidthPx
        self.cellHeightPx = cellHeightPx
    }

    public var isUsable: Bool {
        columns > 0 && rows > 0 && widthPx > 0 && heightPx > 0
    }

    public func jsonObject() -> [String: Any] {
        [
            "columns": columns,
            "rows": rows,
            "widthPx": widthPx,
            "heightPx": heightPx,
            "cellWidthPx": cellWidthPx,
            "cellHeightPx": cellHeightPx,
        ]
    }

}

public struct AttachGrant: Equatable, Sendable {
    public var locator: SessionLocator
    public var endpoint: String
    public var token: String
    public var expiresAt: String
    public var engineBuildId: String
    public var checkpointSeq: UInt64
    public var outputSeq: UInt64
    public var operations: [String]

    public init(
        locator: SessionLocator,
        endpoint: String,
        token: String,
        expiresAt: String,
        engineBuildId: String,
        checkpointSeq: UInt64,
        outputSeq: UInt64,
        operations: [String]
    ) {
        self.locator = locator
        self.endpoint = endpoint
        self.token = token
        self.expiresAt = expiresAt
        self.engineBuildId = engineBuildId
        self.checkpointSeq = checkpointSeq
        self.outputSeq = outputSeq
        self.operations = operations
    }

    public static func parse(_ object: [String: Any]) throws -> AttachGrant {
        guard let locatorObject = object["locator"] as? [String: Any],
              let endpoint = object["endpoint"] as? String,
              let token = object["token"] as? String,
              let expiresAt = object["expiresAt"] as? String,
              let engineBuildId = object["engineBuildId"] as? String,
              let checkpointSeqString = object["checkpointSeq"] as? String,
              let outputSeqString = object["outputSeq"] as? String,
              let operations = object["operations"] as? [String],
              let checkpointSeq = UInt64(checkpointSeqString),
              let outputSeq = UInt64(outputSeqString)
        else {
            throw WireError.malformedPayload("AttachGrant")
        }
        return AttachGrant(
            locator: try SessionLocator.parse(locatorObject),
            endpoint: endpoint,
            token: token,
            expiresAt: expiresAt,
            engineBuildId: engineBuildId,
            checkpointSeq: checkpointSeq,
            outputSeq: outputSeq,
            operations: operations
        )
    }
}

public enum TerminalSurfaceState: Equatable, Sendable {
    case starting
    case attaching
    case replaying
    case live
    case delayed(evidence: String)
    case orphaned(evidence: String)
    case exited(evidence: String)
    case lost(evidence: String)
    case incompatibleEngine(evidence: String)
    case unauthorized(evidence: String)
    case rendererFailed(evidence: String)

    public var isFailure: Bool {
        switch self {
        case .starting, .attaching, .replaying, .live:
            return false
        default:
            return true
        }
    }
}

public enum InputClaimPresentation: Equatable, Sendable {
    case free
}

public enum InputSubmissionState: Equatable, Sendable {
    case idle
    case waitingForClaim
    case pending(transactionId: String)
    case applied(transactionId: String, stage: String)
}
