
import Foundation
import WorkspaceCore

struct MemoryOverviewGateway {
    static let read = WorkspaceReadEndpoint<MemoryOverviewProjection>(
        path: "memory/overview",
        source: { ProjectionSource(revision: $0.sourceRevision) },
        observedAt: { $0.observedAt })

    let client: WorkspaceDaemonClient

    func fetch() async -> ClientProjection<MemoryOverviewProjection> {
        let projection = await client.fetch(Self.read)
        return classifyCached(projection, freshness: projection.value?.freshness)
    }
}

struct MemoryLibraryGateway {
    /// The daemon pages this wire itself: it mints `nextCursor` and reads back the
    /// cursor it minted. This client passes one through and never composes an
    /// offset of its own, so a page is always one the store actually served.
    static func read(step: MemoryLibraryStep) -> WorkspaceReadEndpoint<MemoryLibraryProjection> {
        WorkspaceReadEndpoint<MemoryLibraryProjection>(
            path: "memory/library",
            queryItems: {
                switch step {
                case .first: return []
                case .cursor(let cursor): return [URLQueryItem(name: "cursor", value: cursor)]
                }
            }(),
            source: { ProjectionSource(revision: $0.sourceRevision) },
            observedAt: { $0.observedAt })
    }

    let client: WorkspaceDaemonClient

    func fetch(
        step: MemoryLibraryStep = .first
    ) async -> ClientProjection<MemoryLibraryProjection> {
        let projection = await client.fetch(Self.read(step: step))
        return classifyCached(projection, freshness: projection.value?.freshness)
    }
}

struct MemoryRecallGateway {
    static let read = WorkspaceReadEndpoint<MemoryRecallPreview>(
        path: "memory/recall-preview",
        source: { ProjectionSource(revision: $0.sourceRevision) },
        observedAt: { $0.observedAt })

    let client: WorkspaceDaemonClient
    let now: () -> Date

    init(client: WorkspaceDaemonClient, now: @escaping () -> Date = Date.init) {
        self.client = client
        self.now = now
    }

    func fetch(query: String) async throws -> ClientProjection<MemoryRecallPreview> {
        let lostAt = ISO8601DateFormatter().string(from: now())
        do {
            let (data, response) = try await client.send(
                path: Self.read.path,
                method: "POST",
                body: MemoryRecallRequest(query: query))
            if response.statusCode == 401 || response.statusCode == 403 {
                return try projection(
                    availability: .unauthorized,
                    evidence: .unauthorized(
                        refusalCode: RefusalBody(data: data).code.displayValue))
            }
            guard (200..<300).contains(response.statusCode) else {
                throw GatewayError.refused(
                    response.statusCode,
                    RefusalBody(data: data).detail)
            }
            let value = try JSONDecoder().decode(MemoryRecallPreview.self, from: data)
            let stale = value.freshness == .cached
            return try ClientProjection(
                source: ProjectionSource(revision: value.sourceRevision),
                observedAt: value.observedAt,
                freshness: stale ? .stale : .current,
                availability: stale ? .stale : .current,
                evidence: nil,
                value: value)
        } catch let error as GatewayError {
            throw error
        } catch {
            return try! projection(
                availability: .disconnected,
                evidence: .disconnected(
                    transportLostAt: "\(lostAt): \(error.localizedDescription)"))
        }
    }

    enum GatewayError: LocalizedError {
        case refused(Int, String)

        var errorDescription: String? {
            switch self {
            case .refused(let status, let detail):
                return "The daemon refused this recall preview (HTTP \(status)): \(detail). "
                    + "The observed results were not changed."
            }
        }
    }

    private func projection(
        availability: ProjectionAvailability,
        evidence: ProjectionEvidence
    ) throws -> ClientProjection<MemoryRecallPreview> {
        try ClientProjection(
            source: ProjectionSource(), observedAt: nil, freshness: .unknown,
            availability: availability, evidence: evidence, value: nil)
    }
}

struct MemoryMaintenanceGateway {
    static let read = WorkspaceReadEndpoint<MemoryMaintenanceProjection>(
        path: "memory/maintenance",
        source: { ProjectionSource(revision: $0.sourceRevision) },
        observedAt: { $0.observedAt })
    static let jobsPath = "memory/jobs"

    let client: WorkspaceDaemonClient

    func fetch() async -> ClientProjection<MemoryMaintenanceProjection> {
        let projection = await client.fetch(Self.read)
        return classifyCached(projection, freshness: projection.value?.freshness)
    }

    /// Starts one daemon job and reads the authoritative queue afterwards. A refusal is thrown before that read, which keeps the observed projection unchanged and lets the caller show the refusal as an action banner.
    func submit(_ request: MemoryJobRequest) async throws -> Submission {
        let (data, response) = try await client.send(
            path: Self.jobsPath, method: "POST", body: request)
        guard (200..<300).contains(response.statusCode) else {
            throw GatewayError.refused(response.statusCode, RefusalBody(data: data).detail)
        }
        let receipt = try JSONDecoder().decode(MemoryJobReceipt.self, from: data)
        let readBack = await fetch()
        guard readBack.value != nil else {
            throw GatewayError.postStateUnknown(readBack)
        }
        return Submission(receipt: receipt, readBack: readBack)
    }

    /// The jobs wire names the accepted operation with a receipt but carries no compare-and-set or idempotency contract. Callers must never retry this submission automatically after an unknown transport outcome.
    struct Submission {
        let receipt: MemoryJobReceipt
        let readBack: ClientProjection<MemoryMaintenanceProjection>
    }

    enum GatewayError: LocalizedError {
        case refused(Int, String)
        case postStateUnknown(ClientProjection<MemoryMaintenanceProjection>)

        var errorDescription: String? {
            switch self {
            case .refused(let status, let detail):
                return "The daemon refused this memory job (HTTP \(status)): \(detail). "
                    + "The observed queue was not changed."
            case .postStateUnknown:
                return "The job may have started, but its queue could not be read back."
            }
        }
    }
}

private func classifyCached<Value>(
    _ projection: ClientProjection<Value>,
    freshness: MemoryPayloadFreshness?
) -> ClientProjection<Value> where Value: Codable & Equatable & Sendable {
    guard freshness == .cached, projection.availability == .current else {
        return projection
    }
    return try! ClientProjection(
        source: projection.source,
        observedAt: projection.observedAt,
        freshness: .stale,
        availability: .stale,
        evidence: nil,
        value: projection.value)
}
