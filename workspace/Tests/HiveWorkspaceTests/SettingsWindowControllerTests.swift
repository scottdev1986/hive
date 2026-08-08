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
        let state = root.appendingPathComponent("state")
        let stale = root.appendingPathComponent("stale.json")
        let fresh = root.appendingPathComponent("fresh.json")
        try "stale".write(to: state, atomically: true, encoding: .utf8)
        try view(hidden: true).write(to: stale, atomically: true, encoding: .utf8)
        try view(hidden: false).write(to: fresh, atomically: true, encoding: .utf8)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:4483")!,
            authorization: "Bearer fixture",
            loader: { request in
                let data: Data
                let selected = try String(contentsOf: state, encoding: .utf8)
                data = try Data(contentsOf: selected == "stale" ? stale : fresh)
                return (data, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let controller = SettingsWindowController(
            hivePath: nil, daemonPort: nil,
            makeDaemonClient: { client })
        waitForInitialRefreshToSettle(controller)
        XCTAssertEqual(grokRowState(controller), .unavailable)

        try "fresh".write(to: state, atomically: true, encoding: .utf8)
        controller.show()
        waitForGrokRowState(.enabled, in: controller)
        RunLoop.main.run(until: Date().addingTimeInterval(0.35))
        assertLabelsCannotResizeWindow(controller)
        controller.close()
    }

    private func view(hidden: Bool) -> String {
        let rowState = hidden ? "unavailable" : "enabled"
        let catalog = hidden
            ? "[]"
            : """
              [{"provider":"grok","model":"grok-4.5",
                "effortOptions":[
                  {"argument":"hive-decides","label":"Hive decides","effort":{"mode":"hive-decides"}},
                  {"argument":"none","label":"No effort setting","effort":{"mode":"none"}},
                  {"argument":"provider-controlled","label":"Provider controlled","effort":{"mode":"provider-controlled"}},
                  {"argument":"exact:high","label":"high (vendor recommends)","effort":{"mode":"exact","value":"high"}}],
                "addEffortOptions":[
                  {"argument":"exact:high","label":"high (vendor recommends)","effort":{"mode":"exact","value":"high"}}],
                "startingEffort":{"mode":"hive-decides"}}]
              """
        return """
        {
          "schemaVersion":1,
          "observedAt":"2026-07-13T21:00:00.000Z",
          "snapshot":\(snapshot(hidden: hidden)),
          "routing":{
            "policy":\(enabledPolicy),
            "categories":[],
            "modes":[
              {"id":"user-weighted","label":"Weighted split","caption":"Weighted","weightEditable":true},
              {"id":"hive-equal","label":"Equal split","caption":"Equal","weightEditable":false}
            ],
            "defaultMode":"hive-equal",
            "weightRange":{"minimum":1,"maximum":100,"defaultValue":1},
            "catalog":\(catalog),
            "providers":{"grok":{"state":"enabled"}},
            "models":[{
              "provider":"grok","model":"grok-4.5","state":"enabled",
              "source":"model","rowState":"\(rowState)","preferenceOn":true
            }],
            "candidates":[],"warnings":[]
          },
          "providers":{"grok":{
            "catalogState":"available","catalogReason":null,
            "planLabel":null,"billingChip":"unknown",
            "spendCaveat":"Hive cannot read this vendor's billing",
            "usage":{"state":"unknown","reason":"fixture has no quota reading"},
            "models":[{
              "canonicalId":"grok-4.5","variant":null,"displayId":"grok-4.5",
              "name":"Grok 4.5",
              "effortAxis":{"state":"known","levels":["high"],"defaultLevel":"high"},
              "poolExhausted":false
            }]
          }},
          "tokenSessions":[]
        }
        """
    }

    private func snapshot(hidden: Bool) -> String {
        """
        {"generatedAt":"2026-07-13T21:00:00.000Z","providers":{"grok":{
          "status":"ok","records":[{"provider":"grok","accountFingerprint":"grok:test",
          "cliVersion":"test-cli","canonicalId":"grok-4.5","variant":null,
          "launchToken":"grok-4.5","aliases":[],"displayName":"Grok 4.5",
          "entitled":{"state":"known","value":true,"surface":"grok.models","observedAt":"2026-07-13T21:00:00.000Z"},
          "hidden":{"state":"known","value":\(hidden),"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "supportsEffort":{"state":"known","value":true,"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "supportedEffortLevels":{"state":"known","value":["high"],"surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "defaultEffort":{"state":"known","value":"high","surface":"grok.models_cache","observedAt":"2026-07-13T21:00:00.000Z"},
          "observedAt":"2026-07-13T21:00:00.000Z"}],"effectiveDefault":{
          "provider":"grok",
          "model":{"state":"known","value":"grok-4.5","surface":"grok.models","observedAt":"2026-07-13T21:00:00.000Z"},
          "effort":{"state":"known","value":"high","surface":"grok.models","observedAt":"2026-07-13T21:00:00.000Z"}}}},
          "billing":{"grok":null},"usageSurfaces":{"grok":"metered"},
          "quota":null,"quotaError":null,"tokenUsage":null,"tokenUsageError":null}
        """
    }

    private var enabledPolicy: String {
        """
        {"schemaVersion":3,"revision":1,"updatedAt":"2026-07-13T21:00:00.000Z",
         "provisional":false,"providers":{"grok":"enabled"},
         "models":[{"provider":"grok","model":"grok-4.5","state":"enabled",
                    "effort":{"mode":"never-configured"}}],
         "global":null,"categories":{}}
        """
    }

    private func grokRowState(_ controller: SettingsWindowController) -> ModelRowState? {
        guard case .available(let models, _)? =
                controller.dataSource.snapshot?.providers["grok"],
              let model = models.first else { return nil }
        return controller.dataSource.rowState(
            provider: .grok, model: model.canonicalId)
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

    private func assertLabelsCannotResizeWindow(_ controller: SettingsWindowController) {
        let labels = controller.window?.contentView.map { textFields(in: $0) } ?? []
        let offenders = labels.filter { label in
            guard !hasButtonAncestor(label) else { return false }
            return label.contentCompressionResistancePriority(for: .horizontal).rawValue >= 500
        }
        XCTAssertEqual(offenders.map { "\(type(of: $0)): \($0.stringValue)" }, [])
    }

    private func hasButtonAncestor(_ view: NSView) -> Bool {
        var ancestor = view.superview
        while let current = ancestor {
            if current is NSButton { return true }
            ancestor = current.superview
        }
        return false
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { [$0] } ?? [])
            + view.subviews.flatMap(textFields)
    }
}
