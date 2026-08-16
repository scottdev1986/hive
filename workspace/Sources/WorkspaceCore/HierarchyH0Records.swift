// HierarchyH0Records.swift Mirrors the daemon's frozen hierarchy records as immutable values. These records are decoded from supplied projection data so Workspace views do not need to reach through the contract to storage or providers.

import Foundation

public enum HierarchyRevisionLifecycle: String, Codable, Equatable, Sendable {
    case proposed
    case approved
    case superseded
}

public struct HierarchyRevisionRef: Codable, Equatable, Sendable {
    public let revision: String
    public let digest: String
}

public struct HierarchyTaskDependency: Codable, Equatable, Sendable {
    public let taskId: String
    public let dependsOn: [String]
}

public struct HierarchySpecRevision: Codable, Equatable, Sendable {
    public struct Constraints: Codable, Equatable, Sendable {
        public let architecture: [String]
        public let security: [String]
        public let outwardEffect: [String]
    }

    public struct GatePolicy: Codable, Equatable, Sendable {
        public let reviewLocGreenMax: Int
        public let reviewLocAmberMax: Int
        public let reviewFilesMax: Int
    }

    public struct EngineerApproval: Codable, Equatable, Sendable {
        public let approvedBy: String
        public let approvedAt: String
    }

    public let runID: String
    public let revision: String
    public let digest: String
    public let createdAt: String
    public let lifecycle: HierarchyRevisionLifecycle
    public let objective: String
    public let acceptanceIds: [String]
    public let scope: String
    public let nonGoals: [String]
    public let constraints: Constraints
    public let gatePolicy: GatePolicy
    public let evidenceArtifactRefs: [String]
    public let proposer: String
    public let engineerApproval: EngineerApproval?

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case revision
        case digest
        case createdAt
        case lifecycle
        case objective
        case acceptanceIds
        case scope
        case nonGoals
        case constraints
        case gatePolicy
        case evidenceArtifactRefs
        case proposer
        case engineerApproval
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runID = try container.decode(String.self, forKey: .runID)
        revision = try container.decode(String.self, forKey: .revision)
        digest = try container.decode(String.self, forKey: .digest)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        lifecycle = try container.decode(
            HierarchyRevisionLifecycle.self,
            forKey: .lifecycle)
        objective = try container.decode(String.self, forKey: .objective)
        acceptanceIds = try container.decode([String].self, forKey: .acceptanceIds)
        scope = try container.decode(String.self, forKey: .scope)
        nonGoals = try container.decode([String].self, forKey: .nonGoals)
        constraints = try container.decode(Constraints.self, forKey: .constraints)
        gatePolicy = try container.decode(GatePolicy.self, forKey: .gatePolicy)
        evidenceArtifactRefs = try container.decode(
            [String].self,
            forKey: .evidenceArtifactRefs)
        proposer = try container.decode(String.self, forKey: .proposer)
        engineerApproval = try container.decodeRequiredNullable(
            EngineerApproval.self,
            forKey: .engineerApproval)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(runID, forKey: .runID)
        try container.encode(revision, forKey: .revision)
        try container.encode(digest, forKey: .digest)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(lifecycle, forKey: .lifecycle)
        try container.encode(objective, forKey: .objective)
        try container.encode(acceptanceIds, forKey: .acceptanceIds)
        try container.encode(scope, forKey: .scope)
        try container.encode(nonGoals, forKey: .nonGoals)
        try container.encode(constraints, forKey: .constraints)
        try container.encode(gatePolicy, forKey: .gatePolicy)
        try container.encode(evidenceArtifactRefs, forKey: .evidenceArtifactRefs)
        try container.encode(proposer, forKey: .proposer)
        try container.encode(engineerApproval, forKey: .engineerApproval)
    }
}

