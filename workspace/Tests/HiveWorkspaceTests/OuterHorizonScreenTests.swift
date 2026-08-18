// OuterHorizonScreenTests.swift
//
// Proves Live Run retains its last hierarchy for daemon refusals and unreadable
// responses (including authorization refusals), reserves disconnected for
// transport loss, and renders the frozen dense and edge fixtures through AppKit.

import AppKit
import CryptoKit
import Foundation
import XCTest
@testable import HiveWorkspace
@testable import WorkspaceCore
@testable import WorkspaceQAKit

private struct OuterHorizonScreenFixtureCorpus: Decodable {
    struct Scenario: Decodable {
        let name: String
        let snapshot: OuterHorizonSnapshot
    }

    let scenarios: [Scenario]
}

@MainActor
final class OuterHorizonScreenTests: XCTestCase {
    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    private func snapshot(_ name: String) throws -> OuterHorizonSnapshot {
        let url = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("outer-horizon-corpus.json")
        let corpus = try JSONDecoder().decode(
            OuterHorizonScreenFixtureCorpus.self,
            from: Data(contentsOf: url))
        return try XCTUnwrap(
            corpus.scenarios.first { $0.name == name }?.snapshot)
    }

    private func snapshotData(
        _ name: String,
        instanceId: String? = nil,
        seq: String? = nil
    ) throws -> Data {
        let url = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("outer-horizon-corpus.json")
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let scenarios = try XCTUnwrap(root["scenarios"] as? [[String: Any]])
        let scenario = try XCTUnwrap(
            scenarios.first { $0["name"] as? String == name })
        var raw = try XCTUnwrap(scenario["snapshot"] as? [String: Any])
        if let instanceId { raw["instanceId"] = instanceId }
        if let seq { raw["seq"] = seq }
        return try JSONSerialization.data(withJSONObject: raw)
    }

    private func duplicateIdentityFixtureData() throws -> Data {
        let url = URL(fileURLWithPath: fixtureDirectory)
            .appendingPathComponent("outer-horizon-duplicate-identity.json")
        return try Data(contentsOf: url)
    }

    private func snapshotWithCurrentDigest(_ name: String) throws -> OuterHorizonSnapshot {
        let data = try snapshotData(name)
        let status = try JSONDecoder().decode(WorkspaceStatusSnapshot.self, from: data)
        let canonical = try workspaceCanonicalJSON(status.entities)
        let digest = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        object["contentSha256"] = digest
        return try JSONDecoder().decode(
            OuterHorizonSnapshot.self,
            from: JSONSerialization.data(withJSONObject: object))
    }

