import AppKit
import WorkspaceCore

/// USAGE — provider-reported tokens for the whole Hive session. The control
/// bucket is exact; worker sessions are deliberately labelled mixed because
/// their transcripts contain both task work and embedded Hive protocol.
final class UsageSettingsController: SettingsPageController {

    override func buildContent() {
        addHeader(
            title: "Usage",
            subtitle: "Provider-reported input and output tokens across every agent in a "
                + "Hive session. Backup orchestrators stay in the same session total.")
        addBanners()

        guard let snapshot = dataSource.snapshot else { return }
        guard let usage = snapshot.tokenUsage else {
            let panel = InsetPanelView()
            let title = NSTextField(labelWithString: "Token usage is unavailable")
            title.font = Theme.Font.headline
            let reason = NSTextField(wrappingLabelWithString:
                snapshot.tokenUsageError
                    ?? "The running daemon predates session token tracking. Restart Hive after updating.")
            reason.font = Theme.Font.callout
            reason.textColor = .secondaryLabelColor
            panel.contentStack.addArrangedSubview(title)
            panel.contentStack.addArrangedSubview(reason)
            reason.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
            contentStack.addArrangedSubview(panel)
            pinToContent(panel)
            return
        }

        if usage.sessions.isEmpty {
            let panel = InsetPanelView()
            let label = NSTextField(wrappingLabelWithString:
                "No metered Hive session has started yet. Token tracking begins with the next orchestrator launch.")
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            panel.contentStack.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
            contentStack.addArrangedSubview(panel)
            pinToContent(panel)
            return
        }

        for session in usage.sessions {
            addSession(session, current: session.id == usage.currentSessionId)
        }
    }

    private func addSession(_ session: TokenUsageSession, current: Bool) {
        let card = CardView()

        let title = NSTextField(labelWithString: current ? "Current session" : sessionTitle(session))
        title.font = Theme.Font.headline
        let status = CapsuleBadge(
            text: session.complete ? "Complete reading" : "Known subtotal",
            symbol: session.complete ? "checkmark.circle" : "questionmark.circle",
            style: session.complete ? .neutral : .warning)
        let heading = NSStackView(views: [title, NSView.spacer(), status])
        heading.orientation = .horizontal
        heading.alignment = .centerY
        heading.spacing = Theme.Space.m
        card.contentStack.addArrangedSubview(heading)
        card.pinToContentWidth(heading)

        let summary = NSStackView(views: [
            metric("All agents", session.fleet.counts?.totalTokens),
            metric("Input", session.fleet.counts?.inputTokens),
            metric("Output", session.fleet.counts?.outputTokens),
        ])
        summary.orientation = .horizontal
        summary.distribution = .fillEqually
        summary.spacing = Theme.Space.m
        card.contentStack.addArrangedSubview(summary)
        card.pinToContentWidth(summary)

        card.contentStack.addArrangedSubview(NSBox.hdsSeparator())
        addBucket(
            to: card,
            title: "Hive control",
            detail: controlDetail(session),
            counts: session.hiveControl.counts)
        addBucket(
            to: card,
            title: "Worker sessions",
            detail: "Task work plus Hive coordination embedded in worker turns; no provider reports that split.",
            counts: session.workerSessions.counts)

        if !session.unknownSubjects.isEmpty {
            let unknown = NSTextField(wrappingLabelWithString:
                "Not included yet: " + session.unknownSubjects.joined(separator: ", "))
            unknown.font = Theme.Font.caption
            unknown.textColor = .systemOrange
            card.contentStack.addArrangedSubview(unknown)
            card.pinToContentWidth(unknown)
        }

        if !session.subjects.isEmpty {
            card.contentStack.addArrangedSubview(NSBox.hdsSeparator())
            let label = NSTextField(labelWithString: "SESSIONS")
            label.font = Theme.Font.sectionLabel
            label.textColor = .secondaryLabelColor
            card.contentStack.addArrangedSubview(label)
            for subject in session.subjects {
                let row = subjectRow(subject)
                card.contentStack.addArrangedSubview(row)
                card.pinToContentWidth(row)
            }
        }

        contentStack.addArrangedSubview(card)
        pinToContent(card)
    }

    private func addBucket(
        to card: CardView,
        title: String,
        detail: String,
        counts: TokenCounts?
    ) {
        let name = NSTextField(labelWithString: title)
        name.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let total = NSTextField(labelWithString: format(counts?.totalTokens))
        total.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        let heading = NSStackView(views: [name, NSView.spacer(), total])
        heading.orientation = .horizontal
        heading.alignment = .centerY
        card.contentStack.addArrangedSubview(heading)
        card.pinToContentWidth(heading)

        let countsDetail = counts.map {
            " · " + format($0.inputTokens) + " input · "
                + format($0.outputTokens) + " output"
        } ?? " · No provider reading"
        let caption = NSTextField(wrappingLabelWithString: detail + countsDetail)
        caption.font = Theme.Font.caption
        caption.textColor = .secondaryLabelColor
        card.contentStack.addArrangedSubview(caption)
        card.pinToContentWidth(caption)
    }

    private func subjectRow(_ subject: TokenUsageSubject) -> NSView {
        let provider = ProviderID(subject.provider)
        let name = NSTextField(labelWithString: subject.name)
        name.font = Theme.Font.callout
        name.lineBreakMode = .byTruncatingTail

        let identity = [provider.rawValue.capitalized, subject.model]
            .compactMap { $0 }.joined(separator: " · ")
        let secondary = NSTextField(labelWithString: identity)
        secondary.font = Theme.Font.caption
        secondary.textColor = .secondaryLabelColor
        secondary.lineBreakMode = .byTruncatingTail
        let labels = NSStackView(views: [name, secondary])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2

        let reading: String
        let toolTip: String?
        switch subject.reading {
        case .measured(let counts, _, _):
            reading = format(counts.totalTokens)
            toolTip = nil
        case .unknown(let reason):
            reading = "Unknown"
            toolTip = reason
        }
        let value = NSTextField(labelWithString: reading)
        value.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        value.textColor = toolTip == nil ? .labelColor : .secondaryLabelColor
        value.toolTip = toolTip

        let row = NSStackView(views: [labels, NSView.spacer(), value])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        return row
    }

    private func metric(_ title: String, _ value: Int?) -> NSView {
        let number = NSTextField(labelWithString: format(value))
        number.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .semibold)
        let label = NSTextField(labelWithString: title)
        label.font = Theme.Font.caption
        label.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [number, label])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        return stack
    }

    private func controlDetail(_ session: TokenUsageSession) -> String {
        guard let total = session.fleet.counts?.totalTokens,
              let control = session.hiveControl.counts?.totalTokens,
              total > 0 else {
            return "Exact orchestrator and backup-orchestrator tokens."
        }
        let percent = Double(control) / Double(total) * 100
        return String(format:
            "Exact orchestrator and backup-orchestrator tokens; %.1f%% of the known total, a lower bound on Hive overhead.",
            percent)
    }

    private func sessionTitle(_ session: TokenUsageSession) -> String {
        guard let date = ISO8601DateFormatter().date(from: session.startedAt) else {
            return "Previous session"
        }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }

    private func format(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    private func format(_ value: Int?) -> String {
        value.map(format) ?? "—"
    }
}
