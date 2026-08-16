// ShellInspector.swift The Live Run inspector: Task, Events, and Session panes. It is a contextual panel, not a route — no Communications, Gates, Review, or Files destination is registered. Every fact comes from a typed projection; a missing wire is named as absent, never filled from terminal text.

import Foundation

public enum ShellInspectorTab: String, Codable, CaseIterable, Equatable, Sendable {
    case task
    case events
    case session

    public var title: String {
        switch self {
        case .task: return "Task"
        case .events: return "Events"
        case .session: return "Session"
        }
    }
}

/// One measured or declared fact row. Labels stay short; values carry the open-ended wire text verbatim so an unknown enum word is never rewritten.
public struct InspectorFact: Equatable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// One acceptance criterion only when a TaskDetail-shaped projection supplies it. Completion is never inferred from terminal output.
public struct InspectorCriterion: Equatable, Sendable {
    public let id: String
    public let summary: String
    public let complete: Bool?

    public init(id: String, summary: String, complete: Bool?) {
        self.id = id
        self.summary = summary
        self.complete = complete
    }
}

public struct InspectorDeclaredContract: Equatable, Sendable {
    public let contractId: String
    public let revision: String
    public let acceptedBy: [String]

    public init(contractId: String, revision: String, acceptedBy: [String]) {
        self.contractId = contractId
        self.revision = revision
        self.acceptedBy = acceptedBy
    }
}

/// One independent read of the routing inspector. A daemon refusal and an invalid payload are answers about this leg; neither is a lost transport.
public struct InspectorRouteInspectionRead: Equatable, Sendable {
    public enum Result: Equatable, Sendable {
        case projection(ClientProjection<RouteInspection>)
        case refused(detail: String)
        case invalid(detail: String)
    }

    public let category: String
    public let result: Result

    public init(category: String, result: Result) {
        self.category = category
        self.result = result
    }
}

public enum InspectorListState<Item: Equatable & Sendable>: Equatable, Sendable {
    case empty(detail: String)
    case present([Item])
    /// No observation: the read never ran, or the source is not frozen.
    case absent(reason: String)
}

public struct InspectorTaskPane: Equatable, Sendable {
    public let microLabel: String
    public let title: String
    public let explanation: String
    public let facts: [InspectorFact]
    public let routeInspections: InspectorListState<InspectorFact>
    public let criteria: InspectorListState<InspectorCriterion>
    public let declaredContracts: InspectorListState<InspectorDeclaredContract>
    public let channelDelivery: InspectorListState<InspectorFact>
    public let runDecisions: InspectorListState<InspectorFact>
    public let stranded: InspectorListState<InspectorFact>

    public init(
        microLabel: String,
        title: String,
        explanation: String,
        facts: [InspectorFact],
        routeInspections: InspectorListState<InspectorFact>,
        criteria: InspectorListState<InspectorCriterion>,
        declaredContracts: InspectorListState<InspectorDeclaredContract>,
        channelDelivery: InspectorListState<InspectorFact>,
        runDecisions: InspectorListState<InspectorFact>,
        stranded: InspectorListState<InspectorFact>
    ) {
        self.microLabel = microLabel
        self.title = title
        self.explanation = explanation
        self.facts = facts
        self.routeInspections = routeInspections
        self.criteria = criteria
        self.declaredContracts = declaredContracts
        self.channelDelivery = channelDelivery
        self.runDecisions = runDecisions
        self.stranded = stranded
    }
}

public struct InspectorEventRow: Equatable, Sendable {
    public let occurredAt: String
    public let kind: String
    public let summary: String

    public init(occurredAt: String, kind: String, summary: String) {
        self.occurredAt = occurredAt
        self.kind = kind
        self.summary = summary
    }
}

public struct InspectorEventsPane: Equatable, Sendable {
    public let microLabel: String
    public let title: String
    public let explanation: String
    public let events: InspectorListState<InspectorEventRow>