    private func currentScreen(_ snapshot: OuterHorizonSnapshot) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: .current,
            freshness: .current,
            source: ProjectionSource(revision: snapshot.seq),
            observedAt: snapshot.createdAt,
            evidence: nil,
            contract: .frozen,
            facts: [ShellScreenFact(label: "Hierarchy", value: "\(snapshot.nodes.count) nodes")])
    }

    private func previousState(_ snapshot: OuterHorizonSnapshot) -> ShellState {
        var state = ShellState()
        state.apply(screen: currentScreen(snapshot), for: .liveRun)
        state.apply(outerHorizon: snapshot, warning: nil)
        return state
    }

    private func client(
        statusCode: Int,
        data: Data
    ) -> WorkspaceDaemonClient {
        WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer fixture",
            loader: { request in
                (data, HTTPURLResponse(
                    url: request.url!,
                    statusCode: statusCode,
                    httpVersion: nil,
                    headerFields: nil)!)
            })
    }

    private func makeView(_ snapshot: OuterHorizonSnapshot) -> OuterHorizonScreenView {
        OuterHorizonScreenView(
            screen: currentScreen(snapshot),
            horizon: OuterHorizonScreenState(snapshot: snapshot),
            onSelect: { _ in },
            onToggleExpansion: { _ in })
    }

    private func findView(_ root: NSView, identifier: String) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        for child in root.subviews {
            if let found = findView(child, identifier: identifier) { return found }
        }
        return nil
    }

    private func findView(_ root: NSView, accessibilityLabel: String) -> NSView? {
        if root.accessibilityLabel() == accessibilityLabel { return root }
        for child in root.subviews {
            if let found = findView(child, accessibilityLabel: accessibilityLabel) {
                return found
            }
        }
        return nil
    }

    private func allText(in root: NSView) -> [String] {
        let own = (root as? NSTextField).map { [$0.stringValue] } ?? []
        return own + root.subviews.flatMap(allText)
    }

    private func allTextFields(in root: NSView) -> [NSTextField] {
        let own = (root as? NSTextField).map { [$0] } ?? []
        return own + root.subviews.flatMap(allTextFields)
    }

    private func prefixCharacterCount(
        fitting width: CGFloat,
        from text: String,
        font: NSFont
    ) -> Int {
        var fittingCount = 0
        for count in 1 ... text.count {
            let prefix = String(text.prefix(count))
            let measuredWidth = (prefix as NSString).size(withAttributes: [.font: font]).width
            if measuredWidth > width { break }
            fittingCount = count
        }
        return fittingCount
    }

    func testInstalledWorkbenchConsumesTheRealHierarchyAndWiresItsNavigation() throws {
        let snapshot = try snapshotWithCurrentDigest("full-hive-dense-19")
        var state = previousState(snapshot)
        state.navigate(to: .liveRun)
        let controller = WorkspaceShellWindowController(
            context: .init(
                projectName: "Hive",
                projectPath: "/tmp/hive",
                instanceLabel: "rig"),
            state: state)
        controller.installLiveRunWorkbench(LiveRunWorkbenchView(terminalFactory: nil))
        let content = try XCTUnwrap(controller.window?.contentView)
        let parent = try XCTUnwrap(
            OuterHorizonScreenState(snapshot: snapshot).visibleRows.first { $0.hasChildren })

        let row = try XCTUnwrap(findView(
            content, identifier: "live-run-hierarchy-\(parent.node.nodeId)") as? NSButton)
        XCTAssertTrue(allText(in: content).contains {
            $0.hasPrefix("0 live · 19 visible / 19 admitted · topology ")
        })
        XCTAssertTrue(allText(in: content).contains("Run hierarchy · full hive"))
        XCTAssertTrue(allText(in: content).contains("NO SESSION"))

        row.performClick(nil)
        XCTAssertEqual(
            controller.currentState.outerHorizon?.navigation.selectedNodeId,
            parent.node.nodeId)

        let refreshedRow = try XCTUnwrap(findView(
            content, identifier: "live-run-hierarchy-\(parent.node.nodeId)"))
        let disclosure = try XCTUnwrap(findView(
            refreshedRow, accessibilityLabel: "Collapse hierarchy node") as? NSButton)
        disclosure.performClick(nil)
        XCTAssertFalse(
            controller.currentState.outerHorizon?.navigation.expandedNodeIds
                .contains(parent.node.nodeId) ?? true)
        XCTAssertLessThan(
            controller.currentState.outerHorizon?.visibleRows.count ?? Int.max,
            snapshot.nodes.count)
    }

    func testDenseCrewNamesRemainDistinctAtTheRealRailWidth() throws {
        let snapshot = try snapshotWithCurrentDigest("full-hive-dense-19")
        let horizon = OuterHorizonScreenState(snapshot: snapshot)
        let workbench = LiveRunWorkbenchView(terminalFactory: nil)
        workbench.applyHierarchy(
            horizon,
            screen: currentScreen(snapshot),
            onSelect: { _ in },
            onToggleExpansion: { _ in })
        workbench.frame = NSRect(x: 0, y: 0, width: 1_200, height: 900)
        workbench.layoutSubtreeIfNeeded()
        let railWidth = Theme.Metric.liveRunRailWidth
        XCTAssertEqual(railWidth, 280)
        XCTAssertEqual(
            1_200 - railWidth,
            920,
            "the wider rail costs the centre 60 points at this workbench width")

        let crew = horizon.visibleRows.filter { row in
            guard case .present(let binding) = row.node.binding else { return false }
            return binding.agentId.hasPrefix("dense-crew-")
        }
        XCTAssertEqual(crew.count, 10, "positive control: fixture has ten dense crew siblings")

        let visibleNames = try crew.map { row -> String in
            let button = try XCTUnwrap(findView(
                workbench,
                identifier: "live-run-hierarchy-\(row.node.nodeId)"))
            let name = try XCTUnwrap(allTextFields(in: button)
                .first { $0.stringValue.hasPrefix("dense-crew-") })
            let characterCount = prefixCharacterCount(
                fitting: name.frame.width,
                from: name.stringValue,
                font: try XCTUnwrap(name.font))
            XCTAssertGreaterThan(characterCount, 0)
            return String(name.stringValue.prefix(characterCount))
        }

        XCTAssertEqual(
            Set(visibleNames).count,
            crew.count,
            "the characters that fit before truncation must identify every crew row: \(visibleNames)")
    }

    func testRefusedAndInvalidWireResponsesWarnAndRetainThePriorHierarchy() async throws {
        let snapshot = try snapshot("full-hive-dense-19")
        let previous = previousState(snapshot)
        let cases: [(Int, Data, String)] = [
            (503, Data(#"{"error":"busy"}"#.utf8), "HTTP 503"),
            (200, Data(#"{"schemaVersion":3}"#.utf8), "invalid WorkspaceSnapshot v2"),
        ]

        for (statusCode, data, expectedWarning) in cases {
            let result = await OuterHorizonGateway(
                client: client(statusCode: statusCode, data: data))
                .fetch(previous: previous)

            XCTAssertEqual(result.snapshot, snapshot, "HTTP \(statusCode)")
            XCTAssertEqual(result.screen.availability, .unknown, "HTTP \(statusCode)")
            XCTAssertEqual(result.screen.source, previous.screens[.liveRun]?.source)
            XCTAssertEqual(result.screen.observedAt, previous.screens[.liveRun]?.observedAt)
            if statusCode == 503 {
                XCTAssertEqual(
                    result.screen.evidence,
                    .refused(statusCode: statusCode))
            } else {
                guard case .protocolDrift = result.screen.evidence else {
                    return XCTFail("invalid wire must retain protocol-drift evidence")
                }
            }
            XCTAssertEqual(result.warning?.severity, .warning, "HTTP \(statusCode)")
            XCTAssertTrue(result.warning?.text.contains(expectedWarning) ?? false)
            XCTAssertTrue(result.warning?.text.contains("last observed hierarchy") ?? false)
            XCTAssertTrue(result.warning?.text.contains("no transport loss is claimed") ?? false)
        }
    }

    func testThrownTransportIsDisconnectedAndStillRetainsThePriorHierarchy() async throws {
        struct SocketLost: LocalizedError {
            var errorDescription: String? { "socket closed" }
        }

        let snapshot = try snapshot("direct")
        let previous = previousState(snapshot)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer fixture",
            loader: { _ in throw SocketLost() })
        let result = await OuterHorizonGateway(client: client)
            .fetch(previous: previous)

        XCTAssertEqual(result.snapshot, snapshot)
        XCTAssertEqual(result.screen.availability, .disconnected)
        XCTAssertEqual(result.screen.source, previous.screens[.liveRun]?.source)
        XCTAssertEqual(result.screen.observedAt, previous.screens[.liveRun]?.observedAt)
        XCTAssertNil(result.warning)
        guard case .disconnected(let evidence) = result.screen.evidence else {
            return XCTFail("a thrown loader must retain disconnected evidence")
        }
        XCTAssertTrue(evidence.contains("socket closed"))
    }

    func testUnauthorizedResponseWarnsAndRetainsThePriorHierarchy() async throws {
        let snapshot = try snapshot("direct")
        let previous = previousState(snapshot)
        let result = await OuterHorizonGateway(client: client(
            statusCode: 403,
            data: Data(#"{"code":"status-read-denied"}"#.utf8)))
            .fetch(previous: previous)

        XCTAssertEqual(result.snapshot, snapshot)
        XCTAssertEqual(result.screen.availability, .unknown)
        XCTAssertEqual(result.screen.source, previous.screens[.liveRun]?.source)
        XCTAssertEqual(result.screen.observedAt, previous.screens[.liveRun]?.observedAt)
        XCTAssertEqual(
            result.screen.evidence,
            .unauthorized(refusalCode: "status-read-denied"))
        XCTAssertEqual(result.warning?.severity, .warning)
        XCTAssertTrue(result.warning?.text.contains("status-read-denied") ?? false)
        XCTAssertTrue(result.warning?.text.contains("last observed hierarchy") ?? false)
        XCTAssertTrue(result.warning?.text.contains("no transport loss is claimed") ?? false)
    }

    func testSameInstanceRegressedSequenceIsRejectedAtTheAcceptanceFence() async throws {
        let held = try snapshot("unknown-entity-kind")
        let earlier = try snapshot("direct")
        let result = await OuterHorizonGateway(client: client(
            statusCode: 200,
            data: try snapshotData(
                "direct",
                instanceId: held.instanceId,
                seq: "7")))
            .fetch(previous: previousState(earlier))
        XCTAssertEqual(result.snapshot?.seq, "7")

        var current = previousState(held)
        current.acceptOuterHorizon(
            screen: result.screen,
            snapshot: result.snapshot,
            warning: result.warning)

        XCTAssertEqual(current.outerHorizon?.snapshot, held)
        XCTAssertEqual(current.screens[.liveRun], previousState(held).screens[.liveRun])
        XCTAssertNil(current.outerHorizonWarning)
    }

    func testLowerSequenceFromANewInstanceAdoptsAndRecordsTheTransition() async throws {
        let held = try snapshot("unknown-entity-kind")
        let result = await OuterHorizonGateway(client: client(
            statusCode: 200,
            data: try snapshotData(
                "direct",
                instanceId: "instance-restarted",
                seq: "1")))
            .fetch(previous: previousState(held))
        var current = previousState(held)
        current.acceptOuterHorizon(
            screen: result.screen,
            snapshot: result.snapshot,
            warning: result.warning)

        XCTAssertEqual(current.outerHorizon?.snapshot.instanceId, "instance-restarted")
        XCTAssertEqual(current.outerHorizon?.snapshot.seq, "1")
        XCTAssertEqual(current.screens[.liveRun]?.source.revision, "1")
        XCTAssertTrue(current.screens[.liveRun]?.facts.contains(ShellScreenFact(
            label: "Instance transition",
            value: "instance-fixture → instance-restarted")) ?? false)
        XCTAssertNil(current.outerHorizonWarning)
    }

    func testRetentionStatesRenderExactlyOneTruthfulBanner() async throws {
        let snapshot = try snapshot("direct")
        let previous = previousState(snapshot)
        let cases: [(Int, Data)] = [
            (503, Data(#"{"error":"busy"}"#.utf8)),
            (403, Data(#"{"code":"status-read-denied"}"#.utf8)),
            (200, Data(#"{"schemaVersion":3}"#.utf8)),
        ]

        for (statusCode, data) in cases {
            let result = await OuterHorizonGateway(
                client: client(statusCode: statusCode, data: data))
                .fetch(previous: previous)
            var retained = previous
            retained.acceptOuterHorizon(
                screen: result.screen,
                snapshot: result.snapshot,
                warning: result.warning)
            let controller = WorkspaceShellWindowController(
                context: ShellSidebarView.Context(
                    projectName: "fixture",
                    projectPath: nil,
                    instanceLabel: "instance · fixture"),
                state: retained)
            defer { controller.close() }
            let content = try XCTUnwrap(controller.window?.contentView)
            let stack = try XCTUnwrap(
                findView(content, identifier: "shell-banners") as? NSStackView)
            let labels = stack.arrangedSubviews.compactMap {
                $0.accessibilityLabel()
            }

            XCTAssertEqual(labels, [try XCTUnwrap(result.warning?.text)])
            XCTAssertFalse(labels.joined(separator: "\n").contains("No state is shown"))
        }
    }

    func testDuplicateEntityIdentityBecomesProtocolDriftWithTheKeyNamed() async throws {
        let result = await OuterHorizonGateway(client: client(
            statusCode: 200,
            data: try duplicateIdentityFixtureData()))
            .fetch()

        XCTAssertNil(result.snapshot)
        XCTAssertEqual(result.screen.availability, .unknown)
        guard case .protocolDrift(let reason) = result.screen.evidence else {
            return XCTFail("duplicate wire identities must become protocol drift")
        }
        XCTAssertTrue(reason.contains("hierarchy-future-state:duplicate-id:-"))
        XCTAssertTrue(result.warning?.text.contains(
            "hierarchy-future-state:duplicate-id:-") ?? false)
    }

    func testFixtureStoreAttachesDenseHierarchyOnlyToStatesWithObservedValues() throws {
        for availability in ProjectionAvailability.allCases {
            let state = try ShellFixtureStore(directory: fixtureDirectory)
                .loadState(scenario: availability)
            let hasObservedValue = ![ProjectionAvailability.unknown, .unauthorized]
                .contains(availability)
            XCTAssertEqual(state.outerHorizon != nil, hasObservedValue, "\(availability)")
            if hasObservedValue {
                XCTAssertEqual(state.outerHorizon?.snapshot.nodes.count, 19)
                XCTAssertEqual(state.outerHorizon?.visibleRows.count, 19)
            }
        }
    }

    func testDenseHierarchyUsesAVirtualizedTableWithSemanticRows() throws {
        _ = NSApplication.shared
        let snapshot = try snapshot("full-hive-dense-19")
        let view = makeView(snapshot)
        let table = try XCTUnwrap(
            findView(view, identifier: "outer-horizon-hierarchy") as? NSTableView)
        XCTAssertEqual(view.numberOfRows(in: table), 19)

        let first = try XCTUnwrap(view.tableView(
            table,
            viewFor: table.tableColumns.first,
            row: 0))
        XCTAssertEqual(
            first.accessibilityIdentifier(),
            "outer-horizon-node-\(snapshot.nodes[0].nodeId)")
        guard case .present(let binding) = snapshot.nodes[0].binding else {
            return XCTFail("the first dense node must carry its agent binding")
        }
        XCTAssertTrue(first.accessibilityLabel()?.contains(binding.agentId) ?? false)
    }

    func testRoutedOuterHorizonOwnsTheSharedViewportWithoutParentScroll() throws {
        _ = NSApplication.shared
        let snapshot = try snapshot("full-hive-dense-19")
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "fixture",
                projectPath: nil,
                instanceLabel: "instance · fixture"),
            state: previousState(snapshot))
        defer { controller.close() }
        let content = try XCTUnwrap(controller.window?.contentView)
        let shared = try XCTUnwrap(
            findView(content, identifier: "shell-screen-scroll") as? NSScrollView)
        let host = try XCTUnwrap(findView(content, identifier: "shell-screen-host"))
        let horizon = try XCTUnwrap(findView(content, identifier: "outer-horizon-screen"))
        let detail = try XCTUnwrap(
            findView(content, identifier: "outer-horizon-detail-scroll") as? NSScrollView)

        controller.window?.makeKeyAndOrderFront(nil)
        for _ in 0..<11 {
            controller.window?.layoutIfNeeded()
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
        }

        XCTAssertEqual(host.bounds.height, shared.contentView.bounds.height, accuracy: 0.5)
        XCTAssertEqual(horizon.bounds.height, host.bounds.height, accuracy: 0.5)
        XCTAssertEqual(shared.contentView.bounds.minY, 0, accuracy: 0.5)
        XCTAssertEqual(detail.contentView.bounds.minY, 0, accuracy: 0.5)
    }

    func testEmptyAndUnknownSnapshotsRenderTheirExactState() throws {
        _ = NSApplication.shared
        let emptyView = makeView(try snapshot("empty"))
        let emptyTable = try XCTUnwrap(
            findView(emptyView, identifier: "outer-horizon-hierarchy") as? NSTableView)
        XCTAssertEqual(emptyView.numberOfRows(in: emptyTable), 0)
        let emptyText = allText(in: emptyView).joined(separator: "\n")
        XCTAssertTrue(emptyText.contains("observed empty"))
        XCTAssertTrue(emptyText.contains("no hierarchy nodes"))

        let unknownView = makeView(try snapshot("unknown-entity-kind"))
        XCTAssertNotNil(findView(
            unknownView,
            identifier: "outer-horizon-unknown-entity-kinds"))
        let unknownText = allText(in: unknownView).joined(separator: "\n")
        XCTAssertTrue(unknownText.contains("hierarchy-future-state"))
        XCTAssertTrue(unknownText.contains("future-state-fixture"))
    }
}
