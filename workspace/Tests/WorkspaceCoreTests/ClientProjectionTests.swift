// ClientProjectionTests.swift
//
// Pins the state evidence that keeps visually different projection conditions
// from collapsing into relabelled copies of the same value.

import Foundation
import XCTest
@testable import WorkspaceCore

final class ClientProjectionTests: XCTestCase {
    func testEnvelopeRejectsUnknownSchemaVersion() {
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                schemaVersion: 2,
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .current,
                availability: .current,
                evidence: nil,
                value: 1))
    }

    func testAvailabilityCannotContradictItsEvidence() {
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .stale,
                availability: .disconnected,
                evidence: nil,
                value: 1))
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .current,
                availability: .current,
                evidence: .unauthorized(refusalCode: "read-not-authorized"),
                value: 1))
    }

    func testConflictAndReplacementEvidenceMustNameDifferentState() {
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .current,
                availability: .conflicting,
                evidence: .conflicting(competingRevision: "7"),
                value: 1))
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .current,
                availability: .replaced,
                evidence: .replaced(
                    supersedingSource: ProjectionSource(
                        revision: "7",
                        generation: 1)),
                value: 1))
        XCTAssertThrowsError(
            try ClientProjection<Int>(
                source: ProjectionSource(revision: "7", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                freshness: .current,
                availability: .replaced,
                evidence: .replaced(
                    supersedingSource: ProjectionSource()),
                value: 1))
    }

    func testEvidenceKeyIsRequiredEvenWhenNull() {
        let wire = Data(
            #"""
            {
              "schemaVersion": 1,
              "source": {"revision":"7","generation":1},
              "observedAt": "2026-07-30T20:00:00.000Z",
              "freshness": "current",
              "availability": "current",
              "value": 1
            }
            """#.utf8)

        XCTAssertThrowsError(
            try JSONDecoder().decode(
                ClientProjection<Int>.self,
                from: wire))
    }

    func testEnvelopeSchemaVersionMustBeOne() throws {
        let wire = Data(
            #"""
            {
              "schemaVersion": 2,
              "source": {"revision":"7","generation":1},
              "observedAt": null,
              "freshness": "unknown",
              "availability": "unknown",
              "evidence": null,
              "value": null
            }
            """#.utf8)

        XCTAssertThrowsError(
            try JSONDecoder().decode(ClientProjection<Int>.self, from: wire))
    }
}
