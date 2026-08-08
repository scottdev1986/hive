// ShellScreenProjectionTests.swift
//
// Pins the availability → banner mapping and the honest empty states. The
// shared banners are the shell's one way to show loading/error states, so a
// mapping that drifts (stale wearing a fresh label, unknown rendering as
// healthy) fails here.

import XCTest
@testable import WorkspaceCore

final class ShellScreenProjectionTests: XCTestCase {

    private func projection(
        _ availability: ProjectionAvailability,
        evidence: ProjectionEvidence? = nil
    ) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: availability,
            freshness: .current,
            source: ProjectionSource(revision: "8", generation: 1),
            observedAt: "2026-07-30T20:00:00.000Z",
            evidence: evidence,
            contract: .frozen,
            facts: [])
    }

    func testCurrentAndUnknownRaiseNoBanner() {
        XCTAssertNil(projection(.current).banner)
        XCTAssertNil(projection(.unknown).banner)
    }

    func testStaleKeepsItsWordsAndTimestampMeaning() {
        let banner = projection(.stale).banner
        XCTAssertEqual(banner?.severity, .info)
        XCTAssertTrue(banner?.text.contains("stale") ?? false)
        XCTAssertTrue(banner?.text.contains("timestamps") ?? false)
    }

    func testDisconnectedNamesTheTransportLoss() {
        let banner = projection(
            .disconnected,
            evidence: .disconnected(transportLostAt: "2026-07-30T21:00:00.000Z")
        ).banner
        XCTAssertEqual(banner?.severity, .warning)
        XCTAssertTrue(banner?.text.contains("2026-07-30T21:00:00.000Z") ?? false)
        XCTAssertTrue(banner?.text.contains("not") ?? false, "must say it is not live")
    }

    func testUnauthorizedIsCriticalAndNamesTheRefusal() {
        let banner = projection(
            .unauthorized,
            evidence: .unauthorized(refusalCode: "read-not-authorized")
        ).banner
        XCTAssertEqual(banner?.severity, .critical)
        XCTAssertTrue(banner?.text.contains("read-not-authorized") ?? false)
    }

    func testConflictingNamesBothRevisions() {
        let banner = projection(
            .conflicting,
            evidence: .conflicting(competingRevision: "8-competing")
        ).banner
        XCTAssertEqual(banner?.severity, .warning)
        XCTAssertTrue(banner?.text.contains("8-competing") ?? false)
        XCTAssertTrue(banner?.text.contains("revision 8") ?? false)
    }

    func testReplacedNamesTheSupersedingSource() {
        let banner = projection(
            .replaced,
            evidence: .replaced(
                supersedingSource: ProjectionSource(revision: "9", generation: 2))
        ).banner
        XCTAssertEqual(banner?.severity, .info)
        XCTAssertTrue(banner?.text.contains("revision 9") ?? false)
    }

    func testEveryAvailabilityHasAHeadlineAndExplanation() {
        for availability in ProjectionAvailability.allCases {
            let screen = projection(availability)
            XCTAssertFalse(screen.stateHeadline.isEmpty, "\(availability) headline")
            XCTAssertFalse(screen.stateExplanation.isEmpty, "\(availability) explanation")
        }
    }

    func testNotFrozenStatesSayWhatIsAbsentAndWhy() {
        let screen = ShellScreenProjection.notFrozen("no wire in this build")
        XCTAssertEqual(screen.availability, .unknown)
        XCTAssertNil(screen.observedAt)
        XCTAssertTrue(screen.facts.isEmpty)
        XCTAssertEqual(screen.stateExplanation, "no wire in this build")
        // Unknown raises no banner: the panel states the absence itself.
        XCTAssertNil(screen.banner)
        XCTAssertEqual(screen.contract, .notFrozen(reason: "no wire in this build"))
    }

    func testValueLessStatesCarryNoFacts() {
        // A screen whose projection has no value must not invent content:
        // facts are extracted from real values only.
        for availability in [ProjectionAvailability.unknown, .unauthorized] {
            XCTAssertTrue(
                projection(availability).facts.isEmpty,
                "\(availability) without a value must render no facts")
        }
    }
}
