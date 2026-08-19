import AppKit
import Testing
@testable import HiveWorkspace
@testable import WorkspaceCore

/// Right-clicking an agent in the Live Run rail offers one action, Close Agent.
/// What these pin is the honesty of the offer: the item exists on every row so a
/// right-click is never silently ignored, it is DISABLED rather than inert on a
/// row the app cannot close, and a refusal survives the feed heartbeat that
/// would otherwise wipe it off the screen a second later.
@MainActor
@Suite("Live Run Close Agent")
struct LiveRunCloseAgentTests {

    @Test("Every rail row carries a Close Agent menu with exactly that one item")
    func oneItemPerRow() throws {
        let view = try workbench()
        view.apply(try projection([agent("a", generation: 1), agent("b", generation: 2)]))

        let rows = railRows(in: view)
        #expect(rows.count == 2)
        for row in rows {
            let menu = try #require(row.menu)
            #expect(menu.items.count == 1)
            #expect(menu.items[0].title == "Close Agent")
        }
    }

    @Test("The row's menu and item carry accessibility identifiers built off the row's")
    func stableIdentifiers() throws {
        let view = try workbench()
        view.apply(try projection([agent("a", generation: 1)]))

        let row = try #require(railRows(in: view).first)
        #expect(row.accessibilityIdentifier() == "live-run-session-id-a")
        let menu = try #require(row.menu)
        #expect(menu.identifier?.rawValue == "live-run-session-id-a-menu")
        #expect(
            menu.items[0].accessibilityIdentifier()
                == "live-run-session-id-a-close-agent")
    }

    @Test("With a daemon connection the item is enabled and closes that exact agent")
    func enabledClosesTheRow() throws {
        var closed: [String] = []
        let view = try workbench()
        view.closeAgentHandler = { closed.append($0.name) }
        view.apply(try projection([agent("a", generation: 1), agent("b", generation: 2)]))

        let rows = railRows(in: view)
        let second = try #require(rows.first { $0.accessibilityIdentifier() == "live-run-session-id-b" })
        let item = try #require(second.menu?.items.first)
        #expect(second.validateMenuItem(item))

        _ = NSApp.sendAction(try #require(item.action), to: item.target, from: item)
        #expect(closed == ["b"])
    }

    @Test("No daemon connection disables the item instead of accepting a dead click")
    func noConnectionDisables() throws {
        // The launch that could not build an authenticated client leaves the
        // handler nil, exactly as a launch with no policy write handler leaves
        // the Model Control writes disabled.
        let view = try workbench()
        view.apply(try projection([agent("a", generation: 1)]))

        let row = try #require(railRows(in: view).first)
        let item = try #require(row.menu?.items.first)
        #expect(!row.validateMenuItem(item))

        _ = NSApp.sendAction(try #require(item.action), to: item.target, from: item)
        #expect(view.bannerText == nil)
    }

    @Test("A row with no exact session generation cannot be closed")
    func noLocatorDisables() throws {
        var closed: [String] = []
        let view = try workbench()
        view.closeAgentHandler = { closed.append($0.name) }
        let projected = try projection([agentWithoutLocator("a")])
        view.apply(projected)

        let row = try #require(railRows(in: view).first)
        let item = try #require(row.menu?.items.first)
        #expect(!row.validateMenuItem(item))

        // The handler is what would carry the kill; nothing may reach it.
        view.requestCloseAgent(try #require(projected.sessions.first))
        #expect(closed.isEmpty)
    }

    @Test("The queen is not an agent this route can close, so her row's item is disabled")
    func queenDisabled() throws {
        let view = try workbench()
        view.closeAgentHandler = { _ in }
        view.apply(try projection(
            [agent("a", generation: 1)], orchestrator: queenOrchestrator(generation: 3)))

        let queenRow = try #require(
            railRows(in: view).first { $0.accessibilityIdentifier() == "live-run-session-root" })
        let agentRow = try #require(
            railRows(in: view).first { $0.accessibilityIdentifier() == "live-run-session-id-a" })
        // Positive control: the same reader says yes on a row that can be closed.
        #expect(agentRow.validateMenuItem(try #require(agentRow.menu?.items.first)))
        #expect(!queenRow.validateMenuItem(try #require(queenRow.menu?.items.first)))
    }

    @Test("A close refusal outlives the next feed snapshot")
    func refusalSurvivesTheHeartbeat() throws {
        // workspace-feed emits at least every five seconds, and every snapshot
        // clears the banner. A refusal wiped before it is read reads as success.
        let view = try workbench()
        view.closeAgentHandler = { _ in }
        let projected = try projection([agent("a", generation: 1)])
        view.apply(projected)

        view.applyCloseOutcome("a was not closed: its session generation changed")
        #expect(view.bannerText == "a was not closed: its session generation changed")
        // The next heartbeat snapshot must not wipe it off the banner.
        view.apply(projected)
        #expect(view.bannerText == "a was not closed: its session generation changed")

        // A fresh close attempt clears the stale refusal before it starts.
        view.requestCloseAgent(try #require(projected.sessions.first))
        #expect(view.bannerText == nil)
    }

    private func workbench() throws -> LiveRunWorkbenchView {
        let view = LiveRunWorkbenchView(terminalFactory: nil)
        view.setRouteVisible(true)
        return view
    }

    private func railRows(in view: NSView) -> [LiveRunSessionButtonProbe] {
        var found: [LiveRunSessionButtonProbe] = []
        func visit(_ candidate: NSView) {
            if let button = candidate as? NSButton,
               button.accessibilityIdentifier().hasPrefix("live-run-session-")
                   || button.accessibilityIdentifier().hasPrefix("live-run-hierarchy-")
            {
                found.append(LiveRunSessionButtonProbe(button: button))
            }
            candidate.subviews.forEach(visit)
        }
        visit(view)
        return found
    }

    private func projection(
        _ agents: [String],
        orchestrator: String? = nil
    ) throws -> LiveRunProjection {
        var json = "{\"v\":1,\"agents\":[\(agents.joined(separator: ","))]"
        if let orchestrator {
            json += ",\"orchestrator\":\(orchestrator)"
        }
        json += "}"
        let line = try #require(FeedLine.parse(json))
        return try LiveRunProjection(feedLine: line)
    }

    private func agent(_ name: String, generation: Int) -> String {
        """
        {"id":"id-\(name)","name":"\(name)","tool":"codex","model":"model",
         "status":"idle","sessionLocator":{"schemaVersion":1,"instanceId":"rig",
         "subject":{"kind":"agent","agentId":"id-\(name)"},"generation":\(generation),
         "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
         "hostKind":"sessiond","engineBuildId":"engine"}}
        """
    }

    private func agentWithoutLocator(_ name: String) -> String {
        """
        {"id":"id-\(name)","name":"\(name)","tool":"codex","model":"model",
         "status":"idle"}
        """
    }

    private func queenOrchestrator(generation: Int) -> String {
        """
        {"name":"queen","status":"working","tool":"codex","model":"gpt-5.6-sol",
         "host":"sessiond","hostState":"running",
         "sessionLocator":{"schemaVersion":1,"instanceId":"rig",
           "subject":{"kind":"root"},"generation":\(generation),
           "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000099",
           "hostKind":"sessiond","engineBuildId":"engine"},
         "presentation":{"panePresence":"visible","terminalState":"live",
           "headerDetail":"working","paneStatus":{"kind":"running"},
           "activity":"working"}}
        """
    }
}

/// The rail row class is private to its file, so the test reaches it as the
/// NSButton it is and asks the validation the menu itself asks.
@MainActor
struct LiveRunSessionButtonProbe {
    let button: NSButton

    var menu: NSMenu? { button.menu }

    func accessibilityIdentifier() -> String { button.accessibilityIdentifier() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        (button as? NSMenuItemValidation)?.validateMenuItem(item) ?? false
    }
}
