import XCTest
@testable import WorkspaceCore

final class TokenUsagePresentationTests: XCTestCase {
    func testDecodesDaemonHeadlineRowsAndControlShare() throws {
        let json = """
        {
          "sessionId":"00000000-0000-4000-8000-000000000001",
          "fleet":{
            "newInputTokens":2200,
            "freshInputTokens":1800,
            "cacheReadTokens":48800000,
            "cacheWriteTokens":400,
            "outputTokens":300000,
            "newTokens":302200,
            "cumulativeInputTokens":51000000,
            "cumulativeTotalTokens":51300000
          },
          "hiveControl":null,
          "workerSessions":null,
          "rows":[{
            "name":"Queen",
            "provider":"claude",
            "model":"claude-opus-4-8",
            "counts":null,
            "headline":null,
            "unknownReason":"No provider token reading has been observed"
          }],
          "controlSharePercent":12.5
        }
        """
        let value = try JSONDecoder().decode(
            WorkspaceTokenSessionPresentation.self, from: Data(json.utf8))
        XCTAssertEqual(value.fleet?.newTokens, 302_200)
        XCTAssertEqual(value.rows.map(\.name), ["Queen"])
        XCTAssertEqual(value.controlSharePercent, 12.5)
    }
}
