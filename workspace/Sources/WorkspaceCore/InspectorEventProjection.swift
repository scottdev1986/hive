import Foundation

/// Turns the daemon's typed events for one agent into the rows the inspector draws. Pane events (`pane.*`) are read by their declared fields; any other kind is shown as itself with whatever short value its data carries, so an unfamiliar event is visible rather than dropped.
public enum InspectorEventProjection {

    public static func turns(from events: [WorkspaceStatusEvent]) -> [InspectorEventTurn] {
        let ordered = events.sorted { lhs, rhs in
            (UInt64(lhs.seq) ?? 0) < (UInt64(rhs.seq) ?? 0)
        }
        let finishedTools = Set(ordered.compactMap { event -> String? in
            event.kind == "pane.tool.finished" ? string(event, "toolCallId") : nil
        })
        var origins: [String: String] = [:]
        for event in ordered where event.kind == "pane.turn.started" {
            if let turnId = string(event, "turnId"), let origin = string(event, "origin") {
                origins[turnId] = origin
            }
        }

        var turns: [InspectorEventTurn] = []
        var numbers: [String: Int] = [:]
        var current: (id: String, rows: [InspectorEventRow], at: String)? = nil

        func close() {
            guard let open = current else { return }
            let wake = origins[open.id] == "wake"
            let label: String
            if open.id == Self.sessionTurnId {
                label = "session"
            } else {
                let number = numbers[open.id] ?? numbers.count + 1
                numbers[open.id] = number
                label = "turn \(number) · \(wake ? "wake" : "user")"
            }
            turns.append(InspectorEventTurn(
                id: open.id, label: label, wake: wake, occurredAt: open.at, rows: open.rows))
            current = nil
        }

        for event in ordered {
            let turnId = string(event, "turnId") ?? Self.sessionTurnId
            if current?.id != turnId {
                close()
                current = (turnId, [], event.occurredAt)
                if turnId != Self.sessionTurnId, numbers[turnId] == nil {
                    numbers[turnId] = numbers.count + 1
                }
            }
            if let row = row(for: event, finishedTools: finishedTools) {
                current?.rows.append(row)
            }
        }
        close()
        return turns.filter { !$0.rows.isEmpty }
    }

    static let sessionTurnId = "session"

