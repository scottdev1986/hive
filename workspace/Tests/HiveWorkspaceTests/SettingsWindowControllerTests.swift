import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

final class SettingsWindowControllerTests: XCTestCase {
    func testShowingAnExistingWindowRefreshesVendorState() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let count = root.appendingPathComponent("count")
        let state = root.appendingPathComponent("state")
        let stale = root.appendingPathComponent("stale.json")
        let fresh = root.appendingPathComponent("fresh.json")
        let policy = root.appendingPathComponent("policy.json")
        let hive = root.appendingPathComponent("hive")
        try "stale".write(to: state, atomically: true, encoding: .utf8)
        try snapshot(hidden: true).write(to: stale, atomically: true, encoding: .utf8)
        try snapshot(hidden: false).write(to: fresh, atomically: true, encoding: .utf8)
        try enabledPolicy.write(to: policy, atomically: true, encoding: .utf8)
        try """
            #!/bin/sh
            printf x >> "\(count.path)"
            if [ "$1" = "model-control-snapshot" ]; then
              if [ "$(cat "\(state.path)")" = "stale" ]; then
                cat "\(stale.path)"
              else
                cat "\(fresh.path)"
              fi
            else
              cat "\(policy.path)"
            fi
            """
            .write(to: hive, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: hive.path)

        let controller = SettingsWindowController(hivePath: hive.path, daemonPort: 4483)
        waitForInvocationCount(2, at: count)
        waitForInitialRefreshToSettle(controller)
        XCTAssertEqual(grokRowState(controller), .unavailable)

        try "fresh".write(to: state, atomically: true, encoding: .utf8)
        controller.show()
        waitForInvocationCount(4, at: count)
        waitForGrokRowState(.enabled, in: controller)
        controller.close()
    }

    private func snapshot(hidden: Bool) -> String {
        """
        {"generatedAt":"2026-07-13T21:00:00.000Z","providers":{"grok":{
          "status":"ok","records":[{"provider":"grok","canonicalId":"grok-4.5",
          "variant":null,"launchToken":"grok-4.5","displayName":"Grok 4.5",
          "hidden":{"state":"known","value":\(hidden),"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "supportsEffort":{"state":"known","value":true,"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "supportedEffortLevels":{"state":"known","value":["high"],"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "defaultEffort":{"state":"known","value":"high","surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "observedAt":"2026-07-13T21:00:00.000Z"}],"effectiveDefault":{
          "model":{"state":"known","value":"grok-4.5","surface":"grok.models","observedAt":"2026-07-13T21:00:00.000Z"},
          "effort":{"state":"known","value":"high","surface":"grok.models","observedAt":"2026-07-13T21:00:00.000Z"}}}},
          "billing":{"grok":null},"usageSurfaces":{"grok":"metered"},
          "quota":null,"quotaError":null}
        """
    }

    private var enabledPolicy: String {
        """
        {"schemaVersion":2,"revision":1,"updatedAt":"2026-07-13T21:00:00.000Z",
         "provisional":false,"providers":{"grok":"enabled"},
         "models":[{"provider":"grok","model":"grok-4.5","state":"enabled"}],
         "chains":{}}
        """
    }

    private func grokRowState(_ controller: SettingsWindowController) -> ModelRowState? {
        guard case .available(let models, _)? =
                controller.dataSource.snapshot?.providers["grok"],
              let model = models.first else { return nil }
        return controller.dataSource.rowState(
            provider: .grok, model: model.canonicalId,
            available: model.hidden.value != true)
    }

    private func waitForGrokRowState(
        _ expected: ModelRowState, in controller: SettingsWindowController
    ) {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if grokRowState(controller) == expected { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertEqual(grokRowState(controller), expected)
    }

    private func waitForInvocationCount(_ expected: Int, at url: URL) {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            let count = (try? Data(contentsOf: url).count) ?? 0
            if count >= expected { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertGreaterThanOrEqual((try? Data(contentsOf: url).count) ?? 0, expected)
    }

    private func waitForInitialRefreshToSettle(_ controller: SettingsWindowController) {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if case .loading = controller.dataSource.loadState {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            } else {
                return
            }
        }
        XCTFail("initial settings refresh did not settle")
    }
}
