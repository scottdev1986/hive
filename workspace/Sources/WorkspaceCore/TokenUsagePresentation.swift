import Foundation

/// How the Usage page reads provider counts.
///
/// The daemon's numbers are honest but cumulative PER REQUEST: every turn
/// re-sends the whole conversation, so `inputTokens` counts the same context
/// once per turn. Summed over a session that is arithmetically real and
/// editorially meaningless — a 33-minute orchestrator session reads as 51M
/// input tokens of which 48.8M is the same context re-read from cache. Leading
/// with that number reads as a billing catastrophe, so the page leads with the
/// tokens a session ingested or produced for the FIRST time, and shows cache
/// reads beside them as their own clearly-labelled figure.
///
/// `cachedInputTokens` (cache reads) and `cacheCreationInputTokens` (cache
/// writes) are exact, disjoint components of `inputTokens`, not estimates: the
/// Claude adapter builds the total as `input + cacheCreation + cacheRead`
/// (`src/daemon/token-usage.ts:184`), so `inputTokens - cacheReads` is the
/// vendor's own uncached input plus its own cache-creation count. Nothing here
/// is derived beyond that identity.
///
/// The headline needs only the reads: everything else in `inputTokens` is input
/// the model processed for the first time, whether or not it also wrote the
/// cache. Claude reports both subsets; Codex and Grok report reads and leave
/// writes null. A provider that reports no reads at all leaves the split
/// unknown, and unknown is what we say — it is never guessed, and the raw
/// cumulative totals stay on screen either way.
public struct TokenHeadline: Equatable, Sendable {
    /// Input the provider did not serve from cache: `inputTokens` minus cache
    /// reads. Includes tokens that also wrote the cache — those are new too.
    /// nil when the provider reports no cache reads.
    public var newInputTokens: Int?
    /// New input that did NOT also write the cache. Needs the cache-write
    /// subset, which not every provider reports; detail, never the headline.
    public var freshInputTokens: Int?
    /// Context re-sent and served from cache. Not new consumption.
    public var cacheReadTokens: Int?
    /// Input written into the cache for later turns to re-read.
    public var cacheWriteTokens: Int?
    public var outputTokens: Int
    /// The headline: new input + output. Every token this session saw for the
    /// first time, and nothing it merely re-read. nil when the provider reports
    /// no cache reads.
    public var newTokens: Int?
    /// Raw provider input, cache reads included — cumulative across requests.
    public var cumulativeInputTokens: Int
    /// Raw provider total, cache reads included — cumulative across requests.
    public var cumulativeTotalTokens: Int
}

extension TokenCounts {
    public var headline: TokenHeadline {
        let opaque = TokenHeadline(
            newInputTokens: nil,
            freshInputTokens: nil,
            cacheReadTokens: cachedInputTokens,
            cacheWriteTokens: cacheCreationInputTokens,
            outputTokens: outputTokens,
            newTokens: nil,
            cumulativeInputTokens: inputTokens,
            cumulativeTotalTokens: totalTokens)
        guard let reads = cachedInputTokens else { return opaque }
        let newInput = inputTokens - reads
        // A provider that contradicts the documented subset rule gets no
        // derived headline: we would be inventing the split.
        guard newInput >= 0 else { return opaque }
        let fresh = cacheCreationInputTokens.map { newInput - $0 }.flatMap { $0 >= 0 ? $0 : nil }
        return TokenHeadline(
            newInputTokens: newInput,
            freshInputTokens: fresh,
            cacheReadTokens: reads,
            cacheWriteTokens: cacheCreationInputTokens,
            outputTokens: outputTokens,
            newTokens: newInput + outputTokens,
            cumulativeInputTokens: inputTokens,
            cumulativeTotalTokens: totalTokens)
    }
}

/// One line in the Usage page's per-agent list.
public struct TokenUsageRow: Equatable, Sendable {
    public var name: String
    public var provider: String
    public var model: String?
    /// nil means no provider reading; `unknownReason` then says why.
    public var counts: TokenCounts?
    public var unknownReason: String?
}