    public init(
        microLabel: String,
        title: String,
        explanation: String,
        events: InspectorListState<InspectorEventRow>
    ) {
        self.microLabel = microLabel
        self.title = title
        self.explanation = explanation
        self.events = events
    }
}

public struct InspectorSessionPane: Equatable, Sendable {
    public let microLabel: String
    public let title: String
    public let explanation: String
    public let facts: [InspectorFact]

    public init(
        microLabel: String,
        title: String,
        explanation: String,
        facts: [InspectorFact]
    ) {
        self.microLabel = microLabel
        self.title = title
        self.explanation = explanation
        self.facts = facts
    }
}

public struct InspectorProjection: Equatable, Sendable {
    public let availability: ProjectionAvailability
    public let observedAt: String?
    public let selectedAgentId: String?
    public let routeInspectionReadFailed: Bool
    public let routeInspectionReads: [InspectorRouteInspectionRead]?
    public let banners: [ShellBanner]
    public let task: InspectorTaskPane
    public let events: InspectorEventsPane
    public let session: InspectorSessionPane

    public init(
        availability: ProjectionAvailability,
        observedAt: String?,
        selectedAgentId: String?,
        routeInspectionReadFailed: Bool,
        routeInspectionReads: [InspectorRouteInspectionRead]? = nil,
        banners: [ShellBanner],
        task: InspectorTaskPane,
        events: InspectorEventsPane,
        session: InspectorSessionPane
    ) {
        self.availability = availability
        self.observedAt = observedAt
        self.selectedAgentId = selectedAgentId
        self.routeInspectionReadFailed = routeInspectionReadFailed
        self.routeInspectionReads = routeInspectionReads
        self.banners = banners
        self.task = task
        self.events = events
        self.session = session
    }

    public func pane(for tab: ShellInspectorTab) -> (
        microLabel: String, title: String, explanation: String
    ) {
        switch tab {
        case .task: return (task.microLabel, task.title, task.explanation)
        case .events: return (events.microLabel, events.title, events.explanation)
        case .session: return (session.microLabel, session.title, session.explanation)
        }
    }
}

public enum ShellInspectorPresenter {

    public struct Inputs: Equatable {
        public var snapshot: WorkspaceStatusSnapshot?
        public var snapshotAvailability: ProjectionAvailability
        public var snapshotObservedAt: String?
        public var node: HierarchyNodeProjection?
        public var run: HierarchyRunProjection?
        public var incident: HierarchyIncidentProjection?
        public var stranded: HierarchyStrandedManifestProjection?
        public var routeInspectionReads: [InspectorRouteInspectionRead]?
        public var events: [WorkspaceStatusEvent]?
        public var eventsAvailability: ProjectionAvailability
        public var eventsEvidence: ProjectionEvidence?
        public var declaredContracts: [InspectorDeclaredContract]?
        public var contractsAvailability: ProjectionAvailability
        public var contractsEvidence: ProjectionEvidence?
        public var criteria: [InspectorCriterion]?
        public var criteriaAvailability: ProjectionAvailability
        public var selectedAgentId: String?

        public init(
            snapshot: WorkspaceStatusSnapshot? = nil,
            snapshotAvailability: ProjectionAvailability = .unknown,
            snapshotObservedAt: String? = nil,
            node: HierarchyNodeProjection? = nil,
            run: HierarchyRunProjection? = nil,
            incident: HierarchyIncidentProjection? = nil,
            stranded: HierarchyStrandedManifestProjection? = nil,
            routeInspectionReads: [InspectorRouteInspectionRead]? = nil,
            events: [WorkspaceStatusEvent]? = nil,
            eventsAvailability: ProjectionAvailability = .unknown,
            eventsEvidence: ProjectionEvidence? = nil,
            declaredContracts: [InspectorDeclaredContract]? = nil,
            contractsAvailability: ProjectionAvailability = .unknown,
            contractsEvidence: ProjectionEvidence? = nil,
            criteria: [InspectorCriterion]? = nil,
            criteriaAvailability: ProjectionAvailability = .unknown,
            selectedAgentId: String? = nil
        ) {
            self.snapshot = snapshot
            self.snapshotAvailability = snapshotAvailability
            self.snapshotObservedAt = snapshotObservedAt
            self.node = node
            self.run = run
            self.incident = incident
            self.stranded = stranded
            self.routeInspectionReads = routeInspectionReads
            self.events = events
            self.eventsAvailability = eventsAvailability
            self.eventsEvidence = eventsEvidence
            self.declaredContracts = declaredContracts
            self.contractsAvailability = contractsAvailability
            self.contractsEvidence = contractsEvidence
            self.criteria = criteria
            self.criteriaAvailability = criteriaAvailability
            self.selectedAgentId = selectedAgentId
        }
    }

