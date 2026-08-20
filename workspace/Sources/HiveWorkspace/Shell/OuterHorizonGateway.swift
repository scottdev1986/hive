// OuterHorizonGateway.swift Reads the authenticated WorkspaceSnapshot v2 projection for Live Run and applies this screen's retention rule. A daemon answer that refuses the read or fails the frozen decoder cannot erase the last observed hierarchy; transport loss remains the shared disconnected classification.

import Foundation
import WorkspaceCore

struct OuterHorizonGateway {
    struct Result: Equatable {
        let screen: ShellScreenProjection
        let snapshot: OuterHorizonSnapshot?
        let warning: ShellBanner?
    }

    static let read = WorkspaceReadEndpoint<OuterHorizonSnapshot>(
        path: "workspace-snapshot",
        source: { ProjectionSource(revision: $0.seq) },
        observedAt: { $0.createdAt })

    let client: WorkspaceDaemonClient

    func fetch(previous: ShellState? = nil) async -> Result {
        Self.resolve(
            await client.fetch(Self.read),
            previousScreen: previous?.screens[.liveRun],
            previousSnapshot: previous?.outerHorizon?.snapshot)
    }

    static func resolve(
        _ projection: ClientProjection<OuterHorizonSnapshot>,
        previousScreen: ShellScreenProjection?,
        previousSnapshot: OuterHorizonSnapshot?
    ) -> Result {
        switch projection.evidence {
        case .refused(let statusCode):
            return retainedRefusal(
                previousScreen: previousScreen,
                previousSnapshot: previousSnapshot,
                evidence: .refused(statusCode: statusCode),
                text: "The daemon refused the Live Run hierarchy read "
                    + "(HTTP \(statusCode)).")
        case .unauthorized(let refusalCode):
            return retainedRefusal(
                previousScreen: previousScreen,
                previousSnapshot: previousSnapshot,
                evidence: .unauthorized(refusalCode: refusalCode),
                text: "The daemon refused the Live Run hierarchy read "
                    + "(\(refusalCode)).")
        case .protocolDrift(let reason):
            return retainedRefusal(
                previousScreen: previousScreen,
                previousSnapshot: previousSnapshot,
                evidence: .protocolDrift(reason: reason),
                text: "The daemon answered the Live Run hierarchy read with "
                    + "an invalid WorkspaceSnapshot v2 (\(reason)).")
        case .disconnected:
            guard let previousScreen, let previousSnapshot else {
                return Result(
                    screen: projection.frozenScreen(),
                    snapshot: nil,
                    warning: nil)
            }
            return Result(
                screen: ShellScreenProjection(
                    availability: .disconnected,
                    freshness: .unknown,
                    source: previousScreen.source,
                    observedAt: previousScreen.observedAt,
                    evidence: projection.evidence,
                    contract: .frozen,
                    facts: previousScreen.facts),
                snapshot: previousSnapshot,
                warning: nil)
        case nil:
            return accepted(
                projection,
                previousScreen: previousScreen,
                previousSnapshot: previousSnapshot)
        case .conflicting, .replaced:
            return Result(
                screen: projection.frozenScreen(
                    facts: projection.value.map(facts) ?? []),
                snapshot: projection.value,
                warning: nil)
        }
    }

    private static func accepted(
        _ projection: ClientProjection<OuterHorizonSnapshot>,
        previousScreen: ShellScreenProjection?,
        previousSnapshot: OuterHorizonSnapshot?
    ) -> Result {
        guard let snapshot = projection.value else {
            return Result(
                screen: projection.frozenScreen(),
                snapshot: nil,
                warning: nil)
        }
        if let held = previousSnapshot,
           held.instanceId == snapshot.instanceId,
           let heldSeq = UInt64(held.seq),
           let incomingSeq = UInt64(snapshot.seq),
           incomingSeq <= heldSeq {
            return Result(
                screen: previousScreen ?? ShellScreenProjection(
                    availability: .current,
                    freshness: .current,
                    source: ProjectionSource(revision: held.seq),
                    observedAt: held.createdAt,
                    evidence: nil,
                    contract: .frozen,
                    facts: facts(held)),
                snapshot: held,
                warning: nil)
        }

        var acceptedFacts = facts(snapshot)
        if let held = previousSnapshot,
           held.instanceId != snapshot.instanceId {
            acceptedFacts.append(ShellScreenFact(
                label: "Instance transition",
                value: "\(held.instanceId) → \(snapshot.instanceId)"))
        }
        return Result(
            screen: projection.frozenScreen(facts: acceptedFacts),
            snapshot: snapshot,
            warning: nil)
    }

    private static func retainedRefusal(
        previousScreen: ShellScreenProjection?,
        previousSnapshot: OuterHorizonSnapshot?,
        evidence: ProjectionEvidence,
        text: String
    ) -> Result {
        guard let previousScreen, let previousSnapshot else {
            return Result(
                screen: ShellScreenProjection(
                    availability: .unknown,
                    freshness: .unknown,
                    source: ProjectionSource(),
                    observedAt: nil,
                    evidence: evidence,
                    contract: .frozen,
                    facts: []),
                snapshot: nil,
                warning: ShellBanner(
                    identifier: "shell-banner-outer-horizon-refusal",
                    severity: .warning,
                    text: text + " No hierarchy is shown; no transport loss is claimed."))
        }
        return Result(
            screen: ShellScreenProjection(
                availability: .unknown,
                freshness: .unknown,
                source: previousScreen.source,
                observedAt: previousScreen.observedAt,
                evidence: evidence,
                contract: previousScreen.contract,
                facts: previousScreen.facts),
            snapshot: previousSnapshot,
            warning: ShellBanner(
                identifier: "shell-banner-outer-horizon-refusal",
                severity: .warning,
                text: text
                    + " Showing the last observed hierarchy; no transport loss is claimed."))
    }

    private static func facts(_ snapshot: OuterHorizonSnapshot) -> [ShellScreenFact] {
        [
            ShellScreenFact(label: "Instance", value: snapshot.instanceId),
            ShellScreenFact(label: "Snapshot", value: "revision \(snapshot.seq)"),
            ShellScreenFact(label: "Hierarchy", value: "\(snapshot.nodes.count) nodes"),
            ShellScreenFact(label: "Created", value: snapshot.createdAt),
        ]
    }
}