extension TokenUsageSession {
    /// The agents a reader should see: ONE orchestrator, then every worker.
    ///
    /// A "backup orchestrator" is not a second orchestrator. It is the same
    /// orchestrator relaunched by the supervisor after its process exited
    /// (`src/cli/orchestrator-supervisor.ts`), and each relaunch opens another
    /// orchestrator subject in the SAME session. Listing those generations
    /// separately implies Hive runs several orchestrators at once, which it
    /// does not, so they collapse into one row.
    ///
    /// The collapsed row shows `hiveControl.counts` — the daemon's own sum over
    /// every measured orchestrator subject. It is the same aggregate the card's
    /// control bucket already displays, so collapsing can neither lose usage nor
    /// double-count it. An orchestrator generation with no reading is not in
    /// that sum and stays listed in `unknownSubjects`, exactly as before.
    /// The genuine workers — role == "worker" EXACTLY, mirroring the daemon's
    /// workerSessions aggregate (src/daemon/token-usage.ts). Partitioning by
    /// exclusion instead would let a future role drift silently into WORKERS; the
    /// worker partition is defined by what a worker IS, never by what it is not.
    public var workerSubjects: [TokenUsageSubject] {
        subjects.filter { $0.role == "worker" }
    }

    /// Subjects whose role this build does not recognise. They stay VISIBLE in
    /// the agent list (never silently dropped) but are held OUT of the worker
    /// partition — a neutral bucket, so an axis drift can never quietly
    /// reclassify a new kind as task work.
    public var unclassifiedSubjects: [TokenUsageSubject] {
        let known: Set<String> = ["orchestrator", "worker", "profiler"]
        return subjects.filter { !known.contains($0.role) }
    }

    public var usageRows: [TokenUsageRow] {
        // The orchestrator and profiler each collapse into a single row from
        // their own daemon aggregate. Workers (role == "worker", exactly) are
        // listed individually, then any unrecognised role — visible, but kept out
        // of the worker partition and never folded into the profiler's row. A
        // profiler, in particular, must never fall through into WORKERS.
        let orchestrators = subjects.filter { $0.role == "orchestrator" }
        let profilers = subjects.filter { $0.role == "profiler" }
        var rows: [TokenUsageRow] = []
        // Backup orchestrators are relaunches of the ONE orchestrator, so they
        // collapse into a single row showing the daemon's own control aggregate.
        if let orchestratorRow = collapsedRow(
            name: "Orchestrator", generations: orchestrators, counts: hiveControl.counts) {
            rows.append(orchestratorRow)
        }
        // The dedicated profiling row, from profilingSessions — never WORKERS.
        if let profilingRow = collapsedRow(
            name: "Profiling", generations: profilers, counts: profilingSessions?.counts) {
            rows.append(profilingRow)
        }
        return rows + workerSubjects.map(individualRow) + unclassifiedSubjects.map(individualRow)
    }

    /// One agent's own row, from its own reading.
    private func individualRow(_ subject: TokenUsageSubject) -> TokenUsageRow {
        switch subject.reading {
        case .measured(let counts, _, _):
            return TokenUsageRow(
                name: subject.name, provider: subject.provider, model: subject.model,
                counts: counts, unknownReason: nil)
        case .unknown(let reason):
            return TokenUsageRow(
                name: subject.name, provider: subject.provider, model: subject.model,
                counts: nil, unknownReason: reason)
        }
    }

    /// Collapse one role's subjects (its generations) into a single row that
    /// shows the daemon's own aggregate for that role. The newest generation
    /// names the provider/model; `nil` counts becomes an honest unknown carrying
    /// the first generation's reason. Returns nil when the role has no subjects.
    private func collapsedRow(
        name: String, generations: [TokenUsageSubject], counts: TokenCounts?
    ) -> TokenUsageRow? {
        guard let current = generations.max(by: { $0.startedAt < $1.startedAt }) else {
            return nil
        }
        let unknownReason: String? = generations.compactMap { subject -> String? in
            if case .unknown(let reason) = subject.reading { return reason }
            return nil
        }.first
        return TokenUsageRow(
            name: name,
            provider: current.provider,
            model: current.model,
            counts: counts,
            unknownReason: counts == nil
                ? (unknownReason ?? "No provider token reading has been observed")
                : nil)
    }
}
