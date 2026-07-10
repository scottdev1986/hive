import Foundation
import CoreGraphics

/// Everything one workspace window shows for one pane.
public struct PaneState: Equatable {
    public let id: PaneID
    public let kind: PaneKind
    public var title: String
    public var model: String?
    public var status: PaneStatus
    public var transcript: TranscriptModel

    /// Human status line for headers and accessibility values.
    public var statusDescription: String {
        switch status {
        case .running: return "running"
        case .waiting(.approval): return "waiting for approval"
        case .waiting(.userInput): return "waiting for input"
        case .completed(let acknowledged): return acknowledged ? "completed (seen)" : "completed"
        case .failed(let acknowledged): return acknowledged ? "failed (opened)" : "failed"
        case .disconnected(let reason, let lastConfirmed):
            return "disconnected (\(reason)); last confirmed \(lastConfirmed)"
        }
    }
}

/// State changes the UI layer reacts to. One reducer emits these for every
/// input surface, which is what keeps mouse/keyboard/menu/accessibility in
/// agreement.
public enum StateChange: Equatable {
    case paneAdded(PaneID)
    case paneRemoved(PaneID)
    case layoutChanged
    case focusChanged(PaneID?)
    case statusChanged(PaneID)
    case transcriptChanged(PaneID, TranscriptChange)
    case attentionChanged
    case composerSubmitted(PaneID, String)
}

/// The reducer for one project (tenant) workspace: owns the layout tree,
/// pane states, focus, and this project's attention items. Pure Swift — the
/// AppKit layer observes `StateChange`s and renders.
public final class ProjectState {
    public let projectID: ProjectID
    public let displayName: String
    public private(set) var layout: LayoutTree
    public private(set) var panes: [PaneID: PaneState] = [:]
    public private(set) var focusedPane: PaneID?
    public private(set) var orchestratorPane: PaneID?
    public private(set) var attention = AttentionQueue()

    /// Geometry used for deterministic insertion decisions. The window keeps
    /// this current; tests set it directly.
    public var layoutBounds: CGRect

    private var approvalToPane: [String: PaneID] = [:]

    public init(projectID: ProjectID, displayName: String,
                layoutBounds: CGRect = CGRect(x: 0, y: 0, width: 1440, height: 900),
                metrics: LayoutMetrics = LayoutMetrics()) {
        self.projectID = projectID
        self.displayName = displayName
        self.layoutBounds = layoutBounds
        self.layout = LayoutTree(metrics: metrics)
    }

    public func frames(in bounds: CGRect) -> [PaneID: CGRect] {
        layout.frames(in: bounds)
    }

    /// Sanitized card data for the project switcher: no transcript content.
    public struct SwitcherCard: Equatable {
        public let projectID: ProjectID
        public let displayName: String
        public let orchestratorModel: String?
        public let paneCount: Int
        public let runningCount: Int
        public let waitingCount: Int
        public let failedCount: Int
    }

    public var switcherCard: SwitcherCard {
        let statuses = panes.values.map(\.status)
        return SwitcherCard(
            projectID: projectID,
            displayName: displayName,
            orchestratorModel: orchestratorPane.flatMap { panes[$0]?.model },
            paneCount: panes.count,
            runningCount: statuses.filter { $0 == .running }.count,
            waitingCount: statuses.filter { $0.isWaiting }.count,
            failedCount: statuses.filter { if case .failed(false) = $0 { return true } else { return false } }.count
        )
    }

    // MARK: Event ingestion

