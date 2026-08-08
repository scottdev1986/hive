
import Foundation
import WorkspaceCore

struct WorkspaceReadEndpoint<Value> where Value: Codable & Equatable & Sendable {
    let path: String
    let queryItems: [URLQueryItem]
    let source: (Value) -> ProjectionSource
    let observedAt: (Value) -> String?

    init(
        path: String,
        queryItems: [URLQueryItem] = [],
        source: @escaping (Value) -> ProjectionSource,
        observedAt: @escaping (Value) -> String?
    ) {
        self.path = path
        self.queryItems = queryItems
        self.source = source
        self.observedAt = observedAt
    }
}

enum WorkspaceRefusalCode: Equatable, Sendable {
    case known(String)
    case unknown

    var displayValue: String {
        switch self {
        case .known(let value): return value
        case .unknown: return "unknown"
        }
    }
}

/// One decoded daemon refusal body, shared by every gateway. The daemon names a
/// refusal with any of "code", "reason", or "error"; two readers that ranked
/// those keys differently read two different codes from the same body, so the
/// ranking lives here exactly once.
struct RefusalBody {
    let code: WorkspaceRefusalCode
    let detail: String

    init(data: Data) {
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let code = Self.firstString(in: object, keys: ["code", "reason", "error"]) {
            self.code = .known(code)
        } else {
            self.code = .unknown
        }
        if let detail = Self.firstString(
            in: object, keys: ["error", "message", "reason", "code"])
        {
            self.detail = detail
        } else if let body = String(data: data, encoding: .utf8), !body.isEmpty {
            detail = body
        } else {
            detail = "unknown"
        }
    }

    private static func firstString(in object: [String: Any]?, keys: [String]) -> String? {
        for key in keys {
            if let value = object?[key] as? String, !value.isEmpty { return value }
        }
        return nil
    }
}

enum WorkspaceReadResult<Value> where Value: Codable & Equatable & Sendable {
    case projection(ClientProjection<Value>)
    case refused(status: Int, code: WorkspaceRefusalCode, detail: String)
    case invalid(detail: String)
}

final class WorkspaceDaemonClient {
    typealias Loader = (URLRequest) async throws -> (Data, HTTPURLResponse)

    enum ResponseError: LocalizedError {
        case transport(String)
        case protocolDrift(String)

        var errorDescription: String? {
            switch self {
            case .transport(let reason), .protocolDrift(let reason): return reason
            }
        }

        var availability: ProjectionAvailability {
            switch self {
            case .transport: return .disconnected
            case .protocolDrift: return .unknown
            }
        }

        var evidence: ProjectionEvidence {
            switch self {
            case .transport(let reason): return .disconnected(transportLostAt: reason)
            case .protocolDrift(let reason): return .protocolDrift(reason: reason)
            }
        }
    }

    private let baseURL: URL
    private let authorization: String
    private let now: () -> Date
    private let loader: Loader

    init(
        baseURL: URL,
        authorization: String,
        now: @escaping () -> Date = Date.init,
        loader: @escaping Loader = WorkspaceDaemonClient.urlSessionLoad
    ) {
        self.baseURL = baseURL
        self.authorization = authorization
        self.now = now
        self.loader = loader
    }

    func fetch<Value>(
        _ endpoint: WorkspaceReadEndpoint<Value>
    ) async -> ClientProjection<Value> where Value: Codable & Equatable & Sendable {
        switch await fetchResult(endpoint) {
        case .projection(let projection):
            return projection
        case .refused(let status, let code, _):
            if status == 401 || status == 403 {
                return try! projection(
                    availability: .unauthorized,
                    evidence: .unauthorized(refusalCode: code.displayValue))
            }
            return try! projection(
                availability: .unknown,
                evidence: .refused(statusCode: status))
        case .invalid(let detail):
            return try! projection(
                availability: .unknown,
                evidence: .protocolDrift(reason: detail))
        }
    }

    /// Keeps an HTTP refusal and a schema failure separate from transport loss. Screen gateways that need a refusal banner consume this result directly; the simpler `fetch` remains available for projection-only screens.
    func fetchResult<Value>(
        _ endpoint: WorkspaceReadEndpoint<Value>
    ) async -> WorkspaceReadResult<Value> where Value: Codable & Equatable & Sendable {
        let lostAt = Self.timestamp(now())
        let loaded: (Data, HTTPURLResponse)
        do {
            loaded = try await loader(request(
                path: endpoint.path, queryItems: endpoint.queryItems, method: "GET"))
        } catch {
            return .projection(try! projection(
                availability: .disconnected,
                evidence: .disconnected(
                    transportLostAt: "\(lostAt): \(error.localizedDescription)")))
        }

        let (data, response) = loaded
        guard (200..<300).contains(response.statusCode) else {
            let refusal = RefusalBody(data: data)
            return .refused(
                status: response.statusCode,
                code: refusal.code,
                detail: refusal.detail)
        }
        do {
            let value = try JSONDecoder().decode(Value.self, from: data)
            let observedAt = endpoint.observedAt(value)
            return .projection(try ClientProjection(
                source: endpoint.source(value),
                observedAt: observedAt,
                freshness: .current,
                availability: .current,
                evidence: nil,
                value: value))
        } catch {
            return .invalid(detail: error.localizedDescription)
        }
    }

    /// One authenticated write, returned raw. Reading the status is the endpoint gateway's job: a 409 is a real answer on the routing wire and a failure on others, and this core must not pick one meaning for both.
    func send<Body: Encodable>(
        path: String,
        method: String,
        body: Body
    ) async throws -> (Data, HTTPURLResponse) {
        var request = request(path: path, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(body)
            return try await loader(request)
        } catch {
            throw ResponseError.transport(error.localizedDescription)
        }
    }

    func decode<Value>(_ type: Value.Type, from data: Data) throws -> Value where Value: Decodable {
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            throw ResponseError.protocolDrift(error.localizedDescription)
        }
    }

    private func request(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String
    ) -> URLRequest {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !queryItems.isEmpty { components.queryItems = queryItems }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        return request
    }

    private func projection<Value>(
        availability: ProjectionAvailability,
        evidence: ProjectionEvidence
    ) throws -> ClientProjection<Value> where Value: Codable & Equatable & Sendable {
        try ClientProjection(
            source: ProjectionSource(), observedAt: nil, freshness: .unknown,
            availability: availability, evidence: evidence, value: nil)
    }

    private static func urlSessionLoad(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WorkspaceTransportError.notHTTP
        }
        return (data, http)
    }

    private static func timestamp(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

private enum WorkspaceTransportError: Error {
    case notHTTP
}