    private static func row(
        for event: WorkspaceStatusEvent,
        finishedTools: Set<String>
    ) -> InspectorEventRow? {
        switch event.kind {
        case "pane.turn.started":
            return nil
        case "pane.turn.ended":
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status, label: "Turn ended",
                subject: string(event, "outcome"), detail: nil, shownInChat: false)
        case "pane.tool.started":
            if let callId = string(event, "toolCallId"), finishedTools.contains(callId) {
                return nil
            }
            return toolRow(event, mark: .running, detail: "running")
        case "pane.tool.finished":
            let failed = string(event, "status") == "error"
            var parts: [String] = []
            if let files = integer(event, "files"), files > 0 {
                parts.append("\(files) file\(files == 1 ? "" : "s")")
            }
            if let startedAt = string(event, "startedAt"),
               let elapsed = elapsed(from: startedAt, to: event.occurredAt) {
                parts.append(elapsed)
            }
            if failed, let reason = string(event, "reason") { parts.append(reason) }
            return toolRow(
                event, mark: failed ? .failed : .ok,
                detail: parts.isEmpty ? nil : parts.joined(separator: " · "))
        case "pane.mail.ready":
            let waiting = integer(event, "waiting").map { "\($0) waiting" }
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .mail,
                mark: .mailReady, label: "Mail ready",
                subject: string(event, "lane"), detail: waiting, shownInChat: false)
        case "pane.mail.message":
            let inbound = string(event, "direction") == "in"
            let lane = string(event, "lane")
            let topic = string(event, "topic")
            let detail = [lane, topic].compactMap { $0 }.joined(separator: " · ")
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .mail,
                mark: inbound ? .mailIn : .mailOut,
                label: inbound ? "Mail in" : "Mail out",
                subject: string(event, "peer"),
                detail: detail.isEmpty ? nil : detail, shownInChat: true)
        case "pane.plan.updated":
            let steps = integer(event, "steps") ?? 0
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status, label: "Plan", subject: nil,
                detail: "\(steps) step\(steps == 1 ? "" : "s")", shownInChat: false)
        case "pane.turn.changes":
            let files = integer(event, "files") ?? 0
            let added = integer(event, "added") ?? 0
            let removed = integer(event, "removed") ?? 0
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status, label: "Changes",
                subject: "\(files) file\(files == 1 ? "" : "s")",
                detail: "+\(added) −\(removed)", shownInChat: false)
        case "pane.question.asked":
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status,
                label: string(event, "ask") == "approval" ? "Approval" : "Question",
                subject: string(event, "summary"), detail: "waiting", shownInChat: true)
        case "pane.question.settled":
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status, label: "Answered",
                subject: string(event, "outcome"), detail: nil, shownInChat: true)
        default:
            let value = string(event, "value") ?? string(event, "status") ?? string(event, "state")
            return InspectorEventRow(
                id: event.eventId, occurredAt: event.occurredAt, category: .status,
                mark: .status, label: event.kind, subject: value,
                detail: "\(event.source.kind) · \(event.source.confidence)",
                shownInChat: false)
        }
    }

    private static func toolRow(
        _ event: WorkspaceStatusEvent,
        mark: InspectorEventMark,
        detail: String?
    ) -> InspectorEventRow {
        let toolName = string(event, "toolName") ?? "Tool"
        let hive = hiveToolName(toolName)
        let category: InspectorEventCategory
        if let hive, hive.hasPrefix("hive_mail_") {
            category = .mail
        } else if let hive, hive.hasPrefix("hive_task_") || hive.hasPrefix("hive_spawn")
            || hive.hasPrefix("hive_settlement") || hive.hasPrefix("hive_run") {
            category = .board
        } else {
            category = .tools
        }
        return InspectorEventRow(
            id: event.eventId, occurredAt: event.occurredAt, category: category, mark: mark,
            label: toolLabel(toolName: toolName, toolKind: string(event, "toolKind")),
            subject: string(event, "subject").map(shortPath),
            detail: detail, shownInChat: false)
    }

    private static let toolKindLabels: [String: String] = [
        "read": "Read", "edit": "Edit", "delete": "Delete", "move": "Move", "search": "Search",
        "execute": "Run", "think": "Think", "fetch": "Fetch", "switch_mode": "Switch mode",
    ]

    static func toolLabel(toolName: String, toolKind: String?) -> String {
        if let toolKind, let label = toolKindLabels[toolKind] { return label }
        let leaf = toolName.components(separatedBy: "__").last ?? toolName
        let words = leaf
            .replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "Tool" }
        return String(first).uppercased() + words.dropFirst()
    }

    static func hiveToolName(_ toolName: String) -> String? {
        let lowered = toolName.lowercased()
        let bare = lowered.components(separatedBy: "__").last ?? lowered
        return bare.hasPrefix("hive_") ? bare : nil
    }

    static func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/").filter { !$0.isEmpty }
        return parts.suffix(3).joined(separator: "/")
    }

    private static func string(_ event: WorkspaceStatusEvent, _ key: String) -> String? {
        if case .string(let value)? = event.data[key] { return value }
        return nil
    }

    private static func integer(_ event: WorkspaceStatusEvent, _ key: String) -> Int? {
        switch event.data[key] {
        case .integer(let value)?: return Int(value)
        case .number(let value)?: return Int(value)
        default: return nil
        }
    }

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func elapsed(from start: String, to end: String) -> String? {
        guard let from = iso.date(from: start) ?? ISO8601DateFormatter().date(from: start),
              let to = iso.date(from: end) ?? ISO8601DateFormatter().date(from: end) else {
            return nil
        }
        let seconds = Int(to.timeIntervalSince(from).rounded())
        if seconds < 1 { return "<1s" }
        if seconds < 60 { return "\(seconds)s" }
        let rest = seconds % 60
        return "\(seconds / 60)m" + (rest == 0 ? "" : " \(rest)s")
    }

    /// Wall-clock time of day for a row, or a dash when the timestamp does not parse.
    public static func clock(_ at: String) -> String {
        guard let date = iso.date(from: at) ?? ISO8601DateFormatter().date(from: at) else {
            return "--:--:--"
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }
}