public struct HierarchyPlanRevision: Codable, Equatable, Sendable {
    public let runID: String
    public let revision: String
    public let digest: String
    public let createdAt: String
    public let lifecycle: HierarchyRevisionLifecycle
    public let parentRevision: String?
    public let taskDag: [HierarchyTaskDependency]
    public let topologyRationale: String
    public let proposer: String

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case revision
        case digest
        case createdAt
        case lifecycle
        case parentRevision
        case taskDag
        case topologyRationale
        case proposer
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runID = try container.decode(String.self, forKey: .runID)
        revision = try container.decode(String.self, forKey: .revision)
        digest = try container.decode(String.self, forKey: .digest)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        lifecycle = try container.decode(
            HierarchyRevisionLifecycle.self,
            forKey: .lifecycle)
        parentRevision = try container.decodeRequiredNullable(
            String.self,
            forKey: .parentRevision)
        taskDag = try container.decode(
            [HierarchyTaskDependency].self,
            forKey: .taskDag)
        topologyRationale = try container.decode(
            String.self,
            forKey: .topologyRationale)
        proposer = try container.decode(String.self, forKey: .proposer)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(runID, forKey: .runID)
        try container.encode(revision, forKey: .revision)
        try container.encode(digest, forKey: .digest)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(lifecycle, forKey: .lifecycle)
        try container.encode(parentRevision, forKey: .parentRevision)
        try container.encode(taskDag, forKey: .taskDag)
        try container.encode(topologyRationale, forKey: .topologyRationale)
        try container.encode(proposer, forKey: .proposer)
    }
}

public struct HierarchyTopologyDecision: Codable, Equatable, Sendable {
    public enum Shape: String, Codable, Equatable, Sendable {
        case direct
        case flat
        case fullHive = "full-hive"
    }

    public struct Decomposition: Codable, Equatable, Sendable {
        public let planRevision: HierarchyRevisionRef
        public let taskDag: [HierarchyTaskDependency]
    }

    public struct Coupling: Codable, Equatable, Sendable {
        public let sharedFiles: [String]
        public let sharedInvariants: [String]
        public let interfaceMaturity: String
        public let dependencyDepth: Int
        public let expectedIntegrationConflict: String
    }

    public struct ParallelValue: Codable, Equatable, Sendable {
        public let independentWorkUnits: Int
        public let predictedCriticalPath: String
        public let expectedWallClockBenefit: String
    }

    public struct CoordinationCost: Codable, Equatable, Sendable {
        public let leadLoad: String
        public let reviewLoad: String
        public let communicationLoad: String
        public let ciLoad: String
        public let promotionQueueLoad: String
    }

    public struct BudgetEvidence: Codable, Equatable, Sendable {
        public let reservedSessions: Int
        public let tokensOrCostEstimate: String
        public let wallTimeEstimate: String
        public let reviewerCapacity: String
        public let perLeadCrewLimit: Int
    }

    public struct DecisionProvenance: Codable, Equatable, Sendable {
        public struct EngineerDecision: Codable, Equatable, Sendable {
            public enum Outcome: String, Codable, Equatable, Sendable {
                case approved
                case overridden
            }

            public let outcome: Outcome
            public let decidedBy: String
            public let decidedAt: String
        }

        public let proposer: String
        public let engineerDecision: EngineerDecision?
        public let specRevision: HierarchyRevisionRef
        public let rationale: String

        private enum CodingKeys: String, CodingKey {
            case proposer
            case engineerDecision
            case specRevision
            case rationale
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            proposer = try container.decode(String.self, forKey: .proposer)
            engineerDecision = try container.decodeRequiredNullable(
                EngineerDecision.self,
                forKey: .engineerDecision)
            specRevision = try container.decode(
                HierarchyRevisionRef.self,
                forKey: .specRevision)
            rationale = try container.decode(String.self, forKey: .rationale)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(proposer, forKey: .proposer)
            try container.encode(engineerDecision, forKey: .engineerDecision)
            try container.encode(specRevision, forKey: .specRevision)
            try container.encode(rationale, forKey: .rationale)
        }
    }