    public static func present(_ inputs: Inputs) -> InspectorProjection {
        return InspectorProjection(
            availability: aggregateAvailability(inputs),
            observedAt: inputs.snapshotObservedAt,
            selectedAgentId: inputs.selectedAgentId,
            routeInspectionReadFailed: routeInspectionReadFailed(
                inputs.routeInspectionReads),
            routeInspectionReads: inputs.routeInspectionReads,
            banners: banners(inputs),
            task: taskPane(inputs),
            events: eventsPane(inputs),
            session: sessionPane(inputs))
    }

    /// Keeps each category's last observed route facts only when that category cannot replace them. Successful sibling reads continue to advance.
    public static func retainingObservedValue(
        from prior: InspectorProjection?,
        on refreshed: InspectorProjection?
    ) -> InspectorProjection? {
        guard let refreshed else { return prior }
        guard refreshed.routeInspectionReadFailed, let prior else {
            return refreshed
        }
        var retainedCategory = false
        let mergedReads = refreshed.routeInspectionReads?.map { refreshedRead in
            guard routeInspectionReadFailed(refreshedRead),
                  let priorRead = prior.routeInspectionReads?.first(where: {
                      $0.category == refreshedRead.category
                  }),
                  !routeInspectionReadFailed(priorRead) else {
                return refreshedRead
            }
            retainedCategory = true
            return priorRead
        }
        guard retainedCategory else { return refreshed }
        let task = InspectorTaskPane(
            microLabel: refreshed.task.microLabel,
            title: refreshed.task.title,
            explanation: refreshed.task.explanation,
            facts: refreshed.task.facts,
            routeInspections: routeInspectionState(mergedReads),
            criteria: refreshed.task.criteria,
            declaredContracts: refreshed.task.declaredContracts,
            channelDelivery: refreshed.task.channelDelivery,
            runDecisions: refreshed.task.runDecisions,
            stranded: refreshed.task.stranded)
        return InspectorProjection(
            availability: refreshed.availability == .unknown
                ? prior.availability : refreshed.availability,
            observedAt: refreshed.observedAt ?? prior.observedAt,
            selectedAgentId: refreshed.selectedAgentId ?? prior.selectedAgentId,
            routeInspectionReadFailed: true,
            routeInspectionReads: mergedReads,
            banners: refreshed.banners,
            task: task,
            events: refreshed.events,
            session: refreshed.session)
    }

