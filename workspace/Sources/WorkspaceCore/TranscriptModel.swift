import Foundation

/// One rendered block in a transcript pane.
public enum TranscriptItem: Equatable, Identifiable {
    case message(MessageItem)
    case toolCall(ToolCallItem)
    case approval(ApprovalItem)
    case diff(id: String, DiffPayload)
    case notice(id: String, text: String)

    public var id: String {
        switch self {
        case .message(let item): return item.id
        case .toolCall(let item): return item.id
        case .approval(let item): return item.id
        case .diff(let id, _): return id
        case .notice(let id, _): return id
        }
    }
}

public struct MessageItem: Equatable {
    public let id: String
    public let role: MessageRole
    public var text: String
    public var isStreaming: Bool
    /// nil when the provider omitted it — rendered as absent, never guessed.
    public var model: String?
}

public struct ToolCallItem: Equatable {
    public let id: String
    public let name: String
    public let input: String
    public var output: String
    public var isANSI: Bool
    public var isRunning: Bool
    public var exitCode: Int?
    /// Large output collapses by default; expanding is a transcript command.
    public var expanded: Bool

    public var outputLineCount: Int {
        output.isEmpty ? 0 : output.split(separator: "\n", omittingEmptySubsequences: false).count
    }
}

public enum ApprovalState: Equatable {
    case pending
    case approved
    case denied
}

public struct ApprovalItem: Equatable {
    public let id: String
    public let title: String
    public let detail: String
    public let diff: DiffPayload?
    public var state: ApprovalState
}

/// How the transcript changed, so views update ranges instead of rebuilding.
public enum TranscriptChange: Equatable {
    case appended(index: Int)
    case updated(index: Int)
    case none
}

/// Reduces structured agent events into an ordered transcript.
public struct TranscriptModel: Equatable {
    public private(set) var items: [TranscriptItem] = []
    private var indexByID: [String: Int] = [:]
    private var noticeCounter = 0

    public init() {}

    public mutating func apply(_ event: AgentEvent) -> TranscriptChange {
        switch event {
        case .sessionStarted(let title, _, let model):
            let modelText = model.map { " · \($0)" } ?? " · model unknown"
            return appendNotice("session started — \(title)\(modelText)")

        case .messageDelta(let messageID, let role, let text, let model):
            if let index = indexByID[messageID], case .message(var item) = items[index] {
                item.text += text
                if item.model == nil { item.model = model }
                items[index] = .message(item)
                return .updated(index: index)
            }
            let item = MessageItem(id: messageID, role: role, text: text, isStreaming: true, model: model)
            return append(.message(item))

        case .messageCompleted(let messageID):
            guard let index = indexByID[messageID], case .message(var item) = items[index] else { return .none }
            item.isStreaming = false
            items[index] = .message(item)
            return .updated(index: index)

        case .toolCallStarted(let callID, let name, let input):
            let item = ToolCallItem(
                id: callID, name: name, input: input, output: "",
                isANSI: false, isRunning: true, exitCode: nil, expanded: false)
            return append(.toolCall(item))

        case .toolOutput(let callID, let chunk, let isANSI):
            guard let index = indexByID[callID], case .toolCall(var item) = items[index] else { return .none }
            item.output += chunk
            item.isANSI = item.isANSI || isANSI
            items[index] = .toolCall(item)
            return .updated(index: index)

        case .toolCallCompleted(let callID, let exitCode):
            guard let index = indexByID[callID], case .toolCall(var item) = items[index] else { return .none }
            item.isRunning = false
            item.exitCode = exitCode
            items[index] = .toolCall(item)
            return .updated(index: index)

        case .approvalRequested(let approvalID, let title, let detail, let diff):
            let item = ApprovalItem(id: approvalID, title: title, detail: detail, diff: diff, state: .pending)
            return append(.approval(item))

        case .approvalResolved(let approvalID, let approved):
            guard let index = indexByID[approvalID], case .approval(var item) = items[index] else { return .none }
            item.state = approved ? .approved : .denied
            items[index] = .approval(item)
            return .updated(index: index)

        case .diffProduced(let payload):
            noticeCounter += 1
            return append(.diff(id: "diff-\(noticeCounter)", payload))

        case .statusChanged:
            return .none // status renders on the pane border, not in the transcript

        case .agentCompleted(let summary):
            return appendNotice("completed — \(summary)")

        case .agentFailed(let error):
            return appendNotice("failed — \(error)")

        case .disconnected(let reason):
            return appendNotice("disconnected — \(reason)")

        case .reconnected:
            return appendNotice("reconnected")
        }
    }

    /// Explicit user command from the shared command model.
    public mutating func toggleToolOutput(itemID: String) -> TranscriptChange {
        guard let index = indexByID[itemID], case .toolCall(var item) = items[index] else { return .none }
        item.expanded.toggle()
        items[index] = .toolCall(item)
        return .updated(index: index)
    }

    public func item(id: String) -> TranscriptItem? {
        indexByID[id].map { items[$0] }
    }

    private mutating func append(_ item: TranscriptItem) -> TranscriptChange {
        indexByID[item.id] = items.count
        items.append(item)
        return .appended(index: items.count - 1)
    }

    private mutating func appendNotice(_ text: String) -> TranscriptChange {
        noticeCounter += 1
        return append(.notice(id: "notice-\(noticeCounter)", text: text))
    }
}