    public let runID: String
    public let revision: String
    public let digest: String
    public let createdAt: String
    public let lifecycle: HierarchyRevisionLifecycle
    public let shape: Shape
    public let decomposition: Decomposition
    public let coupling: Coupling
    public let parallelValue: ParallelValue
    public let coordinationCost: CoordinationCost
    public let budgetEvidence: BudgetEvidence
    public let decisionProvenance: DecisionProvenance

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case revision
        case digest
        case createdAt
        case lifecycle
        case shape
        case decomposition
        case coupling
        case parallelValue
        case coordinationCost
        case budgetEvidence
        case decisionProvenance
    }
}

public struct HierarchyRunBudget: Codable, Equatable, Sendable {
    public struct Limit: Codable, Equatable, Sendable {
        public let hard: Int
        public let soft: Int
        public let reserved: Int
        public let used: Int
    }

    /// Named fields make every budget dimension mandatory during decoding.
    public struct Limits: Codable, Equatable, Sendable {
        public let activeSessions: Limit
        public let totalSpawns: Limit
        public let perLeadCrew: Limit
        public let reviewerPool: Limit
        public let vendorQuota: Limit
        public let tokens: Limit
        public let costCents: Limit
        public let wallTimeMs: Limit
        public let ci: Limit
        public let wakeBudget: Limit
        public let messageBudget: Limit
    }

    public let runID: String
    public let revision: String
    public let digest: String
    public let createdAt: String
    public let lifecycle: HierarchyRevisionLifecycle
    public let limits: Limits
    public let anomalyThresholds: [String: Double]

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case revision
        case digest
        case createdAt
        case lifecycle
        case limits
        case anomalyThresholds
    }
}

public struct HierarchyRun: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Equatable, Sendable {
        case p0 = "P0"
        case p1 = "P1"
        case p2 = "P2"
        case p3 = "P3"
        case p4 = "P4"
        case p5 = "P5"
        case p6 = "P6"
    }

    public enum Lifecycle: String, Codable, Equatable, Sendable {
        case active
        case paused
        case completed
        case aborted
    }

    public let runID: String
    public let revision: String
    public let repo: String
    public let instanceId: String
    public let spec: HierarchyRevisionRef
    public let currentPlan: HierarchyRevisionRef
    public let topology: HierarchyRevisionRef
    public let phase: Phase
    public let baseSha: String
    public let budget: HierarchyRevisionRef
    public let runEpoch: Int
    public let lifecycle: Lifecycle

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case revision
        case repo
        case instanceId
        case spec
        case currentPlan
        case topology
        case phase
        case baseSha
        case budget
        case runEpoch
        case lifecycle
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runID = try container.decode(String.self, forKey: .runID)
        revision = try container.decode(String.self, forKey: .revision)
        repo = try container.decode(String.self, forKey: .repo)
        instanceId = try container.decode(String.self, forKey: .instanceId)
        spec = try container.decode(
            HierarchyRevisionRef.self,
            forKey: .spec)
        currentPlan = try container.decode(
            HierarchyRevisionRef.self,
            forKey: .currentPlan)
        topology = try container.decode(
            HierarchyRevisionRef.self,
            forKey: .topology)
        phase = try container.decode(Phase.self, forKey: .phase)
        baseSha = try container.decode(String.self, forKey: .baseSha)
        budget = try container.decode(
            HierarchyRevisionRef.self,
            forKey: .budget)
        runEpoch = try container.decode(Int.self, forKey: .runEpoch)
        lifecycle = try container.decode(Lifecycle.self, forKey: .lifecycle)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(runID, forKey: .runID)
        try container.encode(revision, forKey: .revision)
        try container.encode(repo, forKey: .repo)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(spec, forKey: .spec)
        try container.encode(currentPlan, forKey: .currentPlan)
        try container.encode(topology, forKey: .topology)
        try container.encode(phase, forKey: .phase)
        try container.encode(baseSha, forKey: .baseSha)
        try container.encode(budget, forKey: .budget)
        try container.encode(runEpoch, forKey: .runEpoch)
        try container.encode(lifecycle, forKey: .lifecycle)
    }
}
