// ModelsQuotaScreenTests.swift
//
// Guards the distinction between an unknown reading and a measured zero.

import XCTest
@testable import WorkspaceCore

final class ModelsQuotaScreenTests: XCTestCase {
    func testUnknownNeverRendersAsZeroEvenWhenAValueIsInjected() {
        let unknown = QuotaEvidenceRow(
            label: "Provider silent", state: "unknown", value: 0,
            provenance: "probe returned no reading", observedAt: nil,
            resetsAt: nil, reason: "no measurement")
        XCTAssertEqual(unknown.displayedValue, "unknown — no numeric reading")
        XCTAssertFalse(unknown.displayedValue.contains("0%"))

        let measured = QuotaEvidenceRow(
            label: "Measured zero", state: "measured", value: 0,
            provenance: "provider", observedAt: "2026-07-30T20:00:00Z",
            resetsAt: nil, reason: nil)
        XCTAssertEqual(measured.displayedValue, "0%")
    }
}
