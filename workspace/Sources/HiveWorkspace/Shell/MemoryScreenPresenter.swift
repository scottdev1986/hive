
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

    /// One library row resolved into everything the screen draws for it. Every
    /// kind fills the same cells, and `facts` carries the provenance that is
    /// particular to a kind — source and evidence for an article, the agent and
    /// session for a digest — so neither the table nor the selected-memory
    /// preview drops a field the wire sent. One resolution serves both: a second
    /// switch over the same rows would be a second place for a kind to go
    /// missing.
    struct LibraryRow: Equatable {
        let id: String
        let title: String
        let detail: String
        let kind: String
        let scope: String
        let status: String
        let updated: String
        let facts: [Fact]

        struct Fact: Equatable {
            let label: String
            let value: String
        }
    }

    /// A nullable wire field the daemon did not send. It reads as unrecorded
    /// rather than as a value, because an absent field is unknown and never a
    /// measured "none".
    private static let unrecorded = "not recorded"

    static func libraryRow(_ item: MemoryLibraryItem) -> LibraryRow {
        typealias Fact = LibraryRow.Fact
        func list(_ values: [String]) -> String {
            values.isEmpty ? "none" : values.joined(separator: " · ")
        }
        switch item {
        case .article(let row), .pitfall(let row):
            return LibraryRow(
                id: row.id, title: row.title,
                detail: "\(row.topic) · source \(row.source.rawValue) "
                    + "· evidence \(row.evidence)",
                kind: row.kind.rawValue, scope: row.scope.rawValue,
                status: row.status.rawValue, updated: row.updated,
                facts: [
                    Fact(label: "Topic", value: row.topic),
                    Fact(label: "Updated", value: row.updated),
                    Fact(label: "Revision", value: row.revision),
                    Fact(label: "Source", value: row.source.rawValue),
                    Fact(label: "Verified", value: row.verified ?? unrecorded),
                    Fact(label: "Evidence", value: row.evidence),
                    Fact(label: "Raw references", value: list(row.rawRefs)),
                    Fact(label: "Supersedes", value: list(row.supersedes)),
                ])
        case .fact(let row):
            let confidence = row.confidence.map { String($0) } ?? "unknown"
            return LibraryRow(
                id: row.id, title: row.title,
                detail: "\(row.topic) · confidence \(confidence) · valid \(row.validAt)",
                kind: row.kind, scope: row.scope.rawValue,
                status: row.status.rawValue, updated: row.updated,
                facts: [
                    Fact(label: "Topic", value: row.topic),
                    Fact(label: "Updated", value: row.updated),
                    Fact(label: "Revision", value: row.revision),
                    Fact(label: "Source", value: row.source),
                    Fact(label: "Confidence", value: confidence),
                    Fact(label: "Valid from", value: row.validAt),
                    Fact(label: "Invalid at", value: row.invalidAt ?? unrecorded),
                ])
        case .digest(let row):
            return LibraryRow(
                id: row.id, title: row.title,
                detail: "\(row.topic) · agent \(row.agent) "
                    + "· session \(row.sessionId ?? "unknown")",
                kind: row.kind, scope: row.scope.rawValue,
                status: row.status.rawValue, updated: row.updated,
                facts: [
                    Fact(label: "Topic", value: row.topic),
                    Fact(label: "Updated", value: row.updated),
                    Fact(label: "Revision", value: row.revision),
                    Fact(label: "Source", value: row.source),
                    Fact(label: "Agent", value: row.agent),
                    Fact(label: "Session", value: row.sessionId ?? unrecorded),
                ])
        case .rawReference(let row):
            return LibraryRow(
                id: row.id, title: row.title,
                detail: "\(row.topic) · \(row.path) · \(row.bytes) bytes",
                kind: row.kind, scope: row.scope.rawValue,
                status: row.status.rawValue, updated: row.updated,
                facts: [
                    Fact(label: "Topic", value: row.topic),
                    Fact(label: "Updated", value: row.updated),
                    Fact(label: "Revision", value: row.revision),
                    Fact(label: "Source", value: row.source),
                    Fact(label: "Path", value: row.path),
                    Fact(label: "Bytes", value: String(row.bytes)),
                ])
        }
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
