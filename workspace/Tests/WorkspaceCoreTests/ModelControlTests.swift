import XCTest
@testable import WorkspaceCore

final class ModelControlTests: XCTestCase {

    func testMCCCommandsCarryTheWindowDaemonPort() {
        XCTAssertEqual(
            ModelControlCommand.arguments(
                ["model-control-snapshot"], daemonPort: 4317),
            ["model-control-snapshot", "--port", "4317"])
        XCTAssertEqual(
            ModelControlCommand.arguments(
                ["routing", "export"], daemonPort: 4317),
            ["routing", "export", "--port", "4317"])
    }

    func testRawSnapshotKeepsUnknownProvidersAndUnknownQuota() throws {
        let json = """
        {
          "generatedAt":"2026-07-12T22:00:00Z",
          "providers":{
            "newvendor":{"status":"unavailable","reason":"no adapter"}
          },
          "billing":{"newvendor":null},
          "usageSurfaces":{"newvendor":"metered"},
          "quota":null,
          "quotaError":"daemon unavailable",
          "tokenUsage":null,
          "tokenUsageError":null
        }
        """
        let snapshot = try ModelControlSnapshot.decode(from: Data(json.utf8))
        XCTAssertEqual(snapshot.providerIDs, [ProviderID("newvendor")])
        XCTAssertNil(snapshot.quota)
        XCTAssertEqual(snapshot.quotaError, "daemon unavailable")
    }
}
