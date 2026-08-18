// MemoryScreenViewTests.swift
//
// Drives the four Memory screens as rendered surfaces rather than as fact
// lists: absent, empty and available stores draw three different cards; the
// library pages against two separate daemons without blending their cursors;
// the recall preview reports its partitions, its omissions and its
// non-mutation; a failed job shows its failure and a finished one its readback;
// and every fault state keeps the last observed value while still reading as a
// fault.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class MemoryScreenViewTests: XCTestCase {

    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    /// The stress corpus: forty library rows, forty recall rows, twenty job
    /// receipts and twelve gaps. Bounding is measured against it, because a
    /// corpus that fits on the page cannot show whether a bound tells the truth.
    private var denseFixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures-dense")
            .path
    }

    // MARK: Corpus access — the same frozen rows the wire tests decode

    private func row(_ corpus: String, _ availability: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("\(corpus)-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: url)) as! [[String: Any]]
        return try XCTUnwrap(rows.first { $0["availability"] as? String == availability })
    }

    private func value(_ corpus: String) throws -> [String: Any] {
        try XCTUnwrap(try row(corpus, "current")["value"] as? [String: Any])
    }

    private func decode<Value: Decodable>(
        _ object: [String: Any],
        as type: Value.Type
    ) throws -> Value {
        try JSONDecoder().decode(
            type, from: try JSONSerialization.data(withJSONObject: object))
    }

    // MARK: View tree access

    private func find(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let match = find(subview, identifier) { return match }
        }
        return nil
    }

    private func identifiers(_ view: NSView) -> [String] {
        let own = view.accessibilityIdentifier()
        return (own.isEmpty ? [] : [own]) + view.subviews.flatMap(identifiers)
    }

    private func labels(_ view: NSView) -> [String] {
        let own = (view as? NSTextField).map { [$0.stringValue] } ?? []
        return own + view.subviews.flatMap(labels)
    }

    /// Fires the click a row carries. The row is not a button, so the test
    /// drives the recognizer the row was built with rather than a synthetic
    /// event the app would never see.
    private func click(_ view: NSView) throws {
        let recognizer = try XCTUnwrap(view.gestureRecognizers.first)
        let target = try XCTUnwrap(recognizer.target as? NSObject)
        _ = target.perform(try XCTUnwrap(recognizer.action))
    }

    private func screen(_ availability: ProjectionAvailability) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: availability,
            freshness: availability == .current ? .current : .stale,
            source: ProjectionSource(revision: "r1"),
            observedAt: "2026-07-30T20:00:00.000Z",
            evidence: nil,
            contract: .frozen,
            facts: [ShellScreenFact(label: "Projection provenance", value: "r1")])
    }

    // MARK: Acceptance 10 — absent, empty and available are three renderings

    func testOverviewDrawsAbsentEmptyAndAvailableStoresThreeDifferentWays() throws {
        func rendering(_ state: String) throws -> (identifiers: [String], text: String) {
            var object = try value("memory-overview")
            var wiki = object["wiki"] as! [String: Any]
            wiki["state"] = state
            if state != "ok" {
                wiki["articles"] = 0
                wiki["pitfalls"] = 0
                wiki["unverifiedPitfalls"] = 0
            }
            object["wiki"] = wiki
            let view = MemoryOverviewScreenView(
                screen: screen(.current),
                overview: try decode(object, as: MemoryOverviewProjection.self))
            view.layoutSubtreeIfNeeded()
            let card = try XCTUnwrap(
                find(view, "memory-store-wiki-\(state)"),
                "the wiki card must name the state it is rendering")
            return (identifiers(card), labels(card).joined(separator: " | "))
        }

        let absent = try rendering("absent")
        let empty = try rendering("empty")
        let available = try rendering("ok")

        XCTAssertNotEqual(absent.text, empty.text)
        XCTAssertNotEqual(empty.text, available.text)
        XCTAssertNotEqual(absent.text, available.text)
        XCTAssertTrue(absent.text.contains("no store is wired"))
        XCTAssertTrue(empty.text.contains("store exists with no rows"))
        XCTAssertTrue(available.text.contains("rows were observed"))
        // An absent store draws no counts at all: a zero there would be this
        // client's invention rather than the daemon's reading.
        XCTAssertFalse(absent.text.contains("Articles"))
        XCTAssertTrue(empty.text.contains("Articles"), "an empty store's zeros are measured")
        XCTAssertTrue(available.text.contains("Articles"))
    }

    func testOverviewRendersEachWikiScopeWithItsOwnState() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let view = MemoryOverviewScreenView(
            screen: screen(.current), overview: state.memory.overview)
        view.layoutSubtreeIfNeeded()
        let rendered = identifiers(view)

        // The fixture's repo scope has rows and its global scope does not; the
        // two must not render as one.
        XCTAssertTrue(rendered.contains("memory-store-wiki-repo-ok"), "\(rendered)")
        XCTAssertTrue(rendered.contains("memory-store-wiki-global-empty"), "\(rendered)")
        XCTAssertTrue(rendered.contains("memory-index-fts-ok"))
        XCTAssertTrue(rendered.contains("memory-index-vectors-ok"))
        XCTAssertTrue(rendered.contains("memory-config"))
    }

    // MARK: Acceptance 10 — pagination stays with the daemon that minted it

    /// Two daemons, two projects, two cursor spaces. The walk against alpha
    /// sends alpha's cursor back to alpha only, and beta's first page starts
    /// beta's own walk rather than extending alpha's.
    func testLibraryPagesAgainstTwoDaemonsWithoutBlendingTheirCursors() async throws {
        nonisolated(unsafe) var requested: [String: [String?]] = ["alpha": [], "beta": []]

        func daemon(_ project: String, pages: [String: (rows: [String], next: String?)])
            -> WorkspaceDaemonClient
        {
            WorkspaceDaemonClient(
                baseURL: URL(string: "http://127.0.0.1:1")!,
                authorization: "Bearer \(project)",
                loader: { request in
                    let cursor = URLComponents(
                        url: request.url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.first { $0.name == "cursor" }?.value
                    requested[project, default: []].append(cursor)
                    let page = try XCTUnwrap(
                        pages[cursor ?? ""],
                        "\(project) was asked for a cursor it never minted: \(cursor ?? "nil")")
                    let items = page.rows.map {
                        """
                        {"kind":"article","key":"article\\u0000repo\\u0000\($0)",
                         "scope":"repo","id":"\($0)","title":"\($0)","topic":"memory",
                         "updated":"2026-07-30","revision":"r1","source":"agent",
                         "status":"verified","verified":"2026-07-30","supersedes":[],
                         "rawRefs":[],"evidence":"two-daemon fixture"}
                        """
                    }.joined(separator: ",")
                    let next = page.next.map { "\"\($0)\"" } ?? "null"
                    let body = """
                    {"schemaVersion":1,"observedAt":"2026-07-30T20:00:00.000Z",
                     "sourceRevision":"\(project)-r1","freshness":"live","state":"ok",
                     "items":[\(items)],"nextCursor":\(next),"total":4}
                    """
                    return (Data(body.utf8), HTTPURLResponse(
                        url: request.url!, statusCode: 200,
                        httpVersion: nil, headerFields: nil)!)
                })
        }

        let alpha = daemon("alpha", pages: [
            "": (["alpha-1", "alpha-2"], "alpha-c2"),
            "alpha-c2": (["alpha-3", "alpha-4"], nil),
        ])
        let beta = daemon("beta", pages: [
            "": (["beta-1"], "beta-c2"),
        ])

        var state = ShellState()
        let alphaFirst = await MemoryLibraryGateway(client: alpha).fetch(step: .first)
        state.observe(
            libraryPage: try XCTUnwrap(alphaFirst.value), from: "alpha", step: .first)
        let alphaNext = try XCTUnwrap(state.memory.library?.nextStep)
        let alphaSecond = await MemoryLibraryGateway(client: alpha).fetch(step: alphaNext)
        state.observe(
            libraryPage: try XCTUnwrap(alphaSecond.value), from: "alpha", step: alphaNext)

        // Positive control: the second page is genuinely a different page, so an
        // assertion about pages not blending is not passing on an empty walk.
        XCTAssertEqual(state.memory.library?.pageNumber, 2)
        XCTAssertEqual(
            state.memory.library?.page.items.map { $0.display.id },
            ["alpha-3", "alpha-4"])
        XCTAssertEqual(requested["alpha"], [nil, "alpha-c2"])

        let betaFirst = await MemoryLibraryGateway(client: beta).fetch(step: .first)
        state.observe(
            libraryPage: try XCTUnwrap(betaFirst.value), from: "beta", step: .first)

        XCTAssertEqual(requested["beta"], [nil], "alpha's cursor must never reach beta")
        XCTAssertEqual(state.memory.library?.project, "beta")
        XCTAssertEqual(state.memory.library?.pageNumber, 1)
        XCTAssertEqual(
            state.memory.library?.page.items.map { $0.display.id }, ["beta-1"])

        let view = MemoryLibraryScreenView(
            screen: screen(.current),
            pager: state.memory.library,
            actionsEnabled: true,
            onPage: { _ in },
            onFilter: { _ in })
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(
            (find(view, "memory-library-page") as? NSTextField)?.stringValue, "Page 1")
        XCTAssertFalse(
            labels(view).joined(separator: " ").contains("alpha-"),
            "beta's screen must show none of alpha's rows")
    }

    /// The filter reaches the daemon as the repeated parameters its wire accepts,
    /// an unset filter sends nothing at all, and picking one asks for the first
    /// page of the new list rather than resuming at a cursor from the old one.
    func testLibraryFiltersReachTheWireAndRestartTheWalk() async throws {
        nonisolated(unsafe) var urls: [URLComponents] = []
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                urls.append(URLComponents(
                    url: request.url!, resolvingAgainstBaseURL: false)!)
                let body = """
                {"schemaVersion":1,"observedAt":"2026-07-30T20:00:00.000Z",
                 "sourceRevision":"r1","freshness":"live","state":"ok",
                 "items":[],"nextCursor":null,"total":0}
                """
                return (Data(body.utf8), HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })

        _ = await MemoryLibraryGateway(client: client).fetch()
        XCTAssertNil(
            urls.last?.queryItems,
            "an unset filter must send nothing: the wire reads absent as every row")

        _ = await MemoryLibraryGateway(client: client).fetch(
            step: .cursor("c2"),
            filter: MemoryLibraryFilter(
                kinds: ["pitfall"], scopes: ["repo", "global"], statuses: ["unverified"]))
        let sent = try XCTUnwrap(urls.last?.queryItems)
            .map { "\($0.name)=\($0.value ?? "")" }
        XCTAssertEqual(
            sent,
            ["cursor=c2", "kind=pitfall", "scope=global", "scope=repo",
             "status=unverified"])

        // Picking a filter in the view asks for .first, never the held cursor.
        nonisolated(unsafe) var filtered: [MemoryLibraryFilter] = []
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let view = MemoryLibraryScreenView(
            screen: screen(.current),
            pager: state.memory.library,
            actionsEnabled: true,
            onPage: { _ in XCTFail("a filter change is not a page step") },
            onFilter: { filtered.append($0) })
        view.layoutSubtreeIfNeeded()
        let kind = try XCTUnwrap(
            find(view, "memory-library-filter-kind") as? NSPopUpButton)
        XCTAssertEqual(
            kind.itemTitles,
            ["All kinds"] + MemoryLibraryFilter.kindOptions,
            "the popup offers the wire's own vocabulary")
        kind.selectItem(withTitle: "pitfall")
        ShellButtonTarget.shared.fire(kind)

        XCTAssertEqual(filtered, [MemoryLibraryFilter(kinds: ["pitfall"])])
    }

    func testLibraryPageControlsOfferOnlyStepsTheDaemonNamed() throws {
        nonisolated(unsafe) var steps: [MemoryLibraryStep] = []
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let pager = try XCTUnwrap(state.memory.library)
        let view = MemoryLibraryScreenView(
            screen: screen(.current),
            pager: pager,
            actionsEnabled: true,
            onPage: { steps.append($0) },
            onFilter: { _ in })
        view.layoutSubtreeIfNeeded()

        let previous = try XCTUnwrap(find(view, "memory-library-previous") as? NSButton)
        let next = try XCTUnwrap(find(view, "memory-library-next") as? NSButton)
        // The corpus is one page with no successor cursor, so neither control
        // may offer a page: a page number this client invented is not a page.
        XCTAssertNil(pager.nextStep)
        XCTAssertFalse(previous.isEnabled)
        XCTAssertFalse(next.isEnabled)
        previous.performClick(nil)
        next.performClick(nil)
        XCTAssertEqual(steps, [], "a disabled control must not request a page")
    }

    // MARK: Acceptance 11 — partitions, omissions, and non-mutation

    func testRecallReportsItsPartitionsOmissionsAndNonMutation() throws {
        var object = try value("memory-recall")
        object["omitted"] = 3
        object["omittedPitfalls"] = 1
        object["omittedArticles"] = 2
        object["truncated"] = true
        object["partitions"] = [
            ["class": "pitfall", "reservedTokens": 400, "usedTokens": 400,
             "kept": 4, "omitted": 1],
            ["class": "article", "reservedTokens": 400, "usedTokens": 120,
             "kept": 1, "omitted": 2],
        ]
        let view = MemoryRecallScreenView(
            screen: screen(.current),
            preview: try decode(object, as: MemoryRecallPreview.self),
            actionsEnabled: true,
            onInspect: { _ in })
        view.layoutSubtreeIfNeeded()
        let text = labels(view).joined(separator: " | ")

        XCTAssertNotNil(find(view, "memory-recall-partition-pitfall"))
        XCTAssertNotNil(find(view, "memory-recall-partition-article"))
        XCTAssertTrue(text.contains("400 of 400 reserved tokens · 4 kept · 1 omitted"))
        XCTAssertTrue(text.contains("120 of 400 reserved tokens · 1 kept · 2 omitted"))
        XCTAssertTrue(text.contains("3 rows · 1 pitfalls · 2 articles"))
        XCTAssertTrue(text.contains("truncated to fit"))
        XCTAssertTrue(text.contains("none · the wake high-water did not advance"))
    }

    /// A pitfall-heavy corpus that spends its whole pitfall reserve must still
    /// show the article partition and its own reserve, so a starved article
    /// class is visible as itself rather than as a short result list.
    func testAPitfallHeavyPreviewStillShowsTheArticleReserve() throws {
        var object = try value("memory-recall")
        object["partitions"] = [
            ["class": "pitfall", "reservedTokens": 400, "usedTokens": 400,
             "kept": 9, "omitted": 6],
            ["class": "article", "reservedTokens": 400, "usedTokens": 0,
             "kept": 0, "omitted": 0],
        ]
        object["rows"] = (1...9).map { rank in
            ["rank": rank, "class": "pitfall", "scope": "repo", "topic": "memory",
             "id": "pitfall-\(rank)", "date": "2026-07-30",
             "title": "Pitfall \(rank)", "snippet": "…", "status": "unverified",
             "flag": NSNull()]
        }
        object["omitted"] = 6
        object["omittedPitfalls"] = 6
        object["omittedArticles"] = 0
        let view = MemoryRecallScreenView(
            screen: screen(.current),
            preview: try decode(object, as: MemoryRecallPreview.self),
            actionsEnabled: true,
            onInspect: { _ in })
        view.layoutSubtreeIfNeeded()
        let text = labels(view).joined(separator: " | ")

        XCTAssertNotNil(
            find(view, "memory-recall-partition-article"),
            "the article partition must be shown even when it kept nothing")
        XCTAssertTrue(
            text.contains("0 of 400 reserved tokens · 0 kept · 0 omitted"),
            "the article reserve the pitfalls could not take must stay visible")
        XCTAssertTrue(text.contains("400 of 400 reserved tokens · 9 kept · 6 omitted"))
    }

    func testATriggerPhraseIsReportedAsReportedNeverAsExecuted() throws {
        var object = try value("memory-recall")
        object["query"] = "note this: the sweep ran twice"
        object["triggerPhrase"] = ["detected": "note", "treatedAs": "literal-query"]
        let view = MemoryRecallScreenView(
            screen: screen(.current),
            preview: try decode(object, as: MemoryRecallPreview.self),
            actionsEnabled: true,
            onInspect: { _ in })
        view.layoutSubtreeIfNeeded()

        let note = try XCTUnwrap(find(view, "memory-recall-trigger") as? NSTextField)
        XCTAssertTrue(note.stringValue.contains("treated as literal-query"))
        XCTAssertTrue(note.stringValue.contains("reported, never executed"))
    }

    // MARK: Acceptance 12 — progress, failure, and a final readback

    func testMaintenanceShowsProgressFailureAndFinalReadback() throws {
        var object = try value("memory-maintenance")
        var jobs = object["jobs"] as! [String: Any]
        var recent = jobs["recent"] as! [[String: Any]]
        recent.append([
            "id": "00000009-consolidation-apply",
            "kind": "consolidation-apply",
            "state": "failed",
            "requestedBy": "user",
            "startedAt": "2026-07-30T19:55:00.000Z",
            "finishedAt": "2026-07-30T19:55:01.000Z",
            "progress": ["step": "applying", "done": 1, "total": 4],
            "summary": "consolidation could not be applied",
            "error": "the embeddings runtime is unavailable, so nothing was applied",
            "readback": NSNull(),
        ])
        jobs["recent"] = recent
        object["jobs"] = jobs
        let view = MemoryMaintenanceScreenView(
            screen: screen(.current),
            maintenance: try decode(object, as: MemoryMaintenanceProjection.self),
            actionsEnabled: true,
            onStart: { _ in })
        view.layoutSubtreeIfNeeded()
        let text = labels(view).joined(separator: " | ")

        // The running job's unknown total stays unknown; a 0 there would claim a
        // size the daemon never reported.
        XCTAssertTrue(text.contains("rebuilding index · 0/unknown"))
        // The finished job carries the readback it ended on.
        XCTAssertTrue(text.contains("Readback · events"))
        XCTAssertTrue(text.contains("Readback · ftsRows"))
        // The failed job shows its failure verbatim and says its readback is missing.
        let failure = try XCTUnwrap(
            find(view, "memory-job-failure-00000009-consolidation-apply") as? NSTextField)
        XCTAssertEqual(
            failure.stringValue,
            "the embeddings runtime is unavailable, so nothing was applied")
        XCTAssertTrue(text.contains("none was recorded, so this job's final state is unread"))
        XCTAssertTrue(text.contains("applying · 1/4"))
    }

    // MARK: Acceptance 15 — a fault holds the value and never reads as healthy

    func testEveryFaultStateHoldsItsValueAndStillReadsAsAFault() throws {
        for availability in ProjectionAvailability.allCases where availability != .current {
            let state = try ShellFixtureStore(directory: fixtureDirectory)
                .loadState(scenario: .current)
            let overview = try XCTUnwrap(state.memory.overview)
            let faulted = screen(availability)
            let view = MemoryOverviewScreenView(screen: faulted, overview: overview)
            view.layoutSubtreeIfNeeded()
            let rendered = labels(view)
            let text = rendered.joined(separator: " | ")

            XCTAssertTrue(
                rendered.contains(faulted.stateHeadline),
                "\(availability) must still read as itself")
            XCTAssertTrue(
                text.contains(faulted.stateExplanation),
                "\(availability) must explain what it cannot show")
            XCTAssertTrue(
                identifiers(view).contains("memory-store-wiki-ok"),
                "\(availability) must keep the last observed store reading")
            XCTAssertFalse(
                rendered.contains(ProjectionAvailability.current.rawValue.capitalized),
                "\(availability) must never wear the healthy badge")
            XCTAssertFalse(
                text.contains(screen(.current).stateExplanation),
                "\(availability) must never claim the projection is current")
        }
    }

    func testAScreenWithNoObservedValueRendersNoStoreAtAll() throws {
        for view: NSView in [
            MemoryOverviewScreenView(screen: screen(.unknown), overview: nil),
            MemoryLibraryScreenView(
                screen: screen(.unknown), pager: nil,
                actionsEnabled: false, onPage: { _ in }, onFilter: { _ in }),
            MemoryRecallScreenView(
                screen: screen(.unknown), preview: nil,
                actionsEnabled: false, onInspect: { _ in }),
            MemoryMaintenanceScreenView(
                screen: screen(.unknown), maintenance: nil,
                actionsEnabled: false, onStart: { _ in }),
        ] {
            view.layoutSubtreeIfNeeded()
            let rendered = identifiers(view)
            XCTAssertFalse(
                rendered.contains { $0.hasPrefix("memory-store-") },
                "an unobserved screen must not draw a store card: \(rendered)")
            XCTAssertTrue(
                labels(view).joined(separator: " | ").contains("Unknown"),
                "an unobserved screen says so")
        }
    }

    // MARK: The topology — two records and one rebuildable projection

    /// The disposable index is one card, not two first-class stores beside the
    /// records. A projection that competes with a canonical store on the page
    /// is a claim about the architecture, and it is the wrong one.
    func testOverviewKeepsOneRebuildableProjectionBesideTwoCanonicalStores() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let view = MemoryOverviewScreenView(
            screen: screen(.current), overview: state.memory.overview)
        view.layoutSubtreeIfNeeded()
        let drawn = labels(view)

        XCTAssertEqual(
            drawn.filter { $0 == "canonical" }.count, 2,
            "the curated wiki and the episodic store are the two records")
        XCTAssertEqual(
            drawn.filter { $0 == "projection" }.count, 1,
            "FTS and vectors are one rebuildable projection, not two stores")
        let projection = try XCTUnwrap(find(view, "memory-index-projection"))
        // Merged into one card, each index still reports its own state: a badge
        // spanning a wired index and an absent one would be a third reading.
        XCTAssertNotNil(find(projection, "memory-index-fts-ok"))
        XCTAssertNotNil(find(projection, "memory-index-vectors-ok"))
    }

    func testAnAbsentIndexKeepsItsOwnStateInsideTheMergedProjectionCard() throws {
        var object = try value("memory-overview")
        var indexes = object["indexes"] as! [String: Any]
        var fts = indexes["fts"] as! [String: Any]
        fts["state"] = "absent"
        fts["articles"] = 0
        indexes["fts"] = fts
        object["indexes"] = indexes
        let view = MemoryOverviewScreenView(
            screen: screen(.current),
            overview: try decode(object, as: MemoryOverviewProjection.self))
        view.layoutSubtreeIfNeeded()
        let projection = try XCTUnwrap(find(view, "memory-index-projection"))
        let text = labels(projection).joined(separator: " | ")

        XCTAssertNotNil(
            find(projection, "memory-index-fts-absent"),
            "an absent full-text index says so in its own identifier")
        XCTAssertNotNil(find(projection, "memory-index-vectors-ok"))
        XCTAssertTrue(text.contains("no store is wired"))
        XCTAssertFalse(
            text.contains("0 articles"),
            "an absent index draws no count at all")
    }

    // MARK: Bounding is not hiding — every short list names its true total

    func testTheDenseLibraryPageBoundsItsRowsAndStillNamesTheirCount() throws {
        let state = try ShellFixtureStore(directory: denseFixtureDirectory)
            .loadState(scenario: .current)
        let pager = try XCTUnwrap(state.memory.library)
        XCTAssertEqual(pager.page.items.count, 40, "the stress corpus is the fixture doing its job")
        let view = MemoryLibraryScreenView(
            screen: screen(.current), pager: pager,
            actionsEnabled: true, onPage: { _ in }, onFilter: { _ in })
        view.layoutSubtreeIfNeeded()

        func drawnRows() -> Int {
            identifiers(view).filter { $0.hasPrefix("memory-library-row-") }.count
        }
        XCTAssertEqual(drawnRows(), 8, "the page opens on a scan, not on forty rows")
        let count = try XCTUnwrap(find(view, "memory-library-count") as? NSTextField)
        XCTAssertEqual(
            count.stringValue, "Showing 8 of 40 rows on this page.",
            "a bounded list that did not say so would read as the whole set")
        // The true total the daemon matched stays on the page beside the bound.
        XCTAssertTrue(labels(view).contains("40"), "the matching-row count stays visible")

        let expand = try XCTUnwrap(find(view, "memory-library-expand") as? NSButton)
        expand.performClick(nil)
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(drawnRows(), 40, "lifting the bound draws every row it named")
    }

    func testTheDenseRecallPreviewAndGapsListBoundThemselvesWithTheirCounts() throws {
        let state = try ShellFixtureStore(directory: denseFixtureDirectory)
            .loadState(scenario: .current)
        let recall = MemoryRecallScreenView(
            screen: screen(.current), preview: state.memory.recall,
            actionsEnabled: true, onInspect: { _ in })
        recall.layoutSubtreeIfNeeded()
        let recallCount = try XCTUnwrap(find(recall, "memory-recall-count") as? NSTextField)
        XCTAssertEqual(
            recallCount.stringValue, "Showing 6 of 40 rows inside the budget.")
        XCTAssertEqual(
            identifiers(recall).filter { $0.hasPrefix("memory-recall-row-") }.count, 6)

        let overview = MemoryOverviewScreenView(
            screen: screen(.current), overview: state.memory.overview)
        overview.layoutSubtreeIfNeeded()
        let gapCount = try XCTUnwrap(find(overview, "memory-gaps-count") as? NSTextField)
        XCTAssertEqual(gapCount.stringValue, "Showing 4 of 12 reported gaps.")
    }

    // MARK: The selected memory is the row the reader picked

    func testTheLibraryPreviewDrawsTheSelectedRowAndNamesWhatTheWireOmits() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let pager = try XCTUnwrap(state.memory.library)
        let rows = pager.page.items.map(MemoryScreenPresenter.libraryRow)
        XCTAssertGreaterThan(rows.count, 1, "the corpus must offer a second row to select")
        let view = MemoryLibraryScreenView(
            screen: screen(.current), pager: pager,
            actionsEnabled: true, onPage: { _ in }, onFilter: { _ in })
        view.layoutSubtreeIfNeeded()

        func preview() throws -> String {
            labels(try XCTUnwrap(find(view, "memory-library-selected")))
                .joined(separator: " | ")
        }
        // The pane opens populated: a "Selected memory" card showing only page
        // metadata is the screen refusing to answer its own heading.
        XCTAssertTrue(try preview().contains(rows[0].title))
        for fact in rows[0].facts {
            XCTAssertTrue(
                try preview().contains(fact.value),
                "the preview drops no field the wire sent: \(fact.label)")
        }
        XCTAssertTrue(
            try preview().contains("no body text and no per-row vector state"),
            "the two fields this wire does not send are named, not left blank")

        let second = try XCTUnwrap(find(view, "memory-library-row-\(rows[1].id)"))
        try click(second)
        view.layoutSubtreeIfNeeded()
        XCTAssertTrue(try preview().contains(rows[1].title), "a click moves the selection")
    }

    // MARK: The latest job reads apart from the receipts behind it

    func testMaintenanceSeparatesTheLatestJobFromEarlierReceipts() throws {
        let state = try ShellFixtureStore(directory: denseFixtureDirectory)
            .loadState(scenario: .current)
        let maintenance = try XCTUnwrap(state.memory.maintenance)
        XCTAssertEqual(maintenance.jobs.recent.count, 20)
        let view = MemoryMaintenanceScreenView(
            screen: screen(.current), maintenance: maintenance,
            actionsEnabled: true, onStart: { _ in })
        view.layoutSubtreeIfNeeded()

        let latest = try XCTUnwrap(find(view, "memory-store-jobs-ok"))
        let latestText = labels(latest).joined(separator: " | ")
        XCTAssertEqual(
            identifiers(latest).filter { $0.hasPrefix("memory-job-receipt-") }.count, 1,
            "the latest job is one receipt, not a list")
        // The in-progress job's honest absence survives the split.
        XCTAssertTrue(
            latestText.contains("none was recorded, so this job's final state is unread"))

        let earlier = try XCTUnwrap(find(view, "memory-jobs-earlier"))
        XCTAssertEqual(
            identifiers(earlier).filter { $0.hasPrefix("memory-job-receipt-") }.count, 2)
        let count = try XCTUnwrap(find(earlier, "memory-jobs-earlier-count") as? NSTextField)
        XCTAssertEqual(count.stringValue, "Showing 2 of 19 receipts.")
    }

    // MARK: Refresh re-reads the page on screen

    func testRefreshReReadsThePageOnScreenRatherThanRestartingTheWalk() throws {
        nonisolated(unsafe) var steps: [MemoryLibraryStep] = []
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let pager = try XCTUnwrap(state.memory.library)
        let view = MemoryLibraryScreenView(
            screen: screen(.current), pager: pager,
            actionsEnabled: true, onPage: { steps.append($0) }, onFilter: { _ in })
        view.layoutSubtreeIfNeeded()

        let refresh = try XCTUnwrap(find(view, "memory-library-refresh") as? NSButton)
        refresh.performClick(nil)
        XCTAssertEqual(steps, [pager.currentStep], "refresh re-asks for the page on screen")
    }

    // MARK: The AppKit layer reads the daemon and nothing else

    /// Acceptance 10 forbids this layer reading a memory file or database. The
    /// Memory sources are scanned for the filesystem and SQLite entry points a
    /// screen would need to do that; the positive control proves the scan can
    /// see a symbol that really is there.
    func testTheMemoryScreensReachTheDaemonAndNeverTheFilesystem() throws {
        let shell = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/HiveWorkspace/Shell")
        var scanned = 0
        for name in [
            "MemoryScreenViews.swift", "MemoryScreenPresenter.swift", "MemoryGateways.swift",
        ] {
            let source = try String(
                contentsOf: shell.appendingPathComponent(name), encoding: .utf8)
            scanned += 1
            for forbidden in [
                "FileManager", "Data(contentsOf:", "SQLite", "sqlite3",
                "contentsOfDirectory", "FileHandle", "Process(",
            ] {
                XCTAssertFalse(
                    source.contains(forbidden),
                    "\(name) must not reach past the daemon with \(forbidden)")
            }
        }
        XCTAssertEqual(scanned, 3)
        let gateways = try String(
            contentsOf: shell.appendingPathComponent("MemoryGateways.swift"),
            encoding: .utf8)
        XCTAssertTrue(
            gateways.contains("WorkspaceDaemonClient"),
            "positive control: the scan can see the daemon client that is really there")
    }
}