    @discardableResult
    public func apply(_ envelope: AgentEventEnvelope) -> [StateChange] {
        precondition(envelope.projectID == projectID)
        var changes: [StateChange] = []
        let paneID = envelope.paneID
        let eventTime = envelope.timestamp ?? Double(envelope.sequence)

        // A session start for an unknown pane creates it (least-disruptive split).
        if panes[paneID] == nil {
            guard case .sessionStarted(let title, let kind, let model) = envelope.payload else {
                return [] // events for unknown panes are dropped, never crash the UI
            }
            var pane = PaneState(
                id: paneID, kind: kind, title: title, model: model,
                status: .running, transcript: TranscriptModel())
            _ = pane.transcript.apply(envelope.payload)
            panes[paneID] = pane
            layout.insert(paneID, in: layoutBounds)
            if kind == .orchestrator, orchestratorPane == nil {
                orchestratorPane = paneID
            }
            changes.append(.paneAdded(paneID))
            changes.append(.layoutChanged)
            // Creation never steals focus; the very first pane is the exception
            // because an empty workspace has nothing focused.
            if focusedPane == nil {
                focusedPane = paneID
                changes.append(.focusChanged(paneID))
            }
            return changes
        }

        guard var pane = panes[paneID] else { return changes }

        // Track semantic status transitions driven by events.
        switch envelope.payload {
        case .approvalRequested(let approvalID, let title, _, _):
            approvalToPane[approvalID] = paneID
            pane.status = .waiting(.approval)
            changes.append(.statusChanged(paneID))
            attention.raise(AttentionItem(
                id: approvalID, projectID: projectID, paneID: paneID,
                severity: .waiting, title: "Approval: \(title)",
                detail: "\(pane.title) is waiting for approval", raisedAt: eventTime))
            changes.append(.attentionChanged)

        case .approvalResolved(let approvalID, _):
            if case .waiting(.approval) = pane.status { pane.status = .running }
            changes.append(.statusChanged(paneID))
            attention.resolve(id: approvalID)
            changes.append(.attentionChanged)

        case .statusChanged(let status):
            pane.status = status
            changes.append(.statusChanged(paneID))
            if case .waiting(.userInput) = status {
                attention.raise(AttentionItem(
                    id: "input-\(paneID.raw)-\(envelope.sequence)", projectID: projectID, paneID: paneID,
                    severity: .waiting, title: "\(pane.title) needs input",
                    detail: pane.statusDescription, raisedAt: eventTime))
                changes.append(.attentionChanged)
            }

        case .agentCompleted:
            pane.status = .completed(acknowledged: false)
            changes.append(.statusChanged(paneID))
            attention.raise(AttentionItem(
                id: "done-\(paneID.raw)", projectID: projectID, paneID: paneID,
                severity: .completed, title: "\(pane.title) completed",
                detail: "Result ready for review", raisedAt: eventTime))
            changes.append(.attentionChanged)

        case .agentFailed(let error):
            pane.status = .failed(acknowledged: false)
            changes.append(.statusChanged(paneID))
            attention.raise(AttentionItem(
                id: "fail-\(paneID.raw)", projectID: projectID, paneID: paneID,
                severity: .failed, title: "\(pane.title) failed",
                detail: error, raisedAt: eventTime))
            changes.append(.attentionChanged)

        case .disconnected(let reason):
            pane.status = .disconnected(reason: reason, lastConfirmed: pane.statusDescription)
            changes.append(.statusChanged(paneID))
            attention.raise(AttentionItem(
                id: "gone-\(paneID.raw)", projectID: projectID, paneID: paneID,
                severity: .disconnected, title: "\(pane.title) disconnected",
                detail: reason, raisedAt: eventTime))
            changes.append(.attentionChanged)

        case .reconnected:
            pane.status = .running
            changes.append(.statusChanged(paneID))
            attention.resolve(id: "gone-\(paneID.raw)")
            changes.append(.attentionChanged)

        default:
            break
        }

        let transcriptChange = pane.transcript.apply(envelope.payload)
        if transcriptChange != .none {
            changes.append(.transcriptChanged(paneID, transcriptChange))
        }
        panes[paneID] = pane
        return changes
    }

    // MARK: Command dispatch (the one shared command model)

