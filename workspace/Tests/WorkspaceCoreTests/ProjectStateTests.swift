import XCTest
import CoreGraphics
@testable import WorkspaceCore

final class ProjectStateTests: XCTestCase {

    func drivenState() -> (ProjectState, ProjectState) {
        let hive = ProjectState(projectID: FixtureScript.hiveProject, displayName: "hive")
        let docs = ProjectState(projectID: FixtureScript.docsProject, displayName: "docs-site")
        let source = MockEventSource(script: FixtureScript.standard())
        source.fastForward { envelope in
            switch envelope.projectID {
            case FixtureScript.hiveProject: hive.apply(envelope)
            case FixtureScript.docsProject: docs.apply(envelope)
            default: XCTFail("unknown project \(envelope.projectID)")
            }
        }
        return (hive, docs)
    }

    func testFixtureScriptBuildsBothProjects() {
        let (hive, docs) = drivenState()
        XCTAssertEqual(Set(hive.panes.keys),
                       Set(["orchestrator", "indexer", "styler", "migrator", "flaky-e2e"].map { PaneID($0) }))
        XCTAssertEqual(Set(docs.panes.keys), Set(["orchestrator", "api-docs"].map { PaneID($0) }))
        XCTAssertEqual(hive.layout.master, "orchestrator", "orchestrator is the default master")
        XCTAssertEqual(hive.orchestratorPane, "orchestrator")
    }

    func testFixtureProducesEveryStatusColor() {
        let (hive, _) = drivenState()
        XCTAssertEqual(hive.panes[PaneID("migrator")]?.status, .waiting(.approval), "amber")
        XCTAssertEqual(hive.panes[PaneID("styler")]?.status, .completed(acknowledged: false), "green")
        XCTAssertEqual(hive.panes[PaneID("flaky-e2e")]?.status, .failed(acknowledged: false), "red")
        if case .disconnected? = hive.panes[PaneID("indexer")]?.status {} else {
            XCTFail("indexer should be disconnected (gray dashed)")
        }
        XCTAssertEqual(hive.panes[PaneID("orchestrator")]?.status, .running, "blue")
    }

    func testAttentionOrderedBySeverityNotPanePosition() {
        let (hive, _) = drivenState()
        let ordered = hive.attention.ordered
        XCTAssertFalse(ordered.isEmpty)
        XCTAssertEqual(ordered.first?.severity, .failed, "failure outranks everything")
        // severities never increase as we walk the queue
        let severities = ordered.map(\.severity.rawValue)
        XCTAssertEqual(severities, severities.sorted(by: >))
    }

    func testFocusAloneNeverClearsAttentionOrApproves() {
        let (hive, _) = drivenState()
        let before = hive.attention.ordered
        hive.apply(.focusPane("migrator"))
        hive.apply(.moveFocus(.left))
        hive.apply(.focusOrchestrator)
        XCTAssertEqual(hive.attention.ordered, before, "focus commands must not touch the queue")
        XCTAssertEqual(hive.panes[PaneID("migrator")]?.status, .waiting(.approval))
        guard case .approval(let item)? = hive.panes[PaneID("migrator")]?.transcript.item(id: "appr-schema-migration") else {
            return XCTFail()
        }
        XCTAssertEqual(item.state, .pending, "focus must not approve")
    }

    func testExplicitApprovalResolvesStatusAndAttention() {
        let (hive, _) = drivenState()
        let changes = hive.apply(.resolveApproval(approvalID: "appr-schema-migration", approved: true))
        XCTAssertFalse(changes.isEmpty)
        XCTAssertEqual(hive.panes[PaneID("migrator")]?.status, .running)
        XCTAssertNil(hive.attention.ordered.first { $0.id == "appr-schema-migration" })
        // Second resolution is a no-op (one-shot).
        XCTAssertTrue(hive.apply(.resolveApproval(approvalID: "appr-schema-migration", approved: false)).isEmpty)
    }

    func testAcknowledgeClearsCompletedAndItsAttention() {
        let (hive, _) = drivenState()
        hive.apply(.acknowledgePane("styler"))
        XCTAssertEqual(hive.panes[PaneID("styler")]?.status, .completed(acknowledged: true))
        XCTAssertNil(hive.attention.ordered.first { $0.paneID == PaneID("styler") })
    }

    func testPromoteAndReturnOrchestrator() {
        let (hive, _) = drivenState()
        let originalLayout = hive.layout
        hive.apply(.promotePane("migrator"))
        XCTAssertEqual(hive.layout.master, "migrator")
        hive.apply(.returnOrchestratorToMaster)
        XCTAssertEqual(hive.layout.master, "orchestrator")
        XCTAssertEqual(hive.layout, originalLayout, "satellite order preserved through the round trip")
    }

    func testPaneCreationNeverStealsFocus() {
        let hive = ProjectState(projectID: "hive", displayName: "hive")
        let source = MockEventSource(script: FixtureScript.standard())
        var focusChanges: [PaneID?] = []
        source.fastForward { envelope in
            guard envelope.projectID == hive.projectID else { return }
            for change in hive.apply(envelope) {
                if case .focusChanged(let pane) = change { focusChanges.append(pane) }
            }
        }
        XCTAssertEqual(focusChanges, [PaneID("orchestrator")],
                       "only the very first pane of an empty workspace takes focus")
    }

    func testClosePaneReturnsFocusToMasterAndClearsItsAttention() {
        let (hive, _) = drivenState()
        hive.apply(.focusPane("flaky-e2e"))
        hive.apply(.closePane("flaky-e2e"))
        XCTAssertNil(hive.panes[PaneID("flaky-e2e")])
        XCTAssertEqual(hive.focusedPane, hive.layout.master)
        XCTAssertNil(hive.attention.ordered.first { $0.paneID == PaneID("flaky-e2e") })
    }

    func testSwitcherCardIsSanitized() {
        let (hive, _) = drivenState()
        let card = hive.switcherCard
        XCTAssertEqual(card.displayName, "hive")
        XCTAssertEqual(card.paneCount, 5)
        XCTAssertEqual(card.failedCount, 1)
        XCTAssertGreaterThanOrEqual(card.waitingCount, 1)
        // Card carries counts and names only — the type has no transcript field.
    }

    func testEventsForUnknownPaneAreDroppedSafely() {
        let hive = ProjectState(projectID: "hive", displayName: "hive")
        let envelope = AgentEventEnvelope(
            projectID: "hive", paneID: "ghost", sequence: 1, timestamp: nil,
            payload: .toolOutput(callID: "x", chunk: "y", isANSI: false))
        XCTAssertTrue(hive.apply(envelope).isEmpty)
        XCTAssertTrue(hive.panes.isEmpty)
    }
}
