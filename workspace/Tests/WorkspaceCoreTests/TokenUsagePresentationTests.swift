import XCTest
@testable import WorkspaceCore

/// The Usage page's honesty rules, as tests. Each is a way the page could lie:
/// - a session that mostly re-read its cache headlining as 50M tokens consumed
/// - a provider that reports no cache split having one guessed for it
/// - the supervisor's backup generations reading as several live orchestrators
/// - collapsing those generations quietly losing or double-counting their usage
final class TokenUsagePresentationTests: XCTestCase {

    // Measured from the live daemon, orchestrator subject, ~33-minute session.
    private let cacheDominated = TokenCounts(
        inputTokens: 51_146_205,
        cachedInputTokens: 48_803_343,
        cacheCreationInputTokens: 2_319_590,
        outputTokens: 505_059,
        reasoningTokens: nil,
        totalTokens: 51_651_264)

    // MARK: Defect 1 — the headline must mean something

    func testCacheDominatedSessionDoesNotHeadlineFiftyMillionTokens() throws {
        let headline = cacheDominated.headline

        // 51,146,205 input − 48,803,343 re-read = 2,342,862 new input, of which
        // 2,319,590 wrote the cache and 23,272 was uncached.
        XCTAssertEqual(headline.newInputTokens, 2_342_862)
        XCTAssertEqual(headline.freshInputTokens, 23_272)
        XCTAssertEqual(headline.cacheReadTokens, 48_803_343)
        XCTAssertEqual(headline.cacheWriteTokens, 2_319_590)
        // 2,342,862 new input + 505,059 out.
        XCTAssertEqual(headline.newTokens, 2_847_921)

        // The point of the fix: nothing a reader leads with implies 50M tokens
        // of consumption. The old headline was totalTokens — 51,651,264.
        let headlined = try XCTUnwrap(headline.newTokens)
        XCTAssertLessThan(headlined, 3_000_000)
    }

    /// Codex reports cache reads but leaves cache writes null. Requiring both
    /// subsets threw the split away for the WHOLE fleet the moment one Codex
    /// agent joined it, and the 82M cumulative headline came straight back —
    /// caught in the running app, not by a typecheck.
    func testCodexReportsReadsWithoutWritesAndStillGetsAHeadline() {
        let codex = TokenCounts(
            inputTokens: 2_488_274, cachedInputTokens: 2_367_232,
            cacheCreationInputTokens: nil, outputTokens: 9_217,
            reasoningTokens: nil, totalTokens: 2_497_491)
        let headline = codex.headline

        XCTAssertEqual(headline.newInputTokens, 121_042)
        XCTAssertEqual(headline.newTokens, 130_259)
        // The write/fresh split is genuinely unknown here — and stays unknown.
        XCTAssertNil(headline.freshInputTokens)
        XCTAssertNil(headline.cacheWriteTokens)
    }

    func testRawCumulativeTotalsStaySoTheUserCanStillSeeThem() {
        let headline = cacheDominated.headline
        XCTAssertEqual(headline.cumulativeInputTokens, 51_146_205)
        XCTAssertEqual(headline.cumulativeTotalTokens, 51_651_264)
    }

    func testProviderWithoutACacheSplitGetsNoGuessedSplit() {
        let counts = TokenCounts(
            inputTokens: 900, cachedInputTokens: nil, cacheCreationInputTokens: nil,
            outputTokens: 100, reasoningTokens: nil, totalTokens: 1_000)
        let headline = counts.headline

        XCTAssertNil(headline.newInputTokens)
        XCTAssertNil(headline.freshInputTokens)
        XCTAssertNil(headline.newTokens)
        XCTAssertEqual(headline.outputTokens, 100)
        XCTAssertEqual(headline.cumulativeInputTokens, 900)
        XCTAssertEqual(headline.cumulativeTotalTokens, 1_000)
    }

    func testSubsetsThatContradictTheirTotalGetNoDerivedHeadline() {
        let counts = TokenCounts(
            inputTokens: 100, cachedInputTokens: 200, cacheCreationInputTokens: 0,
            outputTokens: 10, reasoningTokens: nil, totalTokens: 110)
        XCTAssertNil(counts.headline.newInputTokens)
        XCTAssertNil(counts.headline.newTokens)
    }