    private static func taskPane(_ inputs: Inputs) -> InspectorTaskPane {
        var facts: [InspectorFact] = []
        var title = "No selected task"
        var micro = "Task"
        var explanation =
            "Task facts come from hierarchy and run-control projections. "
            + "Acceptance is workflow state, never inferred from terminal output."

        if let run = inputs.run {
            micro = "Run \(run.runID)"
            facts.append(InspectorFact(label: "Run revision", value: run.entityRevision))
            appendRawField(run.phase, label: "Phase", into: &facts)
            appendRawField(run.lifecycle, label: "Lifecycle", into: &facts)
            appendG2Field(run.g2, into: &facts)
        }

        if let node = inputs.node {
            title = "Node \(shortId(node.nodeId))"
            facts.append(InspectorFact(label: "Node", value: node.nodeId))
            facts.append(InspectorFact(label: "Node revision", value: node.entityRevision))
            appendRawField(node.assignmentKind, label: "Assignment", into: &facts)
            appendRawField(node.lifecycle, label: "Node lifecycle", into: &facts)
            switch node.taskScope {
            case .present(let ids) where ids.isEmpty:
                facts.append(InspectorFact(
                    label: "Task scope",
                    value: "empty — no tasks in scope"))
            case .present(let ids):
                facts.append(InspectorFact(
                    label: "Task scope",
                    value: ids.joined(separator: ", ")))
                if let first = ids.first {
                    title = "Task \(shortId(first))"
                    micro = "TaskDetail scope"
                    facts.append(InspectorFact(
                        label: "Task revision",
                        value: "absent — no frozen TaskDetail client wire"))
                }
            case .absent(let reason, let detail):
                facts.append(InspectorFact(
                    label: "Task scope",
                    value: "\(reason.rawValue): \(detail)"))
            }
            switch node.binding {
            case .present(let binding):
                facts.append(InspectorFact(
                    label: "Binding",
                    value: "\(binding.agentId) · generation \(binding.generation)"))
            case .absent(let reason, let detail):
                facts.append(InspectorFact(
                    label: "Binding",
                    value: "\(reason.rawValue): \(detail)"))
            }
        } else if inputs.snapshot == nil && inputs.run == nil {
            explanation =
                "No hierarchy node or run projection has been observed for this "
                + "Live Run context."
        }

        return InspectorTaskPane(
            microLabel: micro,
            title: title,
            explanation: explanation,
            facts: facts,
            routeInspections: routeInspectionState(inputs.routeInspectionReads),
            criteria: criteriaState(inputs),
            declaredContracts: contractsState(inputs),
            channelDelivery: .absent(reason:
                "receiveChannelMessage is the retained in-process read door. "
                    + "No frozen Workspace client projection exposes channel delivery, "
                    + "and the inspector does not expose a message ledger."),
            runDecisions: runDecisionState(inputs.incident),
            stranded: strandedState(inputs.stranded))
    }

    private static func routeInspectionState(
        _ reads: [InspectorRouteInspectionRead]?
    ) -> InspectorListState<InspectorFact> {
        guard let reads else {
            return .absent(reason:
                "No routing-inspection read has reached this inspector context.")
        }
        guard !reads.isEmpty else {
            return .empty(detail: "No routing categories were inspected.")
        }

        var facts: [InspectorFact] = []
        var remainingCandidates = 20
        for read in reads {
            switch read.result {
            case .refused(let detail):
                facts.append(InspectorFact(
                    label: read.category,
                    value: "refused — \(detail)"))
            case .invalid(let detail):
                facts.append(InspectorFact(
                    label: read.category,
                    value: "invalid response — \(detail)"))
            case .projection(let projection):
                guard let inspection = projection.value else {
                    facts.append(InspectorFact(
                        label: read.category,
                        value: projectionAbsence(projection)))
                    continue
                }
                let scope = inspection.scope ?? "unconfigured"
                let mode = inspection.mode ?? "no mode"
                facts.append(InspectorFact(
                    label: inspection.category,
                    value: "policy r\(inspection.policyRevision) · \(scope) · \(mode) · "
                        + "\(inspection.candidates.count) candidates"))
                let candidates = inspection.candidates.prefix(remainingCandidates)
                for candidate in candidates {
                    var value = "\(candidate.candidate.provider)/\(candidate.candidate.model)"
                        + " · live \(percent(candidate.liveShare))"
                    if let refusal = candidate.refusal {
                        value += " · \(refusal.gate): \(refusal.detail)"
                    }
                    facts.append(InspectorFact(label: "Candidate", value: value))
                }
                remainingCandidates -= candidates.count
            }
        }
        return .present(facts)
    }

