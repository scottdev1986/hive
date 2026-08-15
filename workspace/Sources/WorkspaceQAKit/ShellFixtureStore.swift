// ShellFixtureStore.swift Loads the frozen client-projection corpora from a directory and resolves them into the shell's render state. This is the development wiring for the new shell: the same ClientProjection decode the wire tests pin, the same seven availability rows, one row per screen chosen by the launch scenario. ShellLiveStore is its daemon-backed counterpart and builds the same state, so screens and banners cannot tell the two sources apart.

import Foundation
import HiveWorkspace
import WorkspaceCore

public struct ShellFixtureStore {
    let directory: String

    public init(directory: String) {
        self.directory = directory
    }

    /// `--workspace-shell <fixture-dir>` swaps the daemon-backed shell for a
    /// frozen corpus. Only this module parses it, so the shipped app has no
    /// argument that can select fixtures. A repeated flag takes the last
    /// directory, as any other repeated argument does.
    public static let flag = "--workspace-shell"

    public static func launchDirectory(arguments: [String]) -> String? {
        var directory: String?
        var iterator = arguments.makeIterator()
        while let argument = iterator.next() {
            if argument == flag { directory = iterator.next() }
        }
        return directory
    }

    public enum StoreError: Error, Equatable {
        case unreadableCorpus(String)
        case invalidOuterHorizonCorpus
        case missingAvailability(String, ProjectionAvailability)
        case missingAbsentScreen(String)
        case invalidAbsentRow(String)
        case invalidContract(String)
    }

    static let wiredRoutes: [ShellRoute: String] = [
        .liveRun: "workspace-snapshot-v2-corpus",
        .taskRouter: "routing-inspection-corpus",
        .modelsQuota: "model-control-corpus",
        .queen: "queen-provider-corpus",
        .memoryOverview: "memory-overview-corpus",
        .memoryLibrary: "memory-library-corpus",
        .memoryRecallLab: "memory-recall-corpus",
        .memoryMaintenance: "memory-maintenance-corpus",
    ]
    static let absentCorpus = "shell-absent-screens-corpus"
    /// The corpus is one project's frozen reading, so its library walk is keyed to one project.
    static let fixtureProject = ProjectID("fixture")

