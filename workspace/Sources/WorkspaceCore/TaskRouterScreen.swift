// TaskRouterScreen.swift The routing document as the Task Router screen edits it. The editor keeps a draft separate from the last daemon observation so a compare-and-set rejection can show both versions without losing the edit.

import Foundation

extension RoutingPolicyDocument.CandidateEffort {
    /// The inverse of `asWireEffort.cliArgument`, for the spellings this build can write. Anything else stays unknown rather than being respelled into an effort the user did not choose.
    public init(cliArgument: String) {
        switch cliArgument {
        case "hive-decides": self = .hiveDecides
        case "none": self = RoutingPolicyDocument.CandidateEffort.none
        case "provider-controlled": self = .providerControlled
        default:
            let exact = "exact:"
            self = cliArgument.hasPrefix(exact)
                ? .exact(String(cliArgument.dropFirst(exact.count)))
                : .unknown(cliArgument)
        }
    }
}

public struct TaskRouterSnapshot: Codable, Equatable, Sendable {
    public var policy: RoutingPolicyDocument

    public init(policy: RoutingPolicyDocument) {
        self.policy = policy
    }
}

public struct RoutingPolicyMutationBody: Codable, Equatable, Sendable {
    public let op: String
    public let expectedRevision: Int
    public let scope: String
    public let route: RoutingPolicyDocument.WireRoute?

    public init(
        expectedRevision: Int,
        scope: String,
        route: RoutingPolicyDocument.WireRoute?
    ) {
        op = "set-route"
        self.expectedRevision = expectedRevision
        self.scope = scope
        self.route = route
    }

    private enum CodingKeys: String, CodingKey {
        case op
        case expectedRevision
        case scope
        case route
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(op, forKey: .op)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        try container.encode(scope, forKey: .scope)
        if let route {
            try container.encode(route, forKey: .route)
        } else {
            try container.encodeNil(forKey: .route)
        }
    }
}

public struct ProviderEnablementMutationBody: Codable, Equatable, Sendable {
    public let op: String
    public let expectedRevision: Int
    public let provider: String
    public let state: String

    public init(expectedRevision: Int, provider: String, enabled: Bool) {
        op = "set-provider"
        self.expectedRevision = expectedRevision
        self.provider = provider
        state = enabled ? "enabled" : "disabled"
    }
}

public struct ModelEnablementMutationBody: Codable, Equatable, Sendable {
    public let op: String
    public let expectedRevision: Int
    public let provider: String
    public let model: String
    public let state: String

    public init(expectedRevision: Int, provider: String, model: String, enabled: Bool) {
        op = "set-model"
        self.expectedRevision = expectedRevision
        self.provider = provider
        self.model = model
        state = enabled ? "enabled" : "disabled"
    }
}

/// One editable membership row on the router screen: a model the discovery catalog (or the policy, when the catalog cannot resolve it) knows about, and the draft route's candidate for it when the model is currently a member.
public struct TaskRouterRow: Equatable, Sendable {
    public let provider: String
    public let model: String
    public let candidate: RoutingPolicyDocument.WireRouteCandidate?
    public let unresolvable: Bool

    public var isMember: Bool { candidate != nil }

    public init(
        provider: String,
        model: String,
        candidate: RoutingPolicyDocument.WireRouteCandidate?,
        unresolvable: Bool = false
    ) {
        self.provider = provider
        self.model = model
        self.candidate = candidate
        self.unresolvable = unresolvable
    }
}

/// Counts the Task Router summary may name. Each field is one fact from the
/// draft policy document — never Model Control row-state, which answers a
/// different question and is what made "1 enabled models" contradict a table
/// of catalogued candidates.
public struct TaskRouterSummaryFacts: Equatable, Sendable {
    public let configuredRoutes: Int
    public let totalRoutes: Int
    public let enabledProviders: Int
    public let listedProviders: Int
    public let providersKnown: Bool
    public let routeMembers: Int
    public let enabledPolicyModels: Int
}

public struct TaskRouterEditor: Equatable, Sendable {
    public private(set) var observed: TaskRouterSnapshot
    public private(set) var draft: TaskRouterSnapshot
    public private(set) var competingRevision: Int?
    public private(set) var lastOperationID: String?
    public private(set) var postStateToken: MutationExpectation?
    public private(set) var mutationsAllowed: Bool

    public init(
        snapshot: TaskRouterSnapshot,
        availability: ProjectionAvailability = .current
    ) {
        observed = snapshot
        draft = snapshot
        mutationsAllowed = availability == .current
    }

    public var hasDraft: Bool { draft.policy != observed.policy }

    /// The rows one category's editor offers. When the daemon's routing catalog is non-empty, rows start from it, then union in any policy model or draft candidate the daemon could not resolve and mark that row `unresolvable`. An empty catalog means the projection was unavailable; the transient editor keeps policy rows visible without inventing eligibility.
    public func rows(
        for category: TaskCategory,
        catalog: [WorkspaceRoutingCatalogEntry] = []
    ) -> [TaskRouterRow] {
        let candidates = draft.policy.categories[category.rawValue]?.candidates ?? []
        let catalogSet = Set(catalog.map { "\($0.provider)/\($0.model)" })
        let hasCatalog = !catalog.isEmpty

        var keys: [[String]] = []
        if hasCatalog {
            for entry in catalog {
                let key = [entry.provider, entry.model]
                if !keys.contains(key) { keys.append(key) }
            }
        } else {
            for row in draft.policy.models {
                let key = [row.provider, row.model]
                if !keys.contains(key) { keys.append(key) }
            }
        }
        for row in draft.policy.models {
            let key = [row.provider, row.model]
            if !keys.contains(key) { keys.append(key) }
        }
        for candidate in candidates {
            let key = [candidate.provider, candidate.model]
            if !keys.contains(key) { keys.append(key) }
        }

        return keys.sorted { $0.joined() < $1.joined() }.map { key in
            let id = "\(key[0])/\(key[1])"
            return TaskRouterRow(
                provider: key[0],
                model: key[1],
                candidate: candidates.first {
                    $0.provider == key[0] && $0.model == key[1]
                },
                unresolvable: hasCatalog && !catalogSet.contains(id))
        }
    }