    private static func criteriaState(_ inputs: Inputs) -> InspectorListState<InspectorCriterion> {
        switch inputs.criteriaAvailability {
        case .unknown where inputs.criteria == nil:
            return .absent(reason:
                "TaskDetail criteria are not on a frozen Workspace client wire. "
                + "The store holds TaskDetail; the inspector does not invent a checklist.")
        case .unauthorized where inputs.criteria == nil,
             .disconnected where inputs.criteria == nil:
            return .absent(reason:
                "TaskDetail criteria could not be read (\(inputs.criteriaAvailability.rawValue)).")
        default:
            break
        }
        guard let criteria = inputs.criteria else {
            return .absent(reason:
                "TaskDetail criteria are not on a frozen Workspace client wire.")
        }
        if criteria.isEmpty {
            return .empty(detail: "TaskDetail lists no acceptance criteria.")
        }
        return .present(criteria)
    }

    private static func contractsState(
        _ inputs: Inputs
    ) -> InspectorListState<InspectorDeclaredContract> {
        guard let contracts = inputs.declaredContracts else {
            if inputs.contractsAvailability == .unknown {
                return .absent(reason:
                    "Interface-contract acceptedBy is the store's declared participant "
                    + "list (receiveChannelMessage retains the in-process read door). "
                    + "No Workspace shell HTTP projection for contracts is frozen yet.")
            }
            let detail = availabilityDetail(
                inputs.contractsAvailability,
                evidence: inputs.contractsEvidence)
            return .absent(reason:
                "No declared interface-contract participants were observed "
                    + "(\(detail)).")
        }
        if contracts.isEmpty {
            return .empty(detail:
                "The declared contract list is \(inputs.contractsAvailability.rawValue) and empty.")
        }
        return .present(contracts)
    }

    private static func runDecisionState(
        _ incident: HierarchyIncidentProjection?
    ) -> InspectorListState<InspectorFact> {
        guard let incident else {
            return .absent(reason:
                "No hierarchy-incident projection observed for run-control decisions.")
        }
        switch incident.runDecision {
        case .absent(let reason, let detail):
            return .absent(reason: "\(reason.rawValue): \(detail)")
        case .present(let decisions) where decisions.isEmpty:
            return .empty(detail: "No run-control decisions recorded for this run.")
        case .present(let decisions):
            let facts = decisions.map { decision -> InspectorFact in
                let outcome: String
                switch decision.outcome {
                case .accepted: outcome = "accepted"
                case .rejected(let code): outcome = "rejected · \(code)"
                }
                return InspectorFact(
                    label: decision.idempotencyKey,
                    value: "\(outcome) · rev \(decision.observedRevision) · "
                        + shortDigest(decision.intentDigest))
            }
            return .present(facts)
        }
    }

    private static func strandedState(
        _ stranded: HierarchyStrandedManifestProjection?
    ) -> InspectorListState<InspectorFact> {
        let actionGap =
            "Resolution and cascade preview are absent — no frozen Workspace client wire."
        guard let stranded else {
            return .absent(reason:
                "No stranded-manifest projection observed. \(actionGap)")
        }
        switch stranded.items {
        case .absent(let reason, let detail):
            return .absent(reason: "\(reason.rawValue): \(detail). \(actionGap)")
        case .present(let items) where items.isEmpty:
            return .empty(detail: "No stranded WorkManifest captures. \(actionGap)")
        case .present(let items):
            var facts = items.map { item -> InspectorFact in
                let agent = item.agentId ?? "unknown agent"
                let rev = item.workManifestRevision.map {
                    "r\($0.revision)"
                } ?? "no revision"
                return InspectorFact(
                    label: agent,
                    value: "\(item.branch) · \(rev) · dirty \(item.dirtyFileCount) · "
                        + "unmerged \(item.unmergedCommits) · \(item.disposition.rawValue)")
            }
            facts.append(InspectorFact(label: "Recovery actions", value: actionGap))
            return .present(facts)
        }
    }

