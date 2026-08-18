// MemoryScreensTests.swift
//
// Pins the four Memory screens to the shared corpora: seven genuinely distinct
// availability rows, common envelope provenance, the absent/empty store split,
// stale value retention, unknown progress, and refusal-safe job submission.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class MemoryScreensTests: XCTestCase {
    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    private let routes: [ShellRoute] = [
        .memoryOverview, .memoryLibrary, .memoryRecallLab, .memoryMaintenance,
    ]

    private func valueData(_ corpus: String) throws -> Data {
        let url = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("\(corpus)-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: url)) as! [[String: Any]]
        let value = try XCTUnwrap(
            rows.first { $0["availability"] as? String == "current" }?["value"])
        return try JSONSerialization.data(withJSONObject: value)
    }

    private func valueObject(_ corpus: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: valueData(corpus)) as! [String: Any]
    }

    private func liveClient(
        recallStatus: Int,
        routeInspectionStatus: Int = 200,
        mismatchedRouteCategory: Bool = false,
        probeReports: Data? = nil,
        onRequest: ((URLRequest) -> Void)? = nil
    ) throws -> WorkspaceDaemonClient {
        let responses = [
            "workspace-snapshot": try valueData("workspace-snapshot-v2"),
            "routing/policy": try valueData("routing-policy"),
            "routing/inspect": try valueData("routing-inspection"),
            "model-control/snapshot": try valueData("model-control"),
            "queen-provider": try valueData("queen-provider"),
            "memory/overview": try valueData("memory-overview"),
            "memory/library": try valueData("memory-library"),
            "memory/recall-preview": try valueData("memory-recall"),
            "memory/maintenance": try valueData("memory-maintenance"),
        ]
        return WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                onRequest?(request)
                let path = request.url!.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                if path == "model-control/probe-refresh" {
                    return (try XCTUnwrap(probeReports), HTTPURLResponse(
                        url: request.url!, statusCode: 200,
                        httpVersion: nil, headerFields: nil)!)
                }
                let refusingRecall = path == "memory/recall-preview" && recallStatus != 200
                let refusingInspection =
                    path == "routing/inspect" && routeInspectionStatus != 200
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: refusingRecall
                        ? recallStatus
                        : (refusingInspection ? routeInspectionStatus : 200),
                    httpVersion: nil,
                    headerFields: nil)!
                let data: Data
                if refusingRecall {
                    data = Data(#"{"error":"recall preview unavailable"}"#.utf8)
                } else if refusingInspection {
                    data = Data(#"{"error":"routing inspection unavailable"}"#.utf8)
                } else {
                    let fixture = try XCTUnwrap(
                        responses[path], "missing fixture response for \(path)")
                    if path == "routing/inspect" {
                        var object = try JSONSerialization.jsonObject(
                            with: fixture) as! [String: Any]
                        let requested = URLComponents(
                            url: request.url!, resolvingAgainstBaseURL: false)?
                            .queryItems?.first { $0.name == "category" }?.value
                        let category: String
                        if mismatchedRouteCategory {
                            category = "unexpected_category"
                        } else {
                            category = try XCTUnwrap(requested)
                        }
                        object["category"] = category
                        object["scope"] = category
                        data = try JSONSerialization.data(withJSONObject: object)
                    } else {
                        data = fixture
                    }
                }
                return (data, response)
            })
    }

    func testProviderProbeActionPostsBeforeRereadingTheScreen() async throws {
        var requests: [(method: String, path: String)] = []
        let reports = Data(
            #"[{"provider":"grok","status":"ok","pools":1,"observedAt":"2026-08-15T15:55:01.000Z","startedAt":"2026-08-15T15:55:00.000Z","completedAt":"2026-08-15T15:55:02.000Z","delivery":"started"}]"#.utf8)
        let client = try liveClient(
            recallStatus: 200,
            probeReports: reports,
            onRequest: { requests.append(($0.httpMethod ?? "", $0.url!.path)) })
        let store = ShellLiveStore(config: LaunchConfig())

        let initial = await store.loadState(client: client)
        XCTAssertFalse(requests.contains {
            $0.method == "POST" && $0.path == "/model-control/probe-refresh"
        })
        XCTAssertTrue(requests.contains { $0.path == "/model-control/snapshot" })

        requests.removeAll()
        let refreshed = try await store.refreshProviderProbes(
            client: client, previous: initial)
        XCTAssertEqual(requests.first?.method, "POST")
        XCTAssertEqual(requests.first?.path, "/model-control/probe-refresh")
        XCTAssertTrue(requests.dropFirst().contains {
            $0.method == "GET" && $0.path == "/model-control/snapshot"
        })
        XCTAssertNil(refreshed.failureSummary)
        XCTAssertEqual(
            refreshed.successSummary,
            "Provider probes completed at 2026-08-15T15:55:01.000Z: grok.")
    }

    func testUnavailableProviderProbeCarriesItsReasonAfterTheReread() async throws {
        let reports = Data(
            #"[{"provider":"grok","status":"unavailable","pools":0,"reason":"fake Grok surface refused the probe","observedAt":null,"startedAt":"2026-08-15T15:55:00.000Z","completedAt":"2026-08-15T15:55:02.000Z","delivery":"started"}]"#.utf8)
        let store = ShellLiveStore(config: LaunchConfig())
        let result = try await store.refreshProviderProbes(
            client: try liveClient(recallStatus: 200, probeReports: reports))

        XCTAssertEqual(
            result.failureSummary,
            "grok at 2026-08-15T15:55:02.000Z: fake Grok surface refused the probe")
        XCTAssertNotNil(result.state.modelControl)
    }

    func testRateLimitedProviderProbeNamesTheBoundAndRetryTime() async throws {
        let reports = Data(
            #"[{"provider":"grok","status":"rate-limited","pools":0,"reason":"operator probes are limited to one vendor call every 5 seconds","completedAt":"2026-08-15T15:55:01.000Z","retryAt":"2026-08-15T15:55:05.000Z","delivery":"rate-limited"}]"#.utf8)
        let result = try await ShellLiveStore(config: LaunchConfig())
            .refreshProviderProbes(
                client: try liveClient(recallStatus: 200, probeReports: reports))

        XCTAssertEqual(
            result.failureSummary,
            "grok: operator probes are limited to one vendor call every 5 seconds; "
                + "retry at 2026-08-15T15:55:05.000Z")
    }

    func testEmptyProviderProbeReportIsNotPresentedAsARefresh() async throws {
        let result = try await ShellLiveStore(config: LaunchConfig())
            .refreshProviderProbes(
                client: try liveClient(
                    recallStatus: 200,
                    probeReports: Data("[]".utf8)))

        XCTAssertEqual(
            result.failureSummary,
            "The daemon returned no provider probe results.")
    }

    func testEveryMemoryScreenUsesSevenDistinctFixtureStates() throws {
        for route in routes {
            var signatures = Set<String>()
            for availability in ProjectionAvailability.allCases {
                let state = try ShellFixtureStore(directory: fixtureDirectory)
                    .loadState(scenario: availability)
                let screen = try XCTUnwrap(state.screens[route])
                XCTAssertEqual(screen.availability, availability)
                signatures.insert(
                    "\(screen.freshness)|\(screen.source)|\(String(describing: screen.observedAt))|"
                        + "\(String(describing: screen.evidence))|\(screen.facts)")
            }
            XCTAssertEqual(
                signatures.count,
                ProjectionAvailability.allCases.count,
                "\(route) must carry seven distinct evidence rows, not relabel one row")
        }
    }

    func testLiveLaunchSurvivesARefusingRecallEndpointWithOtherScreensLive() async throws {
        let state = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(recallStatus: 500))

        XCTAssertEqual(state.screens[.memoryRecallLab]?.availability, .unknown)
        XCTAssertTrue(state.screens[.memoryRecallLab]?.facts.contains {
            $0.label == "Recall read refused" && $0.value.contains("HTTP 500")
        } ?? false)
        for route in [
            ShellRoute.taskRouter, .modelsQuota, .memoryOverview,
            .memoryLibrary, .memoryMaintenance,
        ] {
            XCTAssertTrue(
                [.current, .stale].contains(state.screens[route]?.availability),
                "\(route) must retain its daemon value")
        }
        let inspector = try XCTUnwrap(state.inspector)
        XCTAssertEqual(inspector.availability, .current)
        guard case .present(let inspections) = inspector.task.routeInspections else {
            return XCTFail("live routing inspection must reach the inspector")
        }
        XCTAssertTrue(inspections.contains {
            $0.label == "standard_coding" && $0.value.contains("policy r6")
        })
    }

    func testRoutingInspectionMustAnswerTheRequestedCategory() async throws {
        let state = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(
                recallStatus: 200,
                mismatchedRouteCategory: true))

        let inspector = try XCTUnwrap(state.inspector)
        XCTAssertTrue(inspector.routeInspectionReadFailed)
        guard case .present(let inspections) = inspector.task.routeInspections else {
            return XCTFail("category mismatches must render as invalid reads")
        }
        let categoryCount = try XCTUnwrap(state.modelControlView)
            .routing.categories.count
        XCTAssertEqual(
            inspections.filter { $0.value.contains("received unexpected_category") }.count,
            categoryCount)
        XCTAssertEqual(
            inspector.banners.filter { $0.text.contains("requested") }.count,
            categoryCount)
    }

    func testRoutingInspectionRefusalPreservesInspectorAndTaskRouterFacts() async throws {
        var state = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(recallStatus: 200))
        let prior = try XCTUnwrap(state.inspector)
        let priorRouterCandidates = try XCTUnwrap(state.screens[.taskRouter])
            .facts.filter { $0.label == "Candidate" }
        XCTAssertFalse(
            priorRouterCandidates.isEmpty,
            "the positive control must observe route candidate facts")
        let refused = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(
                recallStatus: 200,
                routeInspectionStatus: 503))
        WorkspaceShellDelegate.applyLiveRefresh(refused, to: &state)

        let inspector = try XCTUnwrap(state.inspector)
        XCTAssertEqual(inspector.task.routeInspections, prior.task.routeInspections)
        XCTAssertEqual(inspector.availability, prior.availability)
        XCTAssertTrue(inspector.routeInspectionReadFailed)
        XCTAssertTrue(inspector.banners.contains {
            $0.severity == .warning
                && $0.text.contains("routing inspection unavailable")
        })
        XCTAssertFalse(inspector.banners.contains { $0.text.contains("disconnected") })
        XCTAssertEqual(
            state.screens[.taskRouter]?.facts.filter { $0.label == "Candidate" },
            priorRouterCandidates)
        for route in [ShellRoute.taskRouter, .modelsQuota, .memoryOverview] {
            XCTAssertTrue(
                [.current, .stale].contains(refused.screens[route]?.availability),
                "\(route) must keep its independent daemon projection")
        }
    }

    func testLiveRefreshRecallRefusalStaysOnRecallScreen() async throws {
        var current = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(recallStatus: 200))
        let priorRecall = try XCTUnwrap(current.screens[.memoryRecallLab])
        let refreshed = await ShellLiveStore(config: LaunchConfig())
            .loadState(client: try liveClient(recallStatus: 404))
        for (route, screen) in refreshed.screens {
            current.apply(
                screen: MemoryScreenPresenter.retainingValue(
                    from: current.screens[route], on: screen),
                for: route)
        }

        let recall = try XCTUnwrap(current.screens[.memoryRecallLab])
        XCTAssertEqual(recall.availability, priorRecall.availability)
        XCTAssertEqual(recall.source, priorRecall.source)
        XCTAssertEqual(recall.observedAt, priorRecall.observedAt)
        for fact in priorRecall.facts {
            XCTAssertTrue(recall.facts.contains(fact), "prior recall fact was replaced")
        }
        XCTAssertTrue(recall.facts.contains {
            $0.label == "Recall read refused" && $0.value.contains("HTTP 404")
        })
        XCTAssertTrue(
            [.current, .stale].contains(current.screens[.modelsQuota]?.availability))
        XCTAssertNil(current.screens[.modelsQuota]?.facts.first {
            $0.value.contains("recall preview unavailable")
        })
    }

    func testEveryMemoryScreenRendersCommonEnvelopeProvenanceAndFreshness() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        for route in routes {
            let facts = try XCTUnwrap(state.screens[route]).facts
            XCTAssertNotNil(facts.first { $0.label == "Projection provenance" }, "\(route)")
            XCTAssertEqual(
                facts.first { $0.label == "Daemon observed" }?.value,
                "2026-07-30T20:00:00.000Z",
                "\(route)")
            XCTAssertEqual(
                facts.first { $0.label == "Daemon freshness" }?.value,
                "live",
                "\(route)")
        }
    }

    func testLibraryAbsentAndEmptyCannotCollapseToOneRendering() throws {
        let file = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("memory-library-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: file)) as! [[String: Any]]
        let current = try XCTUnwrap(rows.first { $0["availability"] as? String == "current" })

        func presentedStore(_ state: String) throws -> String {
            var row = current
            var value = row["value"] as! [String: Any]
            value["state"] = state
            value["items"] = []
            value["total"] = 0
            row["value"] = value
            let data = try JSONSerialization.data(withJSONObject: row)
            let projection = try JSONDecoder().decode(
                ClientProjection<MemoryLibraryProjection>.self, from: data)
            return try XCTUnwrap(
                MemoryScreenPresenter.library(projection).facts
                    .first { $0.label == "Library store" }?.value)
        }

        let absent = try presentedStore("absent")
        let empty = try presentedStore("empty")
        XCTAssertNotEqual(absent, empty)
        XCTAssertTrue(absent.contains("no store is wired"))
        XCTAssertTrue(empty.contains("store exists with no rows"))
    }

    func testLibraryDecodesEveryDiscriminatedRowKind() throws {
        let file = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("memory-library-corpus.json")
        let rows = try JSONDecoder().decode(
            [ClientProjection<MemoryLibraryProjection>].self,
            from: Data(contentsOf: file))
        let items = try XCTUnwrap(
            rows.first { $0.availability == .current }?.value?.items)
        let kinds = Set(items.map { $0.display.kind })
        XCTAssertEqual(kinds, ["article", "pitfall", "fact", "digest", "raw-ref"])
        let roundTrip = try JSONDecoder().decode(
            [MemoryLibraryItem].self,
            from: JSONEncoder().encode(items))
        XCTAssertEqual(roundTrip, items)
    }

    func testLibraryRejectsSchemaForbiddenFactsForEveryRowVariant() throws {
        let file = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("memory-library-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: file)) as! [[String: Any]]
        let current = try XCTUnwrap(
            rows.first { $0["availability"] as? String == "current" })
        let value = try XCTUnwrap(current["value"] as? [String: Any])
        let items = try XCTUnwrap(value["items"] as? [[String: Any]])
        let forbidden: [String: (inout [String: Any]) -> Void] = [
            "article": { $0["scope"] = "project" },
            "pitfall": { $0["source"] = "digest compiler" },
            "fact": { $0["scope"] = "repo" },
            "digest": { $0["status"] = "current" },
            "raw-ref": { $0["status"] = "compiled" },
        ]
        for (kind, mutate) in forbidden {
            var item = try XCTUnwrap(items.first { $0["kind"] as? String == kind })
            mutate(&item)
            let data = try JSONSerialization.data(withJSONObject: item)
            XCTAssertThrowsError(
                try JSONDecoder().decode(MemoryLibraryItem.self, from: data),
                "\(kind) accepted a fact its daemon schema forbids")
        }
    }

    func testMemoryProjectionLiteralsRejectSchemaDrift() throws {
        func rejects<Value: Decodable>(
            _ corpus: String,
            as type: Value.Type,
            mutate: (inout [String: Any]) -> Void
        ) throws {
            var value = try valueObject(corpus)
            mutate(&value)
            let data = try JSONSerialization.data(withJSONObject: value)
            XCTAssertThrowsError(try JSONDecoder().decode(type, from: data), corpus)
        }

        try rejects("memory-overview", as: MemoryOverviewProjection.self) {
            $0["schemaVersion"] = 2
        }
        try rejects("memory-library", as: MemoryLibraryProjection.self) {
            $0["schemaVersion"] = 2
        }
        try rejects("memory-recall", as: MemoryRecallPreview.self) {
            $0["schemaVersion"] = 2
        }
        try rejects("memory-maintenance", as: MemoryMaintenanceProjection.self) {
            $0["schemaVersion"] = 2
        }
        try rejects("memory-overview", as: MemoryOverviewProjection.self) {
            var wiki = $0["wiki"] as! [String: Any]
            var scopes = wiki["scopes"] as! [[String: Any]]
            scopes[0]["scope"] = "project"
            wiki["scopes"] = scopes
            $0["wiki"] = wiki
        }
        try rejects("memory-maintenance", as: MemoryMaintenanceProjection.self) {
            var indexes = $0["indexes"] as! [String: Any]
            var vectors = indexes["vectors"] as! [String: Any]
            vectors["provider"] = "unknown-provider"
            indexes["vectors"] = vectors
            $0["indexes"] = indexes
        }
        try rejects("memory-maintenance", as: MemoryMaintenanceProjection.self) {
            var jobs = $0["jobs"] as! [String: Any]
            var recent = jobs["recent"] as! [[String: Any]]
            recent[0]["state"] = "queued"
            jobs["recent"] = recent
            $0["jobs"] = jobs
        }
        for mutate in [
            { (value: inout [String: Any]) in value["purpose"] = "other" },
            { (value: inout [String: Any]) in value["mutation"] = "write" },
            { (value: inout [String: Any]) in value["highWaterAdvanced"] = true },
            { (value: inout [String: Any]) in
                var partitions = value["partitions"] as! [[String: Any]]
                partitions[0]["class"] = "fact"
                value["partitions"] = partitions
            },
            { (value: inout [String: Any]) in
                value["triggerPhrase"] = [
                    "detected": "recall", "treatedAs": "executed",
                ]
            },
        ] {
            try rejects("memory-recall", as: MemoryRecallPreview.self, mutate: mutate)
        }
    }

    func testCachedEnvelopeIsStaleEvenWhenItsTimestampIsRecent() async throws {
        let file = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("memory-library-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: file)) as! [[String: Any]]
        var value = try XCTUnwrap(
            rows.first { $0["availability"] as? String == "current" }?["value"]
                as? [String: Any])
        value["observedAt"] = "2026-07-31T08:00:00.000Z"
        value["freshness"] = "cached"
        let data = try JSONSerialization.data(withJSONObject: value)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!
                return (data, response)
            })

        let projection = await MemoryLibraryGateway(client: client).fetch()
        XCTAssertEqual(projection.availability, .stale)
        XCTAssertEqual(projection.freshness, .stale)
        XCTAssertEqual(projection.observedAt, "2026-07-31T08:00:00.000Z")
        XCTAssertEqual(projection.value?.freshness, .cached)
    }

    func testRecallGatewayDoesNotReclassifyLiveEvidenceByClientClock() async throws {
        var value = try valueObject("memory-recall")
        value["observedAt"] = "2026-07-31T08:00:00.000Z"
        value["freshness"] = "live"
        let data = try JSONSerialization.data(withJSONObject: value)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!
                return (data, response)
            })
        let freshNow = try XCTUnwrap(
            WireDate.parseISO("2026-07-31T08:04:59.000Z"))
        let staleNow = try XCTUnwrap(
            WireDate.parseISO("2026-07-31T08:05:01.000Z"))
        let boundaryNow = try XCTUnwrap(
            WireDate.parseISO("2026-07-31T08:05:00.000Z"))

        let fresh = try await MemoryRecallGateway(client: client, now: { freshNow })
            .fetch(MemoryRecallRequest(query: "memory"))
        let boundary = try await MemoryRecallGateway(client: client, now: { boundaryNow })
            .fetch(MemoryRecallRequest(query: "memory"))
        let stale = try await MemoryRecallGateway(client: client, now: { staleNow })
            .fetch(MemoryRecallRequest(query: "memory"))
        XCTAssertEqual(fresh.availability, .current)
        XCTAssertEqual(boundary.availability, .current)
        XCTAssertEqual(stale.availability, .current)
    }

    /// A refusal that names its code under "reason" must read identically on
    /// the recall path and the read path: both go through the one RefusalBody
    /// decoder. When the recall path ranked keys differently, this same body
    /// parsed as its fallback instead of the daemon's actual code.
    func testRecallUnauthorizedReadsTheReasonKeyLikeTheReadPath() async throws {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 403,
                    httpVersion: nil, headerFields: nil)!
                return (Data(#"{"reason":"recall-quota-exhausted"}"#.utf8), response)
            })

        let projection = try await MemoryRecallGateway(client: client)
            .fetch(MemoryRecallRequest(query: "memory"))
        XCTAssertEqual(projection.availability, .unauthorized)
        XCTAssertEqual(
            projection.evidence,
            .unauthorized(refusalCode: "recall-quota-exhausted"))
    }

    func testStaleMemoryScreensKeepValuesAndAssertTheirTimestamp() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .stale)
        for route in routes {
            let screen = try XCTUnwrap(state.screens[route])
            XCTAssertEqual(screen.observedAt, "2026-07-29T20:00:00.000Z", "\(route)")
            XCTAssertFalse(screen.facts.isEmpty, "\(route) must retain its observed value")
            XCTAssertEqual(
                screen.facts.first { $0.label == "Daemon observed" }?.value,
                "2026-07-29T20:00:00.000Z",
                "\(route)")
        }
    }

    func testUnknownNeverRendersAsZeroAndUnknownJobTotalStaysUnknown() throws {
        let unknown = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .unknown)
        for route in routes {
            XCTAssertEqual(unknown.screens[route]?.facts, [], "\(route)")
        }
        let current = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let jobs = try XCTUnwrap(current.screens[.memoryMaintenance])
        XCTAssertTrue(jobs.facts.contains { $0.value.contains("0/unknown") })
    }

    func testDisconnectedLiveRefreshRetainsTheLastValueAndTimestamp() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let previous = try XCTUnwrap(state.screens[.memoryRecallLab])
        let failure = ShellScreenProjection(
            availability: .disconnected,
            freshness: .unknown,
            source: ProjectionSource(),
            observedAt: nil,
            evidence: .disconnected(transportLostAt: "socket closed"),
            contract: .frozen,
            facts: [])
        let retained = MemoryScreenPresenter.retainingValue(
            from: previous, on: failure)

        XCTAssertEqual(retained.availability, .disconnected)
        XCTAssertEqual(retained.freshness, .stale)
        XCTAssertEqual(retained.source, previous.source)
        XCTAssertEqual(retained.observedAt, previous.observedAt)
        XCTAssertEqual(retained.facts, previous.facts)
        XCTAssertEqual(retained.evidence, failure.evidence)
    }

    func testMemoryJobRefusalLeavesProjectionUntouchedAndSkipsReadback() async throws {
        nonisolated(unsafe) var requests: [URLRequest] = []
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                requests.append(request)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 503,
                    httpVersion: nil, headerFields: nil)!
                return (Data(#"{"error":"receipt store unavailable"}"#.utf8), response)
            })
        do {
            _ = try await MemoryMaintenanceGateway(client: client)
                .submit(MemoryJobRequest(kind: .reindex))
            XCTFail("the refused job must not resolve as accepted")
        } catch MemoryMaintenanceGateway.GatewayError.refused(let status, let detail) {
            XCTAssertEqual(status, 503)
            XCTAssertEqual(detail, "receipt store unavailable")
        }
        XCTAssertEqual(requests.count, 1, "a refusal must not replace state with a readback")
        XCTAssertEqual(requests.first?.httpMethod, "POST")
    }

    func testAcceptedMemoryJobReturnsReceiptAndClassifiedReadback() async throws {
        let file = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("memory-maintenance-corpus.json")
        let rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: file)) as! [[String: Any]]
        var value = try XCTUnwrap(
            rows.first { $0["availability"] as? String == "current" }?["value"]
                as? [String: Any])
        value["observedAt"] = "2026-07-31T08:00:00.000Z"
        value["freshness"] = "cached"
        let jobs = try XCTUnwrap(value["jobs"] as? [String: Any])
        let recent = try XCTUnwrap(jobs["recent"] as? [[String: Any]])
        let receipt = try XCTUnwrap(recent.first)
        let readbackData = try JSONSerialization.data(withJSONObject: value)
        let receiptData = try JSONSerialization.data(withJSONObject: receipt)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:1")!,
            authorization: "Bearer fixture",
            loader: { request in
                let posting = request.httpMethod == "POST"
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: posting ? 202 : 200,
                    httpVersion: nil, headerFields: nil)!
                return (posting ? receiptData : readbackData, response)
            })

        let result = try await MemoryMaintenanceGateway(client: client)
            .submit(MemoryJobRequest(kind: .reindex))
        XCTAssertEqual(result.receipt.id, receipt["id"] as? String)
        XCTAssertEqual(result.readBack.availability, .stale)
        XCTAssertEqual(result.readBack.value?.freshness, .cached)
    }
}