    // MARK: Defect 2 — one orchestrator, and the total survives collapsing it

    func testBackupGenerationsCollapseIntoOneOrchestratorRow() {
        let session = sessionWithTwoOrchestratorGenerations()
        let rows = session.usageRows

        XCTAssertEqual(rows.map(\.name), ["Queen", "maya"])
        XCTAssertEqual(rows[0].model, "claude-opus-4-8", "the running generation names the row")
    }

    func testCollapsingGenerationsNeitherLosesNorDoubleCountsTokens() {
        let session = sessionWithTwoOrchestratorGenerations()
        let rows = session.usageRows

        // The collapsed row IS the daemon's control bucket: both generations,
        // summed once.
        XCTAssertEqual(rows[0].counts?.totalTokens, 700)
        XCTAssertEqual(rows[0].counts?.totalTokens, session.hiveControl.counts?.totalTokens)

        // And the rows still add up to the whole fleet — nothing dropped.
        let rowTotal = rows.compactMap { $0.counts?.totalTokens }.reduce(0, +)
        XCTAssertEqual(rowTotal, session.fleet.counts?.totalTokens)
    }

    func testAnOrchestratorWithNoReadingStaysUnknownRatherThanZero() {
        var session = sessionWithTwoOrchestratorGenerations()
        session.subjects = [
            subject(id: "s1", name: "Orchestrator", role: "orchestrator",
                    startedAt: "2026-07-13T12:00:00Z",
                    reading: .unknown(reason: "No provider token reading has been observed")),
        ]
        session.hiveControl = TokenUsageBreakdown(counts: nil, subjectCount: 0)

        let rows = session.usageRows
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].counts)
        XCTAssertEqual(rows[0].unknownReason, "No provider token reading has been observed")
    }

    // MARK: Fixtures

    /// Two orchestrator subjects — the supervisor relaunched after a crash — and
    /// one worker, in one session, exactly as the daemon records them.
    private func sessionWithTwoOrchestratorGenerations() -> TokenUsageSession {
        let first = counts(input: 200, output: 100)     // 300
        let second = counts(input: 300, output: 100)    // 400
        let worker = counts(input: 80, output: 20)      // 100
        return TokenUsageSession(
            id: "session-1",
            repoRoot: "/repo",
            startedAt: "2026-07-13T12:00:00Z",
            endedAt: nil,
            complete: true,
            unknownSubjects: [],
            fleet: TokenUsageBreakdown(counts: counts(input: 580, output: 220), subjectCount: 3),
            hiveControl: TokenUsageBreakdown(counts: counts(input: 500, output: 200), subjectCount: 2),
            workerSessions: TokenUsageBreakdown(counts: worker, subjectCount: 1),
            subjects: [
                subject(id: "s1", name: "Orchestrator", role: "orchestrator",
                        startedAt: "2026-07-13T12:00:00Z",
                        reading: .measured(counts: first, source: "claude", observedAt: "2026-07-13T12:05:00Z")),
                subject(id: "s2", name: "Orchestrator", role: "orchestrator",
                        startedAt: "2026-07-13T12:10:00Z",
                        reading: .measured(counts: second, source: "claude", observedAt: "2026-07-13T12:20:00Z")),
                subject(id: "s3", name: "maya", role: "worker",
                        startedAt: "2026-07-13T12:11:00Z",
                        reading: .measured(counts: worker, source: "claude", observedAt: "2026-07-13T12:20:00Z")),
            ])
    }

    private func counts(input: Int, output: Int) -> TokenCounts {
        TokenCounts(
            inputTokens: input, cachedInputTokens: 0, cacheCreationInputTokens: 0,
            outputTokens: output, reasoningTokens: nil, totalTokens: input + output)
    }

    private func subject(
        id: String, name: String, role: String, startedAt: String, reading: TokenUsageReading
    ) -> TokenUsageSubject {
        TokenUsageSubject(
            id: id, name: name, role: role, provider: "claude", model: "claude-opus-4-8",
            startedAt: startedAt, endedAt: nil, reading: reading)
    }
}