    private static func eventsPane(_ inputs: Inputs) -> InspectorEventsPane {
        let explanation =
            "Typed status history only. Nothing here is scraped from a terminal."
        guard let events = inputs.events else {
            let detail = availabilityDetail(
                inputs.eventsAvailability,
                evidence: inputs.eventsEvidence)
            let reason = inputs.eventsAvailability == .unknown
                ? "No workspace-event observation has reached this build. "
                    + "Empty and absent stay distinct; this is absent."
                : "No workspace-event observation (\(detail))."
            return InspectorEventsPane(
                microLabel: "Typed history",
                title: "Events",
                explanation: explanation,
                events: .absent(reason: reason))
        }
        if events.isEmpty {
            return InspectorEventsPane(
                microLabel: "Typed history",
                title: "Events",
                explanation: explanation,
                events: .empty(detail:
                    "The event stream is \(inputs.eventsAvailability.rawValue) and empty."))
        }
        let rows = events.prefix(40).map { event in
            InspectorEventRow(
                occurredAt: event.occurredAt,
                kind: event.kind,
                summary: eventSummary(event))
        }
        return InspectorEventsPane(
            microLabel: "Typed history",
            title: "Events, not screen scraping",
            explanation: explanation,
            events: .present(Array(rows)))
    }

    private static func eventSummary(_ event: WorkspaceStatusEvent) -> String {
        let entity = "\(event.entity.kind) \(shortId(event.entity.id))"
        let conf = event.source.confidence
        return "\(entity) · \(event.source.kind) · \(conf)"
    }

    private static func sessionPane(_ inputs: Inputs) -> InspectorSessionPane {
        let explanation =
            "Process and fused status reality. Viewer state is separate from "
            + "agent activity. The raw daemon word is preserved beside the legend."

        guard let snapshot = inputs.snapshot else {
            return InspectorSessionPane(
                microLabel: "Process and fused status",
                title: "No session observed",
                explanation: explanation,
                facts: [
                    InspectorFact(
                        label: "Snapshot",
                        value: inputs.snapshotAvailability == .unknown
                            ? "absent — no workspace snapshot"
                            : "\(inputs.snapshotAvailability.rawValue) with no value"),
                ])
        }

        let entity = selectedEntity(in: snapshot, preferred: inputs.selectedAgentId)
        var facts: [InspectorFact] = [
            InspectorFact(label: "Instance", value: snapshot.instanceId),
            InspectorFact(label: "Snapshot", value: "seq \(snapshot.seq)"),
        ]

        guard let entity else {
            return InspectorSessionPane(
                microLabel: "Process and fused status",
                title: "No agent entity in snapshot",
                explanation: explanation,
                facts: facts + [
                    InspectorFact(
                        label: "Entities",
                        value: snapshot.entities.isEmpty
                            ? "empty — snapshot has no entities"
                            : "\(snapshot.entities.count) entities, none selected"),
                ])
        }

        let rawStatus = stringField(entity.projection, "activity")
            ?? stringField(entity.projection, "status")
        let provider = stringField(entity.projection, "provider") ?? "unknown"
        let generation = entity.generation.map(String.init) ?? "unknown"
        let title = "\(provider.capitalized) · session generation \(generation)"

        facts.append(contentsOf: [
            InspectorFact(label: "Agent", value: entity.id),
            InspectorFact(label: "Kind", value: entity.kind),
            InspectorFact(label: "Entity revision", value: entity.entityRevision),
            InspectorFact(
                label: "Agent feed",
                value: rawStatus ?? "absent — no activity or status field"),
            InspectorFact(
                label: "Activity",
                value: rawStatus.map { "\($0) · daemon value" }
                    ?? "unknown — daemon value absent"),
            InspectorFact(label: "Provider", value: provider),
            InspectorFact(label: "Generation", value: generation),
        ])

        if let turn = stringField(entity.projection, "turn") {
            facts.append(InspectorFact(label: "Turn", value: turn))
        }
        if let health = stringField(entity.projection, "health") {
            facts.append(InspectorFact(label: "Health", value: health))
        }
        if let attention = stringField(entity.projection, "attention") {
            facts.append(InspectorFact(label: "Attention", value: attention))
        }
        if let source = stringField(entity.projection, "statusSource")
            ?? stringField(entity.projection, "source") {
            facts.append(InspectorFact(label: "Status source", value: source))
        }
        if let input = stringField(entity.projection, "input") {
            facts.append(InspectorFact(label: "Input", value: input))
        }
        let extraKeys = entity.projection.keys.sorted()
            .filter { !Self.knownSessionKeys.contains($0) }
            .prefix(12)
        for key in extraKeys {
            if let value = stringField(entity.projection, key) {
                facts.append(InspectorFact(label: key, value: value))
            }
        }

        return InspectorSessionPane(
            microLabel: "Process and fused status reality",
            title: title,
            explanation: explanation,
            facts: facts)
    }