    public func loadState(scenario: ProjectionAvailability) throws -> ShellState {
        var state = ShellState()
        let snapshot: ClientProjection<WorkspaceStatusSnapshot> = try loadRow(
            named: Self.wiredRoutes[.liveRun]!, availability: scenario)
        let outerHorizon = try loadOuterHorizon()
        state.apply(
            screen: snapshot.frozenScreen(
                facts: snapshot.value.map {
                    outerHorizon.map(outerHorizonFacts) ?? snapshotFacts($0)
                } ?? []),
            for: .liveRun)
        state.apply(
            outerHorizon: snapshot.value == nil ? nil : outerHorizon,
            warning: nil)
        let inspection: ClientProjection<RouteInspection> = try loadRow(
            named: Self.wiredRoutes[.taskRouter]!, availability: scenario)
        let policy: ClientProjection<RoutingPolicyDocument> = try loadRow(
            named: "routing-policy-corpus", availability: scenario)
        state.apply(
            screen: inspection.frozenScreen(
                facts: inspection.value.map { inspectionFacts($0, policy: policy.value) } ?? []),
            for: .taskRouter)
        if let document = policy.value {
            state.apply(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: document),
                availability: policy.availability))
        }
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            named: Self.wiredRoutes[.modelsQuota]!, availability: scenario)
        state.apply(
            screen: modelControl.frozenScreen(
                facts: modelControl.value.map(modelControlFacts) ?? []),
            for: .modelsQuota)
        state.apply(modelControl: modelControl.value)
        let queenProvider: ClientProjection<QueenProviderProjection> = try loadRow(
            named: Self.wiredRoutes[.queen]!, availability: scenario)
        state.apply(
            screen: queenProvider.frozenScreen(facts: queenProvider.value?.facts ?? []),
            for: .queen)
        if let projection = queenProvider.value {
            state.apply(queenProvider: QueenProviderEditor(
                projection: projection, availability: queenProvider.availability))
        }
        let memoryOverview: ClientProjection<MemoryOverviewProjection> = try loadRow(
            named: Self.wiredRoutes[.memoryOverview]!, availability: scenario)
        state.apply(
            screen: MemoryScreenPresenter.overview(memoryOverview),
            for: .memoryOverview)
        state.editMemory { $0.overview = memoryOverview.value }
        let memoryLibrary: ClientProjection<MemoryLibraryProjection> = try loadRow(
            named: Self.wiredRoutes[.memoryLibrary]!, availability: scenario)
        state.apply(
            screen: MemoryScreenPresenter.library(memoryLibrary),
            for: .memoryLibrary)
        if let page = memoryLibrary.value {
            state.observe(libraryPage: page, from: Self.fixtureProject, step: .first)
        }
        let memoryRecall: ClientProjection<MemoryRecallPreview> = try loadRow(
            named: Self.wiredRoutes[.memoryRecallLab]!, availability: scenario)
        state.apply(
            screen: MemoryScreenPresenter.recall(memoryRecall),
            for: .memoryRecallLab)
        state.editMemory { $0.recall = memoryRecall.value }
        let memoryMaintenance: ClientProjection<MemoryMaintenanceProjection> = try loadRow(
            named: Self.wiredRoutes[.memoryMaintenance]!, availability: scenario)
        state.apply(
            screen: MemoryScreenPresenter.maintenance(memoryMaintenance),
            for: .memoryMaintenance)
        state.editMemory { $0.maintenance = memoryMaintenance.value }
        let absent = try loadAbsentScreens()
        for route in ShellRoute.allCases where state.screens[route] == nil {
            guard let row = absent[route] else {
                throw StoreError.missingAbsentScreen(route.rawValue)
            }
            state.apply(screen: row, for: route)
        }
        let inspector = try loadInspector(
            scenario: scenario,
            snapshot: snapshot,
            routeInspection: inspection)
        state.apply(inspector: inspector.projection)
        state.apply(attention: inspector.attention)
        return state
    }

    private struct HierarchyInspectorPayload: Codable, Equatable, Sendable {
        let run: HierarchyRunProjection
        let node: HierarchyNodeProjection
        let incident: HierarchyIncidentProjection
        let stranded: HierarchyStrandedManifestProjection
    }

    private struct InspectorEventsValue: Codable, Equatable {
        let events: [WorkspaceStatusEvent]
    }

    private struct InspectorContractsValue: Codable, Equatable {
        let contracts: [InterfaceContractWire]

        struct InterfaceContractWire: Codable, Equatable {
            struct RevisionRef: Codable, Equatable {
                let revision: String
                let digest: String
            }

            let contractId: String
            let revision: String
            let runId: String
            let owningSpec: RevisionRef
            let participants: [String]
            let payloadSchema: [String: WorkspaceJSONValue]
            let behaviorDecisions: [String]
            let compatibilityDecisions: [String]
            let artifactRefs: [String]
            let acceptedBy: [HierarchyAgentBindingRef]
        }
    }

    private func loadInspector(
        scenario: ProjectionAvailability,
        snapshot: ClientProjection<WorkspaceStatusSnapshot>,
        routeInspection: ClientProjection<RouteInspection>
    ) throws -> (projection: InspectorProjection, attention: AttentionQueue) {
        var inputs = ShellInspectorPresenter.Inputs(
            snapshot: snapshot.value,
            snapshotAvailability: snapshot.availability,
            snapshotObservedAt: snapshot.observedAt,
            routeInspectionReads: [InspectorRouteInspectionRead(
                category: routeInspection.value?.category ?? "fixture category",
                result: .projection(routeInspection))],
            selectedAgentId: snapshot.value?.entities.first { $0.kind == "agent" }?.id)

        let hierarchy: ClientProjection<HierarchyInspectorPayload> = try loadRow(
            named: "hierarchy-projection-v2-corpus", availability: scenario)
        if let value = hierarchy.value {
            inputs.node = value.node
            inputs.run = value.run
            inputs.incident = value.incident
            inputs.stranded = value.stranded
        }

        let events: ClientProjection<InspectorEventsValue> = try loadRow(
            named: "inspector-events-corpus", availability: scenario)
        inputs.events = events.value?.events
        inputs.eventsAvailability = events.availability
        inputs.eventsEvidence = events.evidence

        let contracts: ClientProjection<InspectorContractsValue> = try loadRow(
            named: "inspector-declared-contracts-corpus", availability: scenario)
        for contract in contracts.value?.contracts ?? [] {
            let participantNodes = Set(contract.participants)
            let acceptingNodes = Set(contract.acceptedBy.map(\.nodeId))
            guard contract.participants.count == 2,
                  participantNodes.count == 2,
                  contract.acceptedBy.count == 2,
                  acceptingNodes == participantNodes else {
                throw StoreError.invalidContract(contract.contractId)
            }
        }
        inputs.declaredContracts = contracts.value?.contracts.map {
            InspectorDeclaredContract(
                contractId: $0.contractId,
                revision: $0.revision,
                acceptedBy: $0.acceptedBy.map {
                    "\($0.nodeId) / \($0.agentId) / g\($0.generation)"
                })
        }
        inputs.contractsAvailability = contracts.availability
        inputs.contractsEvidence = contracts.evidence

        inputs.criteriaAvailability = .unknown

        let projection = ShellInspectorPresenter.present(inputs)
        var queue = AttentionQueue()
        if case .present(let items) = inputs.stranded?.items {
            for (index, item) in items.enumerated() {
                let agent = item.agentId ?? "unknown"
                queue.raise(AttentionItem(
                    id: "stranded-\(agent)-\(index)",
                    projectID: ProjectID("fixture"),
                    paneID: PaneID(agent),
                    severity: .waiting,
                    title: "Stranded work: \(agent)",
                    detail: "\(item.branch) · dirty \(item.dirtyFileCount) · "
                        + "unmerged \(item.unmergedCommits) · \(item.disposition.rawValue). "
                        + "Open Live Run inspector for the WorkManifest facts.",
                    raisedAt: Double(index)))
            }
        }
        return (projection, queue)
    }

    private func loadAbsentScreens() throws -> [ShellRoute: ShellScreenProjection] {
        let url = URL(fileURLWithPath: directory)
            .appendingPathComponent(Self.absentCorpus)
            .appendingPathExtension("json")
        guard let data = try? Data(contentsOf: url) else {
            throw StoreError.unreadableCorpus(url.path)
        }
        let rows = try JSONDecoder().decode(
            [ClientProjection<ShellAbsentScreen>].self, from: data)
        var screens: [ShellRoute: ShellScreenProjection] = [:]
        for row in rows {
            guard let value = row.value,
                  let route = ShellRoute(rawValue: value.route),
                  row.availability == .unknown,
                  !value.reason.isEmpty,
                  !value.contractState.isEmpty
            else {
                throw StoreError.invalidAbsentRow(Self.absentCorpus)
            }
            screens[route] = ShellScreenProjection(
                availability: row.availability,
                freshness: row.freshness,
                source: row.source,
                observedAt: row.observedAt,
                evidence: row.evidence,
                contract: .notFrozen(reason: value.reason),
                facts: [ShellScreenFact(label: "Contract", value: value.contractState)])
        }
        return screens
    }

    private func loadRow<Value>(
        named corpus: String,
        availability: ProjectionAvailability
    ) throws -> ClientProjection<Value> where Value: Codable & Equatable & Sendable {
        let url = URL(fileURLWithPath: directory)
            .appendingPathComponent(corpus)
            .appendingPathExtension("json")
        guard let data = try? Data(contentsOf: url) else {
            throw StoreError.unreadableCorpus(url.path)
        }
        let rows = try JSONDecoder().decode([ClientProjection<Value>].self, from: data)
        guard let row = rows.first(where: { $0.availability == availability }) else {
            throw StoreError.missingAvailability(corpus, availability)
        }
        return row
    }

    private struct OuterHorizonCorpus: Decodable {
        let schemaVersion: Int
        let scenarios: [OuterHorizonScenario]
    }

    private struct OuterHorizonScenario: Decodable {
        let name: String
        let snapshot: OuterHorizonSnapshot
    }

    private func loadOuterHorizon() throws -> OuterHorizonSnapshot? {
        let url = URL(fileURLWithPath: directory)
            .appendingPathComponent("outer-horizon-corpus")
            .appendingPathExtension("json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url) else {
            throw StoreError.unreadableCorpus(url.path)
        }
        let corpus = try JSONDecoder().decode(OuterHorizonCorpus.self, from: data)
        guard corpus.schemaVersion == 1,
              let scenario = corpus.scenarios.first,
              !scenario.name.isEmpty else {
            throw StoreError.invalidOuterHorizonCorpus
        }
        return scenario.snapshot
    }

    // MARK: Fact extraction — real values from the frozen wires, never samples

    private func snapshotFacts(_ snapshot: WorkspaceStatusSnapshot) -> [ShellScreenFact] {
        var facts = [
            ShellScreenFact(label: "Instance", value: snapshot.instanceId),
            ShellScreenFact(label: "Snapshot", value: "revision \(snapshot.seq)"),
            ShellScreenFact(label: "Entities", value: "\(snapshot.entities.count) observed"),
            ShellScreenFact(label: "Created", value: snapshot.createdAt),
        ]
        for entity in snapshot.entities.prefix(20) {
            let generation = entity.generation.map { "generation \($0)" } ?? "no generation"
            facts.append(ShellScreenFact(
                label: "\(entity.kind) \(entity.id)",
                value: "\(generation), revision \(entity.entityRevision)"
                    + Self.summarize(entity.projection)))
        }
        return facts
    }

    private func outerHorizonFacts(
        _ snapshot: OuterHorizonSnapshot
    ) -> [ShellScreenFact] {
        [
            ShellScreenFact(label: "Instance", value: snapshot.instanceId),
            ShellScreenFact(label: "Snapshot", value: "revision \(snapshot.seq)"),
            ShellScreenFact(label: "Hierarchy", value: "\(snapshot.nodes.count) nodes"),
            ShellScreenFact(label: "Created", value: snapshot.createdAt),
        ]
    }

    private func inspectionFacts(
        _ inspection: RouteInspection,
        policy: RoutingPolicyDocument?
    ) -> [ShellScreenFact] {
        var facts = [
            ShellScreenFact(label: "Category", value: inspection.category),
            ShellScreenFact(label: "Policy", value: "revision \(inspection.policyRevision)"),
            ShellScreenFact(label: "Mode", value: inspection.mode ?? "unconfigured"),
            ShellScreenFact(label: "Candidates", value: "\(inspection.candidates.count)"),
            ShellScreenFact(label: "Inspected", value: inspection.inspectedAt),
        ]
        if let digest = inspection.routeDigest {
            facts.append(ShellScreenFact(label: "Route digest", value: digest))
        }
        if let policy {
            facts.append(ShellScreenFact(
                label: "Policy categories",
                value: policy.categories.keys.sorted().joined(separator: ", ")))
        }
        for candidate in inspection.candidates {
            let effort = candidate.effectiveEffort
                ?? candidate.candidate.effort.asWireEffort.cliArgument
            var value = "\(candidate.candidate.provider)/\(candidate.candidate.model)"
                + " · effort \(effort) · member yes · weight \(candidate.candidate.weight)"
                + " · configured \(Self.percent(candidate.configuredShare))"
                + " · live \(Self.percent(candidate.liveShare))"
            if let refusal = candidate.refusal {
                value += " · \(refusal.gate): \(refusal.detail)"
            }
            facts.append(ShellScreenFact(label: "Candidate", value: value))
        }
        return facts
    }

    private func modelControlFacts(_ view: WorkspaceModelControlView) -> [ShellScreenFact] {
        let snapshot = view.snapshot
        var facts = [
            ShellScreenFact(label: "Generated", value: snapshot.generatedAt),
            ShellScreenFact(
                label: "Providers",
                value: snapshot.providers.keys.sorted().joined(separator: ", ")),
        ]
        facts.append(ShellScreenFact(
            label: "Quota",
            value: snapshot.quota.map { "\($0.count) pools observed" }
                ?? "unknown — the daemon could not be asked"))
        if let data = try? Data(contentsOf: URL(fileURLWithPath: directory)
            .appendingPathComponent("quota-evidence.json")),
           let rows = try? JSONDecoder().decode([QuotaEvidenceRow].self, from: data) {
            for row in rows {
                var value = "\(row.state) · \(row.displayedValue) · \(row.provenance)"
                if let at = row.observedAt { value += " · observed \(at)" }
                if let reset = row.resetsAt { value += " · reset \(reset)" }
                if let reason = row.reason { value += " · \(reason)" }
                facts.append(ShellScreenFact(label: row.label, value: value))
            }
        }
        return facts
    }

    private static func percent(_ share: Double) -> String {
        "\(Int((share * 100).rounded()))%"
    }

    private static func summarize(_ projection: [String: WorkspaceJSONValue]) -> String {
        let pairs = projection.keys.sorted().map { key -> String in
            guard let value = projection[key] else { return key }
            return "\(key)=\(Self.render(value))"
        }
        return pairs.isEmpty ? "" : " — " + pairs.joined(separator: ", ")
    }

    private static func render(_ value: WorkspaceJSONValue) -> String {
        switch value {
        case .null: return "null"
        case .boolean(let value): return value ? "true" : "false"
        case .integer(let value): return String(value)
        case .number(let value): return String(value)
        case .string(let value): return value
        case .array(let values): return "[\(values.map(render).joined(separator: ", "))]"
        case .object: return "{…}"
        }
    }

}
