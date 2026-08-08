// OuterHorizonSnapshot.swift Decodes the Workspace snapshot envelope into the hierarchy entity types the Live Run outer horizon renders. The envelope stays generic on the daemon, so this boundary verifies its version and digest before dispatching each known hierarchy kind into the frozen v2 decoder. Entity kind is deliberately open-ended. A newer daemon's kind stays in `.unknown` with its exact spelling so the screen can name what this client does not understand. The closed hierarchy-v2 enums remain strict.

import Foundation

public enum OuterHorizonEntityKind: Codable, Equatable, Sendable {
    case agent
    case run
    case node
    case budget
    case review
    case incident
    case strandedManifest
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "agent": self = .agent
        case "hierarchy-run": self = .run
        case "hierarchy-node": self = .node
        case "hierarchy-budget": self = .budget
        case "hierarchy-review": self = .review
        case "hierarchy-incident": self = .incident
        case "hierarchy-stranded-manifest": self = .strandedManifest
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agent: return "agent"
        case .run: return "hierarchy-run"
        case .node: return "hierarchy-node"
        case .budget: return "hierarchy-budget"
        case .review: return "hierarchy-review"
        case .incident: return "hierarchy-incident"
        case .strandedManifest: return "hierarchy-stranded-manifest"
        case .unknown(let rawValue): return rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct OuterHorizonUnknownEntity: Equatable, Sendable {
    public let kind: String
    public let id: String
    public let entityRevision: String
}

public struct OuterHorizonSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let instanceId: String
    public let seq: String
    public let createdAt: String
    public let contentSha256: String
    public let runs: [HierarchyRunProjection]
    public let nodes: [HierarchyNodeProjection]
    public let budgets: [HierarchyBudgetProjection]
    public let reviews: [HierarchyReviewProjection]
    public let incidents: [HierarchyIncidentProjection]
    public let strandedManifests: [HierarchyStrandedManifestProjection]
    public let unknownEntities: [OuterHorizonUnknownEntity]

    private let entities: [EntityEnvelope]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion
        case instanceId
        case seq
        case entities
        case createdAt
        case contentSha256
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(from: decoder, allowing: CodingKeys.allCases.map(\.rawValue))
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 2 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "the outer horizon requires WorkspaceSnapshotV2")
        }
        instanceId = try container.decode(String.self, forKey: .instanceId)
        seq = try container.decode(String.self, forKey: .seq)
        entities = try container.decode([EntityEnvelope].self, forKey: .entities)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        contentSha256 = try container.decode(String.self, forKey: .contentSha256)
        guard !instanceId.isEmpty, UInt64(seq) != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .seq,
                in: container,
                debugDescription: "snapshot identity and sequence must be present")
        }

        let snapshot = WorkspaceStatusSnapshot(
            schemaVersion: schemaVersion,
            instanceId: instanceId,
            seq: seq,
            entities: entities.map(\.workspaceEntity),
            createdAt: createdAt,
            contentSha256: contentSha256)
        _ = try WorkspaceStatusReducer.reconcile(
            WorkspaceStatusProjection(), snapshot: snapshot)

        var runs: [HierarchyRunProjection] = []
        var nodes: [HierarchyNodeProjection] = []
        var budgets: [HierarchyBudgetProjection] = []
        var reviews: [HierarchyReviewProjection] = []
        var incidents: [HierarchyIncidentProjection] = []
        var stranded: [HierarchyStrandedManifestProjection] = []
        var unknown: [OuterHorizonUnknownEntity] = []
        for entity in entities {
            switch entity.kind {
            case .agent:
                continue
            case .run:
                runs.append(try entity.decode(HierarchyRunProjection.self))
            case .node:
                nodes.append(try entity.decode(HierarchyNodeProjection.self))
            case .budget:
                budgets.append(try entity.decode(HierarchyBudgetProjection.self))
            case .review:
                reviews.append(try entity.decode(HierarchyReviewProjection.self))
            case .incident:
                incidents.append(try entity.decode(HierarchyIncidentProjection.self))
            case .strandedManifest:
                stranded.append(try entity.decode(HierarchyStrandedManifestProjection.self))
            case .unknown(let rawValue):
                unknown.append(OuterHorizonUnknownEntity(
                    kind: rawValue,
                    id: entity.id,
                    entityRevision: entity.entityRevision))
            }
        }
        self.runs = runs
        self.nodes = nodes
        self.budgets = budgets
        self.reviews = reviews
        self.incidents = incidents
        strandedManifests = stranded
        unknownEntities = unknown
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(seq, forKey: .seq)
        try container.encode(entities, forKey: .entities)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(contentSha256, forKey: .contentSha256)
    }
}

