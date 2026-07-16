import Foundation
import XCTest

final class SessionProtocolFixtureTests: XCTestCase {

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: name, withExtension: "json",
                subdirectory: "Fixtures"),
            "the generated session protocol fixture must ship with the test bundle")
        return try Data(contentsOf: url)
    }

    func testSharedCorporaAreBundledAndReadable() throws {
        let wire = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: fixture("session-protocol-corpus")) as? [String: Any])
        XCTAssertEqual((wire["valid"] as? [Any])?.count, 32)
        XCTAssertEqual((wire["invalid"] as? [Any])?.count, 36)

        let reducer = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: fixture("reducer-parity-corpus")) as? [String: Any])
        let scenarios = try XCTUnwrap(reducer["scenarios"] as? [[String: Any]])
        XCTAssertEqual(scenarios.count, 10)

        let gap = try XCTUnwrap(scenarios.first { ($0["name"] as? String) == "sequence-gap" })
        let prefixes = try XCTUnwrap(gap["prefixes"] as? [[String: Any]])
        let firstPrefix = try XCTUnwrap(prefixes.first)
        XCTAssertEqual(firstPrefix["recovery"] as? String, "SNAPSHOT_REQUIRED")

        _ = try JSONSerialization.jsonObject(
            with: fixture("session-protocol.schema"))
    }
}