    private static let knownSessionKeys: Set<String> = [
        "activity", "status", "provider", "turn", "health", "attention",
        "statusSource", "source", "input",
    ]

    private static func aggregateAvailability(_ inputs: Inputs) -> ProjectionAvailability {
        var states: [ProjectionAvailability] = [inputs.snapshotAvailability]
        if inputs.events != nil || inputs.eventsAvailability != .unknown {
            states.append(inputs.eventsAvailability)
        }
        if inputs.declaredContracts != nil || inputs.contractsAvailability != .unknown {
            states.append(inputs.contractsAvailability)
        }
        for read in inputs.routeInspectionReads ?? [] {
            if case .projection(let projection) = read.result {
                states.append(projection.availability)
            }
        }
        for state in [
            ProjectionAvailability.current, .stale, .conflicting, .replaced,
            .unauthorized, .disconnected,
        ] where states.contains(state) {
            return state
        }
        return .unknown
    }

    private static func routeInspectionReadFailed(
        _ reads: [InspectorRouteInspectionRead]?
    ) -> Bool {
        (reads ?? []).contains(where: routeInspectionReadFailed)
    }

    private static func routeInspectionReadFailed(
        _ read: InspectorRouteInspectionRead
    ) -> Bool {
        switch read.result {
        case .refused, .invalid:
            return true
        case .projection(let projection):
            return projection.value == nil
        }
    }

    private static func banners(_ inputs: Inputs) -> [ShellBanner] {
        var result: [ShellBanner] = []
        for read in inputs.routeInspectionReads ?? [] {
            switch read.result {
            case .refused(let detail):
                result.append(ShellBanner(
                    severity: .warning,
                    text: "The daemon refused the \(read.category) routing inspection: "
                        + "\(detail). Other inspector reads were not changed."))
            case .invalid(let detail):
                result.append(ShellBanner(
                    severity: .warning,
                    text: "The \(read.category) routing inspection did not match "
                        + "RouteInspection schema v1: \(detail)."))
            case .projection(let projection):
                if let banner = endpointBanner(
                    name: "\(read.category) routing inspection",
                    availability: projection.availability,
                    evidence: projection.evidence,
                    retained: projection.value != nil) {
                    result.append(banner)
                }
                if let refusal = projection.value?.refusal {
                    result.append(ShellBanner(
                        severity: .warning,
                        text: "Routing refused \(read.category): \(refusalDetail(refusal)). "
                            + "The inspected projection remains visible."))
                }
            }
        }
        if let banner = endpointBanner(
            name: "event stream",
            availability: inputs.eventsAvailability,
            evidence: inputs.eventsEvidence,
            retained: inputs.events != nil) {
            result.append(banner)
        }
        if let banner = endpointBanner(
            name: "declared contract list",
            availability: inputs.contractsAvailability,
            evidence: inputs.contractsEvidence,
            retained: inputs.declaredContracts != nil) {
            result.append(banner)
        }
        return result
    }