public struct OuterHorizonNavigationHistory: Equatable, Sendable {
    public private(set) var selectedNodeId: String?
    public private(set) var expandedNodeIds: Set<String>
    private var initialized: Bool

    public init(
        selectedNodeId: String? = nil,
        expandedNodeIds: Set<String> = [],
        initialized: Bool = false
    ) {
        self.selectedNodeId = selectedNodeId
        self.expandedNodeIds = expandedNodeIds
        self.initialized = initialized
    }

    /// Seeds only the first snapshot. Later disappearance keeps the semantic ID in history so a returning node regains focus instead of silently moving focus to an unrelated row.
    public mutating func observe(_ nodes: [HierarchyNodeProjection]) {
        guard !initialized else { return }
        initialized = true
        selectedNodeId = nodes.first?.nodeId
        let parentIds = Set(nodes.compactMap { node -> String? in
            guard case .present(let parent) = node.parentNodeId else { return nil }
            return parent.value
        })
        expandedNodeIds = Set(nodes.map(\.nodeId).filter(parentIds.contains))
    }

    public mutating func select(nodeId: String) {
        selectedNodeId = nodeId
    }

    public mutating func toggleExpansion(nodeId: String) {
        if expandedNodeIds.contains(nodeId) {
            expandedNodeIds.remove(nodeId)
        } else {
            expandedNodeIds.insert(nodeId)
        }
    }

    public func visibleSelection(in nodes: [HierarchyNodeProjection]) -> String? {
        guard let selectedNodeId,
              nodes.contains(where: { $0.nodeId == selectedNodeId }) else { return nil }
        return selectedNodeId
    }
}

/// The Live Run value plus navigation keyed by semantic node IDs. Replacing a snapshot never replaces this history, so a redraw cannot turn row position into identity or move focus merely because another node arrived first.
public struct OuterHorizonScreenState: Equatable, Sendable {
    public private(set) var snapshot: OuterHorizonSnapshot
    public private(set) var navigation: OuterHorizonNavigationHistory

    public init(
        snapshot: OuterHorizonSnapshot,
        navigation: OuterHorizonNavigationHistory = OuterHorizonNavigationHistory()
    ) {
        self.snapshot = snapshot
        self.navigation = navigation
        self.navigation.observe(snapshot.nodes)
    }

    public mutating func observe(_ snapshot: OuterHorizonSnapshot) {
        self.snapshot = snapshot
        navigation.observe(snapshot.nodes)
    }

    public mutating func select(nodeId: String) {
        navigation.select(nodeId: nodeId)
    }

    public mutating func toggleExpansion(nodeId: String) {
        navigation.toggleExpansion(nodeId: nodeId)
    }

    public var visibleRows: [OuterHorizonTreeRow] {
        OuterHorizonTree.visibleRows(
            nodes: snapshot.nodes,
            expandedNodeIds: navigation.expandedNodeIds)
    }

    public var selectedNode: HierarchyNodeProjection? {
        guard let nodeId = navigation.visibleSelection(in: snapshot.nodes) else {
            return nil
        }
        return snapshot.nodes.first { $0.nodeId == nodeId }
    }
}

public struct OuterHorizonTreeRow: Equatable, Sendable {
    public let node: HierarchyNodeProjection
    public let depth: Int
    public let hasChildren: Bool
    public let parentDiagnostic: String?
}