    @discardableResult
    public func apply(_ command: WorkspaceCommand) -> [StateChange] {
        switch command {
        case .focusPane(let paneID):
            guard panes[paneID] != nil, focusedPane != paneID else { return [] }
            focusedPane = paneID
            // Focus never acknowledges, approves, or clears attention.
            return [.focusChanged(paneID)]

        case .moveFocus(let direction):
            guard let source = focusedPane else { return [] }
            let solved = layout.frames(in: layoutBounds)
            guard let target = SpatialNavigator.pane(from: source, in: solved, direction: direction),
                  target != source else { return [] }
            focusedPane = target
            return [.focusChanged(target)]

        case .focusOrchestrator:
            guard let orchestrator = orchestratorPane, focusedPane != orchestrator else { return [] }
            focusedPane = orchestrator
            return [.focusChanged(orchestrator)]

        case .promotePane(let paneID):
            guard panes[paneID] != nil, layout.master != paneID else { return [] }
            layout.promote(paneID)
            return [.layoutChanged]

        case .returnOrchestratorToMaster:
            guard let orchestrator = orchestratorPane, layout.master != orchestrator else { return [] }
            layout.promote(orchestrator)
            return [.layoutChanged]

        case .closePane(let paneID):
            guard panes[paneID] != nil else { return [] }
            layout.close(paneID, preferredMaster: orchestratorPane)
            panes.removeValue(forKey: paneID)
            attention.resolveAll(paneID: paneID, projectID: projectID)
            var changes: [StateChange] = [.paneRemoved(paneID), .layoutChanged, .attentionChanged]
            if orchestratorPane == paneID { orchestratorPane = nil }
            if focusedPane == paneID {
                focusedPane = layout.master
                changes.append(.focusChanged(focusedPane))
            }
            return changes

        case .acknowledgePane(let paneID):
            guard var pane = panes[paneID] else { return [] }
            switch pane.status {
            case .completed(false):
                pane.status = .completed(acknowledged: true)
            case .failed(false):
                pane.status = .failed(acknowledged: true)
            default:
                return []
            }
            panes[paneID] = pane
            attention.resolveAll(paneID: paneID, projectID: projectID)
            return [.statusChanged(paneID), .attentionChanged]

        case .openFailure(let paneID):
            guard var pane = panes[paneID], case .failed(false) = pane.status else { return [] }
            pane.status = .failed(acknowledged: true)
            panes[paneID] = pane
            attention.resolve(id: "fail-\(paneID.raw)")
            focusedPane = paneID
            return [.statusChanged(paneID), .attentionChanged, .focusChanged(paneID)]

        case .resolveApproval(let approvalID, let approved):
            guard let paneID = approvalToPane[approvalID],
                  var pane = panes[paneID],
                  case .approval(let item)? = pane.transcript.item(id: approvalID),
                  item.state == .pending else { return [] }
            let transcriptChange = pane.transcript.apply(.approvalResolved(approvalID: approvalID, approved: approved))
            if case .waiting(.approval) = pane.status { pane.status = .running }
            panes[paneID] = pane
            attention.resolve(id: approvalID)
            return [.transcriptChanged(paneID, transcriptChange), .statusChanged(paneID), .attentionChanged]

        case .toggleToolOutput(let paneID, let itemID):
            guard var pane = panes[paneID] else { return [] }
            let change = pane.transcript.toggleToolOutput(itemID: itemID)
            panes[paneID] = pane
            guard change != .none else { return [] }
            return [.transcriptChanged(paneID, change)]

        case .sendComposerText(let paneID, let text):
            guard var pane = panes[paneID], !text.isEmpty else { return [] }
            let messageID = "user-\(paneID.raw)-\(pane.transcript.items.count)"
            var changes: [StateChange] = []
            let delta = pane.transcript.apply(.messageDelta(messageID: messageID, role: .user, text: text, model: nil))
            _ = pane.transcript.apply(.messageCompleted(messageID: messageID))
            panes[paneID] = pane
            if delta != .none { changes.append(.transcriptChanged(paneID, delta)) }
            changes.append(.composerSubmitted(paneID, text))
            return changes
        }
    }
}
