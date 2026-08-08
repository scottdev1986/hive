
import Foundation
import WorkspaceCore

public enum MemoryScreenPresenter {
    static func recallRefusal(status: Int?, detail: String) -> ShellScreenProjection {
        let code = status.map { "HTTP \($0)" } ?? "unclassified refusal"
        return ShellScreenProjection(
            availability: .unknown,
            freshness: .unknown,
            source: ProjectionSource(),
            observedAt: nil,
            evidence: nil,
            contract: .frozen,
            facts: [ShellScreenFact(
                label: "Recall read refused",
                value: "\(code) · \(detail) · no prior recall value was replaced")])
    }

    static func retainingValue(
        from previous: ShellScreenProjection?,
        on failure: ShellScreenProjection
    ) -> ShellScreenProjection {
        if let previous,
           !previous.facts.isEmpty,
           failure.facts.contains(where: { $0.label == "Recall read refused" }) {
            return ShellScreenProjection(
                availability: previous.availability,
                freshness: previous.freshness,
                source: previous.source,
                observedAt: previous.observedAt,
                evidence: previous.evidence,
                contract: previous.contract,
                facts: previous.facts.filter { $0.label != "Recall read refused" }
                    + failure.facts)
        }
        guard failure.availability == .disconnected,
              failure.facts.isEmpty,
              let previous,
              !previous.facts.isEmpty else { return failure }
        return ShellScreenProjection(
            availability: .disconnected,
            freshness: .stale,
            source: previous.source,
            observedAt: previous.observedAt,
            evidence: failure.evidence,
            contract: previous.contract,
            facts: previous.facts)
    }

    public static func overview(
        _ projection: ClientProjection<MemoryOverviewProjection>
    ) -> ShellScreenProjection {
        projection.frozenScreen(facts: projection.value.map { value in
            common(value.metadata) + [
                ShellScreenFact(label: "Wiki store", value: store(value.wiki.state)),
                ShellScreenFact(label: "Wiki articles", value: String(value.wiki.articles)),
                ShellScreenFact(label: "Episodic store", value: store(value.episodic.state)),
                ShellScreenFact(label: "Hot event retention", value: "\(value.config.eventsHotDays) days"),
                ShellScreenFact(label: "Article stale threshold", value: "\(value.config.staleAfterDays) days"),
                ShellScreenFact(label: "Sweep interval", value: "\(value.config.sweepIntervalHours) hours"),
            ] + value.gaps.map {
                ShellScreenFact(label: "Gap · \($0.code)", value: $0.detail)
            }
        } ?? [])
    }

    public static func library(
        _ projection: ClientProjection<MemoryLibraryProjection>
    ) -> ShellScreenProjection {
        projection.frozenScreen(facts: projection.value.map { value in
            common(value.metadata) + [
                ShellScreenFact(label: "Library store", value: store(value.state)),
                ShellScreenFact(label: "Matching rows", value: String(value.total)),
            ] + value.items.map {
                let display = $0.display
                return ShellScreenFact(
                    label: "\(display.kind) · \(display.id)",
                    value: display.value)
            }
        } ?? [])
    }

    public static func recall(
        _ projection: ClientProjection<MemoryRecallPreview>
    ) -> ShellScreenProjection {
        projection.frozenScreen(facts: projection.value.map { value in
            common(value.metadata) + [
                ShellScreenFact(label: "Query", value: value.query),
                ShellScreenFact(label: "Recall store", value: store(value.state)),
                ShellScreenFact(label: "Search provenance", value: value.semantic),
                ShellScreenFact(
                    label: "Budget",
                    value: "\(value.tokens) of \(value.budget) tokens; \(value.omitted) omitted"),
                ShellScreenFact(label: "Mutation", value: value.mutation.rawValue),
            ] + value.rows.map {
                ShellScreenFact(
                    label: "#\($0.rank) · \($0.title)",
                    value: "\($0.class.rawValue) · \($0.scope)/\($0.topic)/\($0.id) · "
                        + "\($0.status) · \($0.snippet)")
            }
        } ?? [])
    }

    public static func maintenance(
        _ projection: ClientProjection<MemoryMaintenanceProjection>
    ) -> ShellScreenProjection {
        projection.frozenScreen(facts: projection.value.map { value in
            common(value.metadata) + [
                ShellScreenFact(label: "Job store", value: store(value.jobs.state)),
                ShellScreenFact(
                    label: "Consolidation candidates",
                    value: value.consolidation.state == .absent
                        ? store(.absent) : String(value.consolidation.candidates)),
            ] + value.jobs.recent.map { receipt in
                let total = receipt.progress.total.map(String.init) ?? "unknown"
                return ShellScreenFact(
                    label: "\(receipt.kind.title) · \(receipt.state.rawValue)",
                    value: "\(receipt.progress.step) · \(receipt.progress.done)/\(total) · "
                        + "requested by \(receipt.requestedBy) · started \(receipt.startedAt)")
            }
        } ?? [])
    }

    /// The words deliberately differ. A mutation that maps `.absent` to `.empty` changes the user's claim and is pinned by a named test.
    static func store(_ state: MemoryStoreState) -> String {
        switch state {
        case .absent: return "absent — no store is wired"
        case .empty: return "empty — the store exists with no rows"
        case .ok: return "available — rows were observed"
        }
    }

    private static func common(_ metadata: MemoryProjectionMetadata) -> [ShellScreenFact] {
        [
            ShellScreenFact(label: "Projection provenance", value: metadata.sourceRevision),
            ShellScreenFact(label: "Daemon observed", value: metadata.observedAt),
            ShellScreenFact(label: "Daemon freshness", value: metadata.freshness.rawValue),
        ]
    }
}
