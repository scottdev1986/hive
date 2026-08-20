import XCTest
@testable import WorkspaceCore

final class StatusDimensionsTests: XCTestCase {
    private let observedAt = "2026-08-02T12:00:00.000Z"

    private func observed(_ value: String, source: String = "provider-protocol") -> String {
        #"{"kind":"observed","field":{"value":"\#(value)","source":{"kind":"\#(source)","id":"source-fixture"},"observedAt":"\#(observedAt)","freshness":"fresh","confidence":"authoritative"}}"#
    }

    private func dimensions(
        schemaVersion: Int = 1,
        runtime: String = "ready",
        turn: String = "working",
        input: String = "empty",
        mail: String = "none",
        health: String = "healthy",
        attention: String = "none"
    ) -> String {
        #"{"schemaVersion":\#(schemaVersion),"revision":"6","runtime":\#(observed(runtime)),"turn":\#(observed(turn)),"input":\#(observed(input, source: "sessiond")),"mail":\#(observed(mail)),"health":\#(observed(health, source: "sessiond")),"attention":\#(observed(attention, source: "user"))}"#
    }

    private func agent(
        flatStatus: String = "working",
        dimensions: String,
        presentation: String = #"{"panePresence":"visible","terminalState":"live","headerDetail":"runtime=ready · turn=working · input=empty · mail=none · health=healthy · attention=none","paneStatus":{"kind":"running"},"activity":"working","attention":null}"#
    ) throws -> AgentSnapshot {
        let line = #"{"v":1,"agents":[{"name":"worker","status":"\#(flatStatus)","statusDimensions":\#(dimensions),"presentation":\#(presentation)}]}"#
        return try XCTUnwrap(try XCTUnwrap(FeedLine.parse(line)).agents?.first)
    }

    func testDecodesAllSixDimensionsAndTheirEvidence() throws {
        let status = try XCTUnwrap(try agent(dimensions: dimensions()).statusDimensions)

        guard case .observed(let runtime) = status.runtime,
              case .observed(let turn) = status.turn,
              case .observed(let input) = status.input,
              case .observed(let mail) = status.mail,
              case .observed(let health) = status.health,
              case .observed(let attention) = status.attention else {
            return XCTFail("all six fixture dimensions must be observed")
        }
        XCTAssertEqual(runtime.value, .ready)
        XCTAssertEqual(turn.value, .working)
        XCTAssertEqual(input.value, .empty)
        XCTAssertEqual(mail.value, .none)
        XCTAssertEqual(health.value, .healthy)
        XCTAssertEqual(attention.value, .none)
        XCTAssertEqual(turn.source.kind, "provider-protocol")
        XCTAssertEqual(turn.observedAt, observedAt)
        XCTAssertEqual(turn.freshness, .fresh)
        XCTAssertEqual(turn.confidence, .authoritative)
    }

    func testRejectsAnUnsupportedDimensionsSchemaVersion() throws {
        let line = #"{"v":1,"agents":[{"name":"worker","status":"working","statusDimensions":\#(dimensions(schemaVersion: 2))}]}"#
        let decoded = try XCTUnwrap(FeedLine.parse(line))

        XCTAssertNil(decoded.agents)
        XCTAssertTrue(try XCTUnwrap(decoded.error).contains("schemaVersion 2"))
    }

    func testEveryOpenStateEnumPreservesAndRendersAnUnknownWordVerbatim() throws {
        let decoded = try agent(
            dimensions: dimensions(
                runtime: "hibernating",
                turn: "pondering",
                input: "voice_owned",
                mail: "triaged",
                health: "quiescing",
                attention: "page"),
            presentation:
                #"{"panePresence":"visible","terminalState":"live","headerDetail":"runtime=hibernating · turn=pondering · input=voice_owned · mail=triaged · health=quiescing · attention=page","paneStatus":{"kind":"unknown"},"activity":"unknown","attention":null}"#)
        let status = try XCTUnwrap(decoded.statusDimensions)

        guard case .observed(let runtime) = status.runtime,
              case .observed(let turn) = status.turn,
              case .observed(let input) = status.input,
              case .observed(let mail) = status.mail,
              case .observed(let health) = status.health,
              case .observed(let attention) = status.attention else {
            return XCTFail("all six fixture dimensions must be observed")
        }
        XCTAssertEqual(runtime.value, .unknown("hibernating"))
        XCTAssertEqual(turn.value, .unknown("pondering"))
        XCTAssertEqual(input.value, .unknown("voice_owned"))
        XCTAssertEqual(mail.value, .unknown("triaged"))
        XCTAssertEqual(health.value, .unknown("quiescing"))
        XCTAssertEqual(attention.value, .unknown("page"))
        XCTAssertEqual(decoded.presentation.headerDetail, "runtime=hibernating · turn=pondering · input=voice_owned · mail=triaged · health=quiescing · attention=page")
        XCTAssertEqual(decoded.presentation.paneStatus.paneStatus(), .unknown)
    }

}
