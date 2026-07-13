import AppKit
import WorkspaceCore

/// USAGE — provider-reported tokens for the whole Hive session. The control
/// bucket is exact; worker sessions are deliberately labelled mixed because
/// their transcripts contain both task work and embedded Hive protocol.
///
/// Every figure leads with NEW tokens (see `TokenHeadline`). The provider's raw
/// input count is cumulative per request — the whole conversation is re-sent
/// each turn — so it is dominated by cached re-reads and says nothing about
/// consumption. Cache reads are shown, labelled, beside it; they are never
/// folded into a headline.
final class UsageSettingsController: SettingsPageController {

    override func buildContent() {
        addHeader(
            title: "Usage",
            subtitle: "Provider-reported tokens across every agent in a Hive session. "
                + "Tokens used counts the work the models actually did; context re-read "
                + "from cache on later turns is excluded and shown separately.")
        addBanners()

        guard let snapshot = dataSource.snapshot else { return }
        guard let usage = snapshot.tokenUsage else {
            let panel = InsetPanelView()
            let title = NSTextField(labelWithString: "Token usage is unavailable")
            title.font = Theme.Font.headline
            title.compressHorizontally()
            let reason = NSTextField(wrappingLabelWithString:
                snapshot.tokenUsageError
                    ?? "The running daemon predates session token tracking. Restart Hive after updating.")
            reason.font = Theme.Font.callout
            reason.textColor = .secondaryLabelColor
            reason.compressHorizontally()
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
            label.compressHorizontally()
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
        title.compressHorizontally(toolTip: title.stringValue)
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

        let counts = session.fleet.counts
        let headline = counts?.headline
        // One basis for the whole card. The fleet aggregate loses its cache
        // split as soon as any agent's provider does not report one, and mixing
        // a new-token figure with a cumulative one would make the rows stop
        // adding up. When the split is gone, every figure here is cumulative
        // and says so.
        let newBasis = headline?.newTokens != nil
        let summary = newBasis
            ? NSStackView(views: [
                metric("Tokens used", headline?.newTokens),
                metric("New input", headline?.newInputTokens),
                metric("Output", counts?.outputTokens),
              ])
            : NSStackView(views: [
                metric("All tokens", counts?.totalTokens),
                metric("Input", counts?.inputTokens),
                metric("Output", counts?.outputTokens),
              ])
        summary.orientation = .horizontal
        summary.distribution = .fillEqually
        summary.spacing = Theme.Space.m
        card.contentStack.addArrangedSubview(summary)
        card.pinToContentWidth(summary)

        let cache = NSTextField(wrappingLabelWithString: cacheDetail(headline))
        cache.font = Theme.Font.caption
        cache.textColor = .secondaryLabelColor
        cache.compressHorizontally()
        card.contentStack.addArrangedSubview(cache)
        card.pinToContentWidth(cache)

        card.contentStack.addArrangedSubview(NSBox.hdsSeparator())
        addBucket(
            to: card,
            title: "Hive control",
            detail: controlDetail(session),
            counts: session.hiveControl.counts,
            newBasis: newBasis)
        addBucket(
            to: card,
            title: "Worker sessions",
            detail: "Task work plus Hive coordination embedded in worker turns; no provider reports that split.",
            counts: session.workerSessions.counts,
            newBasis: newBasis)

        if !session.unknownSubjects.isEmpty {
            let unknown = NSTextField(wrappingLabelWithString:
                "Not included yet: " + session.unknownSubjects.joined(separator: ", "))
            unknown.font = Theme.Font.caption
            unknown.textColor = .systemOrange
            unknown.compressHorizontally()
            card.contentStack.addArrangedSubview(unknown)
            card.pinToContentWidth(unknown)
        }

        let rows = session.usageRows
        if !rows.isEmpty {
            card.contentStack.addArrangedSubview(NSBox.hdsSeparator())
            let label = NSTextField(labelWithString: "AGENTS")
            label.font = Theme.Font.sectionLabel
            label.textColor = .secondaryLabelColor
            label.compressHorizontally()
            card.contentStack.addArrangedSubview(label)
            for usage in rows {
                let row = agentRow(usage, newBasis: newBasis)
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
        counts: TokenCounts?,
        newBasis: Bool
    ) {
        let headline = counts?.headline
        let name = NSTextField(labelWithString: title)
        name.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        name.compressHorizontally()
        let bucketTotal = newBasis ? headline?.newTokens : counts?.totalTokens
        let total = NSTextField(labelWithString: format(bucketTotal))
        total.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        total.compressHorizontally()
        let heading = NSStackView(views: [name, NSView.spacer(), total])
        heading.orientation = .horizontal
        heading.alignment = .centerY
        card.contentStack.addArrangedSubview(heading)
        card.pinToContentWidth(heading)

        let countsDetail: String
        if newBasis, let newInput = headline?.newInputTokens, let reads = headline?.cacheReadTokens {
            countsDetail = " · " + format(newInput) + " new input · "
                + format(headline?.outputTokens) + " output · "
                + format(reads) + " cache reads, counted separately"
        } else {
            countsDetail = counts.map {
                " · " + format($0.inputTokens) + " input, cache reads included · "
                    + format($0.outputTokens) + " output"
            } ?? " · No provider reading"
        }
        let caption = NSTextField(wrappingLabelWithString: detail + countsDetail)
        caption.font = Theme.Font.caption
        caption.textColor = .secondaryLabelColor
        caption.compressHorizontally()
        card.contentStack.addArrangedSubview(caption)
        card.pinToContentWidth(caption)
    }

    private func agentRow(_ usage: TokenUsageRow, newBasis: Bool) -> NSView {
        let provider = ProviderID(usage.provider)
        let name = NSTextField(labelWithString: usage.name)
        name.font = Theme.Font.callout
        name.lineBreakMode = .byTruncatingTail
        name.compressHorizontally(toolTip: usage.name)

        let identity = [provider.rawValue.capitalized, usage.model]
            .compactMap { $0 }.joined(separator: " · ")
        let secondary = NSTextField(labelWithString: identity)
        secondary.font = Theme.Font.caption
        secondary.textColor = .secondaryLabelColor
        secondary.lineBreakMode = .byTruncatingTail
        secondary.compressHorizontally(priority: 200, toolTip: identity)
        let labels = NSStackView(views: [name, secondary])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2

        let reading: String
        let toolTip: String?
        if let counts = usage.counts {
            let newTokens = newBasis ? counts.headline.newTokens : nil
            reading = format(newTokens ?? counts.totalTokens)
            toolTip = "Cumulative across every request, cache reads included: "
                + format(counts.totalTokens) + " (" + format(counts.inputTokens) + " input, "
                + format(counts.outputTokens) + " output)"
        } else {
            reading = "Unknown"
            toolTip = usage.unknownReason
        }
        let value = NSTextField(labelWithString: reading)
        value.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        value.textColor = usage.counts == nil ? .secondaryLabelColor : .labelColor
        value.toolTip = toolTip
        value.compressHorizontally()

        let row = NSStackView(views: [labels, NSView.spacer(), value])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        return row
    }

    private func metric(_ title: String, _ value: Int?) -> NSView {
        let number = NSTextField(labelWithString: format(value))
        number.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .semibold)
        number.compressHorizontally()
        let label = NSTextField(labelWithString: title)
        label.font = Theme.Font.caption
        label.textColor = .secondaryLabelColor
        label.compressHorizontally()
        let stack = NSStackView(views: [number, label])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        return stack
    }

    /// Cache reads get their own sentence and never a headline: they are the
    /// same context re-sent to the model each turn, and on a long session they
    /// dwarf everything the session actually consumed. The raw cumulative
    /// totals stay on screen — a reader who wants them can still have them.
    private func cacheDetail(_ headline: TokenHeadline?) -> String {
        guard let headline else { return "No provider reading yet." }
        guard let reads = headline.cacheReadTokens, headline.newTokens != nil else {
            return "No cache breakdown is reported, so re-read context cannot be separated "
                + "from new input. Input counts every request in full, including context the "
                + "model has already seen."
        }
        // The write/fresh split is detail, and Codex does not report it. Say so
        // rather than implying every new input token was uncached.
        // The fleet figure mixes providers, so this never says "this provider".
        let writes = headline.freshInputTokens.map { fresh in
            "Of the new input, " + format(fresh) + " was uncached and "
                + format(headline.cacheWriteTokens) + " wrote the cache. "
        } ?? "How much of the new input wrote the cache is not reported. "
        return format(reads) + " cache reads — the same context re-sent and re-read on every "
            + "turn. Excluded from tokens used, but not free: providers bill re-read context "
            + "at a discount to fresh input, never at zero, and on a long session there are "
            + "far more of them. How they count against a subscription's limits is not "
            + "something Hive can read. " + writes
            + "Cumulative across every request, cache reads included: "
            + format(headline.cumulativeInputTokens) + " input, "
            + format(headline.cumulativeTotalTokens) + " total."
    }

    private func controlDetail(_ session: TokenUsageSession) -> String {
        guard let fleet = session.fleet.counts, let control = session.hiveControl.counts else {
            return "Exact orchestrator tokens."
        }
        // Both sides of the ratio come from the same basis, or it means nothing.
        let (orchestrator, total) = fleet.headline.newTokens.flatMap { fleetNew in
            control.headline.newTokens.map { ($0, fleetNew) }
        } ?? (control.totalTokens, fleet.totalTokens)
        guard total > 0 else { return "Exact orchestrator tokens." }
        let percent = Double(orchestrator) / Double(total) * 100
        return String(format:
            "Exact orchestrator tokens; %.1f%% of the known total, a lower bound on Hive overhead.",
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