public enum OuterHorizonTree {
    /// Preserves snapshot order and uses only the projected parent field. Absent, dangling, or cyclic parents remain visible as diagnostic roots.
    public static func visibleRows(
        nodes: [HierarchyNodeProjection],
        expandedNodeIds: Set<String>
    ) -> [OuterHorizonTreeRow] {
        let ids = Set(nodes.map(\.nodeId))
        var children: [String: [HierarchyNodeProjection]] = [:]
        var roots: [(HierarchyNodeProjection, String?)] = []
        for node in nodes {
            switch node.parentNodeId {
            case .present(let parent):
                if let parentId = parent.value, ids.contains(parentId) {
                    children[parentId, default: []].append(node)
                } else if let parentId = parent.value {
                    roots.append((node, "parent \(parentId) is not in this snapshot"))
                } else {
                    roots.append((node, nil))
                }
            case .absent(let reason, let detail):
                roots.append((node, "\(reason.rawValue): \(detail)"))
            }
        }

        var rows: [OuterHorizonTreeRow] = []
        var visited = Set<String>()
        func append(_ node: HierarchyNodeProjection, depth: Int, diagnostic: String?) {
            guard visited.insert(node.nodeId).inserted else { return }
            let descendants = children[node.nodeId] ?? []
            rows.append(OuterHorizonTreeRow(
                node: node,
                depth: depth,
                hasChildren: !descendants.isEmpty,
                parentDiagnostic: diagnostic))
            guard expandedNodeIds.contains(node.nodeId) else { return }
            for child in descendants {
                append(child, depth: depth + 1, diagnostic: nil)
            }
        }
        for (root, diagnostic) in roots {
            append(root, depth: 0, diagnostic: diagnostic)
        }
        for node in nodes where !visited.contains(node.nodeId) {
            append(node, depth: 0, diagnostic: "parent cycle or disconnected subtree")
        }
        return rows
    }
}

private struct EntityEnvelope: Codable, Equatable, Sendable {
    let kind: OuterHorizonEntityKind
    let id: String
    let generation: Int?
    let entityRevision: String
    let projection: [String: WorkspaceJSONValue]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case id
        case generation
        case entityRevision
        case projection
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownKeys(from: decoder, allowing: CodingKeys.allCases.map(\.rawValue))
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(OuterHorizonEntityKind.self, forKey: .kind)
        id = try container.decode(String.self, forKey: .id)
        if container.contains(.generation) {
            guard try !container.decodeNil(forKey: .generation) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .generation,
                    in: container,
                    debugDescription: "generation is omitted when absent, never null")
            }
            let value = try container.decode(Int.self, forKey: .generation)
            guard value > 0 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .generation,
                    in: container,
                    debugDescription: "generation must be positive")
            }
            generation = value
        } else {
            generation = nil
        }
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        projection = try container.decode(
            [String: WorkspaceJSONValue].self,
            forKey: .projection)
        guard !id.isEmpty, UInt64(entityRevision) != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .entityRevision,
                in: container,
                debugDescription: "entity identity and revision must be valid")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(generation, forKey: .generation)
        try container.encode(entityRevision, forKey: .entityRevision)
        try container.encode(projection, forKey: .projection)
    }

    var workspaceEntity: WorkspaceStatusSnapshot.Entity {
        WorkspaceStatusSnapshot.Entity(
            kind: kind.rawValue,
            id: id,
            generation: generation,
            entityRevision: entityRevision,
            projection: projection)
    }

    func decode<Value: Decodable>(_ type: Value.Type) throws -> Value {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(projection))
    }
}

private struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private func rejectUnknownKeys(from decoder: Decoder, allowing allowed: [String]) throws {
    let container = try decoder.container(keyedBy: AnyCodingKey.self)
    let allowed = Set(allowed)
    guard let key = container.allKeys.first(where: { !allowed.contains($0.stringValue) })
    else { return }
    throw DecodingError.dataCorrupted(
        DecodingError.Context(
            codingPath: decoder.codingPath + [key],
            debugDescription: "unexpected envelope field \(key.stringValue)"))
}