    /// Columns for the task/provider matrix. The presentation's provider map
    /// supplies the five vendors even when a vendor has no members; policy,
    /// catalog, and draft candidates can only add columns, never hide one.
    public func matrixProviders(
        routing: WorkspaceRoutingPresentation
    ) -> [String] {
        var ids = Set(routing.providers.keys)
        ids.formUnion(draft.policy.providers.keys)
        for entry in routing.catalog { ids.insert(entry.provider) }
        for route in draft.policy.categories.values {
            for candidate in route.candidates { ids.insert(candidate.provider) }
        }
        return ids.sorted { ProviderID($0) < ProviderID($1) }
    }

    /// Members already on this category for one vendor. Empty is a real empty
    /// cell — the matrix does not invent a candidate to fill the design.
    public func matrixMembers(
        for category: TaskCategory,
        provider: String,
        catalog: [WorkspaceRoutingCatalogEntry]
    ) -> [TaskRouterRow] {
        rows(for: category, catalog: catalog).filter {
            $0.provider == provider && $0.isMember
        }
    }

    /// What the selected cell can edit: current members plus catalog models
    /// that vendor can still join. Policy-only non-members stay off the cell
    /// because they cannot be added.
    public func editorRows(
        for category: TaskCategory,
        provider: String,
        catalog: [WorkspaceRoutingCatalogEntry]
    ) -> [TaskRouterRow] {
        let catalogSet = Set(catalog.map { "\($0.provider)/\($0.model)" })
        return rows(for: category, catalog: catalog).filter { row in
            row.provider == provider
                && (row.isMember || catalogSet.contains("\(row.provider)/\(row.model)"))
        }
    }

    public func summaryFacts(categories: [TaskCategory]) -> TaskRouterSummaryFacts {
        let configured = categories.filter {
            draft.policy.categories[$0.rawValue] != nil
        }.count
        let providers = draft.policy.providers
        var memberKeys = Set<String>()
        for item in categories {
            let candidates = draft.policy.categories[item.rawValue]?.candidates ?? []
            for candidate in candidates {
                memberKeys.insert("\(candidate.provider)/\(candidate.model)")
            }
        }
        return TaskRouterSummaryFacts(
            configuredRoutes: configured,
            totalRoutes: categories.count,
            enabledProviders: providers.values.filter { $0 == "enabled" }.count,
            listedProviders: providers.count,
            providersKnown: !providers.isEmpty,
            routeMembers: memberKeys.count,
            enabledPolicyModels: draft.policy.models.filter { $0.state == "enabled" }.count)
    }

    public mutating func fence() {
        mutationsAllowed = false
    }

    /// Takes a fresh observation without discarding the unapplied edit — refreshing is how a fence is meant to clear, so it must not cost the user the draft the fence existed to protect. Every category they changed is re-applied over the new document; everything else follows the daemon. A draft the daemon has since caught up with resolves itself: it becomes equal to the observation and there is nothing left to send.
    public mutating func observe(_ refreshed: TaskRouterEditor) {
        let edited = draft.policy.categories.filter {
            observed.policy.categories[$0.key] != $0.value
        }
        let cleared = observed.policy.categories.keys.filter {
            draft.policy.categories[$0] == nil
        }
        observed = refreshed.observed
        var reconciled = refreshed.observed.policy
        for (category, route) in edited { reconciled.categories[category] = route }
        for category in cleared { reconciled.categories.removeValue(forKey: category) }
        draft = TaskRouterSnapshot(policy: reconciled)
        competingRevision = nil
        mutationsAllowed = refreshed.mutationsAllowed
    }

    public mutating func setRoute(
        _ route: RoutingPolicyDocument.WireRoute?,
        for category: TaskCategory
    ) {
        draft.policy.categories[category.rawValue] = route
        competingRevision = nil
    }

    public func mutation(
        for category: TaskCategory,
        intentID: String
    ) -> MutationIntent<RoutingPolicyMutationBody>? {
        guard mutationsAllowed else { return nil }
        return MutationIntent(
            intentID: intentID,
            expected: .revision(String(observed.policy.revision)),
            idempotencyKey: intentID,
            body: RoutingPolicyMutationBody(
                expectedRevision: observed.policy.revision,
                scope: category.rawValue,
                route: draft.policy.categories[category.rawValue] ?? nil))
    }

    /// Accepted writes adopt the daemon's final read-back. Rejections update only the observed competitor; the user's draft remains byte-for-byte.
    public mutating func apply(_ result: MutationResult<RoutingPolicyDocument>) {
        lastOperationID = result.operationID
        postStateToken = result.postStateToken
        switch result.outcome {
        case .accepted:
            observed.policy = result.observedPostState
            draft.policy = result.observedPostState
            competingRevision = nil
        case .rejected:
            observed.policy = result.observedPostState
            competingRevision = result.observedPostState.revision
        }
    }
}