    private static func endpointBanner(
        name: String,
        availability: ProjectionAvailability,
        evidence: ProjectionEvidence?,
        retained: Bool
    ) -> ShellBanner? {
        let suffix = retained
            ? " Showing the last observed value unchanged."
            : " No prior value is available."
        switch availability {
        case .unauthorized:
            return ShellBanner(
                severity: .warning,
                text: "The daemon refused the \(name) read "
                    + "(\(evidence?.refusalCode ?? "unspecified")).\(suffix)")
        case .disconnected:
            return ShellBanner(
                severity: .warning,
                text: "Transport for the \(name) was lost at "
                    + "\(evidence?.transportLostAt ?? "an unknown time").\(suffix)")
        case .stale:
            return ShellBanner(
                severity: .info,
                text: "The \(name) is stale.\(suffix)")
        case .conflicting:
            return ShellBanner(
                severity: .warning,
                text: "The \(name) has competing revisions.\(suffix)")
        case .replaced:
            return ShellBanner(
                severity: .info,
                text: "The \(name) was replaced by a newer source.\(suffix)")
        case .current, .unknown:
            return nil
        }
    }

    private static func availabilityDetail(
        _ availability: ProjectionAvailability,
        evidence: ProjectionEvidence?
    ) -> String {
        switch availability {
        case .unauthorized:
            return "refused: \(evidence?.refusalCode ?? "unspecified")"
        case .disconnected:
            return "transport lost: \(evidence?.transportLostAt ?? "unknown")"
        default:
            return availability.rawValue
        }
    }

    private static func projectionAbsence<Value>(
        _ projection: ClientProjection<Value>
    ) -> String where Value: Codable & Equatable & Sendable {
        availabilityDetail(projection.availability, evidence: projection.evidence)
            + " — no observed value"
    }

    private static func refusalDetail(_ refusal: RouteInspection.Refusal) -> String {
        switch refusal {
        case .neverConfigured(let detail), .noCandidate(let detail):
            return detail
        }
    }

    private static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    private static func selectedEntity(
        in snapshot: WorkspaceStatusSnapshot,
        preferred: String?
    ) -> WorkspaceStatusSnapshot.Entity? {
        if let preferred,
           let match = snapshot.entities.first(where: {
               $0.id == preferred && $0.kind == "agent"
           }) {
            return match
        }
        if preferred != nil { return nil }
        return snapshot.entities.first(where: { $0.kind == "agent" })
    }

    private static func stringField(
        _ projection: [String: WorkspaceJSONValue],
        _ key: String
    ) -> String? {
        guard let value = projection[key] else { return nil }
        switch value {
        case .string(let s): return s
        case .integer(let n): return String(n)
        case .number(let n): return String(n)
        case .boolean(let b): return b ? "true" : "false"
        case .null: return nil
        case .array, .object: return nil
        }
    }


    private static func appendRawField<T>(
        _ field: HierarchyProjectionField<T>,
        label: String,
        into facts: inout [InspectorFact]
    ) where T: RawRepresentable & Codable & Equatable & Sendable, T.RawValue == String {
        switch field {
        case .present(let value):
            facts.append(InspectorFact(label: label, value: value.rawValue))
        case .absent(let reason, let detail):
            facts.append(InspectorFact(
                label: label,
                value: "\(reason.rawValue): \(detail)"))
        }
    }

    private static func appendG2Field(
        _ field: HierarchyProjectionField<HierarchyRun.G2State>,
        into facts: inout [InspectorFact]
    ) {
        switch field {
        case .present(.pending):
            facts.append(InspectorFact(label: "G2", value: "pending"))
        case .present(.approved(let approval)):
            facts.append(InspectorFact(
                label: "G2",
                value: "approved · \(approval.decider) · \(shortDigest(approval.digest))"))
        case .absent(let reason, let detail):
            facts.append(InspectorFact(label: "G2", value: "\(reason.rawValue): \(detail)"))
        }
    }

    private static func shortId(_ id: String) -> String {
        if id.count <= 16 { return id }
        return String(id.prefix(12)) + "…"
    }

    private static func shortDigest(_ digest: String) -> String {
        if digest.count <= 18 { return digest }
        return String(digest.prefix(18)) + "…"
    }
}
