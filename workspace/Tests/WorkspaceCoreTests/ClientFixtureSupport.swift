// ClientFixtureSupport.swift
//
// Loads one golden corpus for one frozen wire. The helper is intentionally
// generic so adding a wire means adding its value type and fixture module,
// without changing a central decoder or production code.

import Foundation
import XCTest
@testable import WorkspaceCore

protocol ClientFixtureModule {
    associatedtype Value: Codable & Equatable & Sendable
    static var resourceName: String { get }
}

extension ClientFixtureModule {
    static func loadData() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: resourceName,
                withExtension: "json",
                subdirectory: "Fixtures"),
            "\(resourceName).json must ship with the test bundle")
        return try Data(contentsOf: url)
    }

    static func load() throws -> [ClientProjection<Value>] {
        try JSONDecoder().decode(
            [ClientProjection<Value>].self,
            from: loadData())
    }
}

func assertGoldenFixtureMatrix<Module: ClientFixtureModule>(
    _ module: Module.Type,
    file: StaticString = #filePath,
    line: UInt = #line
) throws {
    let fixtures = try module.load()
    let expected = Set(ProjectionAvailability.allCases)

    XCTAssertEqual(fixtures.count, expected.count, file: file, line: line)
    XCTAssertEqual(
        Set(fixtures.map(\.availability)),
        expected,
        "the corpus must carry each availability exactly once",
        file: file,
        line: line)
    XCTAssertTrue(
        fixtures.allSatisfy { $0.schemaVersion == 1 },
        "the client projection envelope version must stay pinned",
        file: file,
        line: line)

    assertFixture(
        fixtures.first { $0.availability == .current },
        freshness: .current,
        hasValue: true,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .unknown },
        freshness: .unknown,
        hasValue: false,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .stale },
        freshness: .stale,
        hasValue: true,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .disconnected },
        freshness: .stale,
        hasValue: true,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .unauthorized },
        freshness: .unknown,
        hasValue: false,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .conflicting },
        freshness: .current,
        hasValue: true,
        file: file,
        line: line)
    assertFixture(
        fixtures.first { $0.availability == .replaced },
        freshness: .current,
        hasValue: true,
        file: file,
        line: line)
    for fixture in fixtures {
        assertEvidence(fixture, file: file, line: line)
    }

    let wireObjects = try XCTUnwrap(
        JSONSerialization.jsonObject(with: module.loadData())
            as? [[String: Any]],
        file: file,
        line: line)
    let withoutAvailability = try wireObjects.map { fixture in
        var fixture = fixture
        fixture.removeValue(forKey: "availability")
        return try JSONSerialization.data(
            withJSONObject: fixture,
            options: [.sortedKeys])
    }
    XCTAssertEqual(
        Set(withoutAvailability).count,
        fixtures.count,
        "removing the label must still leave seven independently renderable states",
        file: file,
        line: line)

    let encoded = try JSONEncoder().encode(fixtures)
    let roundTrip = try JSONDecoder().decode(
        [ClientProjection<Module.Value>].self,
        from: encoded)
    XCTAssertEqual(roundTrip, fixtures, file: file, line: line)
    XCTAssertEqual(
        try canonicalJSON(module.loadData()),
        try canonicalJSON(encoded),
        "decoding and encoding must preserve the complete wire, including required nulls",
        file: file,
        line: line)
}

private func assertFixture<Value>(
    _ fixture: ClientProjection<Value>?,
    freshness: ProjectionFreshness,
    hasValue: Bool,
    file: StaticString,
    line: UInt
) where Value: Codable & Equatable & Sendable {
    XCTAssertEqual(fixture?.freshness, freshness, file: file, line: line)
    XCTAssertEqual(fixture?.value != nil, hasValue, file: file, line: line)
    if hasValue {
        XCTAssertNotNil(fixture?.observedAt, file: file, line: line)
        XCTAssertTrue(
            fixture?.source.revision != nil || fixture?.source.generation != nil,
            "an observed value must identify its source revision or generation",
            file: file,
            line: line)
    }
}

private func assertEvidence<Value>(
    _ fixture: ClientProjection<Value>,
    file: StaticString,
    line: UInt
) where Value: Codable & Equatable & Sendable {
    switch (fixture.availability, fixture.evidence) {
    case (.current, nil), (.unknown, nil), (.stale, nil):
        return
    case (.disconnected, .disconnected(let transportLostAt)):
        XCTAssertFalse(transportLostAt.isEmpty, file: file, line: line)
    case (.unauthorized, .unauthorized(let refusalCode)):
        XCTAssertFalse(refusalCode.isEmpty, file: file, line: line)
    case (.conflicting, .conflicting(let competingRevision)):
        XCTAssertNotNil(fixture.source.revision, file: file, line: line)
        XCTAssertNotEqual(
            competingRevision,
            fixture.source.revision,
            file: file,
            line: line)
    case (.replaced, .replaced(let supersedingSource)):
        XCTAssertTrue(
            supersedingSource.revision != nil || supersedingSource.generation != nil,
            file: file,
            line: line)
        XCTAssertNotEqual(
            supersedingSource,
            fixture.source,
            file: file,
            line: line)
    default:
        XCTFail(
            "availability and evidence describe different states",
            file: file,
            line: line)
    }
}

func canonicalJSON(_ data: Data) throws -> Data {
    try JSONSerialization.data(
        withJSONObject: JSONSerialization.jsonObject(with: data),
        options: [.sortedKeys])
}
