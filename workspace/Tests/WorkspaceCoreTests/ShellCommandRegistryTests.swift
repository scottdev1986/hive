// ShellCommandRegistryTests.swift
//
// Proves the dispatcher registry is a total function over the menu tree:
// every command resolves to exactly one typed intent, one screen route, one
// responder-chain selector, or one named local action — and none of the
// retired pane-era commands exists in the new tree.

import XCTest
@testable import WorkspaceCore

final class ShellCommandRegistryTests: XCTestCase {

    /// Pane-era command identifiers the transition deletes. A command id is
    /// how a menu item reaches code, so banning the ids bans the behavior.
    static let retiredCommandIdentifiers = [
        "promote-to-master",
        "return-queen-to-master",
        "close-pane",
        "focus-queen",
        "show-projects",
        "project-switcher",
        "navigate",
        "show-attention-queue",
        "floating-attention",
        "approve-provider-request",
    ]

    /// Retired user-visible titles: banned even under a fresh identifier.
    static let retiredTitles = [
        "Promote to Master",
        "Return Queen to Master",
        "Show Projects",
        "Close Pane",
        "Focus Queen",
        "Navigate",
        "Show Attention Queue",
        "Communications",
        "Gates",
    ]

    func testEveryCommandResolvesToExactlyOneWellFormedTarget() throws {
        for command in ShellCommand.allCases {
            switch command.resolution {
            case .route(let route):
                XCTAssertTrue(
                    ShellRoute.allCases.contains(route),
                    "\(command) routes to an unknown screen")
            case .intent(let body):
                // The intent is typed and envelope-ready: it must survive the
                // MutationIntent wire as itself.
                let intent = MutationIntent(
                    intentID: "test-\(command.rawValue)",
                    expected: .revision("1"),
                    idempotencyKey: "test-key",
                    body: body)
                let data = try JSONEncoder().encode(intent)
                let decoded = try JSONDecoder().decode(
                    MutationIntent<ShellIntentBody>.self, from: data)
                XCTAssertEqual(decoded, intent, "\(command)'s intent must round-trip")
            case .responderChain(let action):
                XCTAssertFalse(action.isEmpty)
                XCTAssertTrue(
                    action.hasSuffix(":"),
                    "\(command)'s responder selector \(action) must take the sender")
            case .local(.unavailableSurface(let reason)):
                XCTAssertFalse(
                    reason.isEmpty,
                    "\(command) must say why its surface is absent")
            case .local(.aboutPanel), .local(.detachWorkspace),
                 .local(.toggleAttentionDrawer), .local(.toggleInspector),
                 .local(.enterFullTerminal):
                break
            }
        }
    }

    func testNoRetiredCommandIdentifierExists() {
        let identifiers = Set(ShellCommand.allCases.map(\.rawValue))
        for retired in Self.retiredCommandIdentifiers {
            XCTAssertFalse(
                identifiers.contains(retired),
                "retired command \(retired) must never re-enter the registry")
        }
    }

    func testNoRetiredTitleExists() {
        let titles = ShellCommand.allCases.map(\.title)
        for retired in Self.retiredTitles {
            XCTAssertFalse(
                titles.contains(retired),
                "retired title \(retired) must never appear in the menu tree")
        }
    }

    func testMenusAreTheEightContractMenus() {
        XCTAssertEqual(
            ShellMenu.allCases.map(\.rawValue),
            ["Hive", "Edit", "View", "Agent", "Run", "Memory", "Queen", "Window"])
    }

    /// The shipping menu map, command for command. A menu that drifts from
    /// the registry's shape fails here, not in review.
    func testMenuContentsMatchTheContract() {
        XCTAssertEqual(
            Set(ShellMenu.hive.commands), [
                .aboutHive, .openMemoryManager,
                .detachWorkspace, .stopHive,
            ])
        XCTAssertEqual(
            Set(ShellMenu.edit.commands),
            [.undo, .redo, .cut, .copy, .paste, .selectAll])
        XCTAssertEqual(
            Set(ShellMenu.view.commands), [
                .showLiveRun, .showTaskRouter, .showModelsQuota,
                .toggleAttention, .toggleInspector, .enterFullTerminal,
            ])
        XCTAssertEqual(
            Set(ShellMenu.agent.commands), [
                .attachLiveTerminal, .detachTerminalView, .pauseProvider,
                .resumeProvider, .stopProvider, .terminateTerminal,
                .acknowledgeAttention, .closeAgent,
            ])
        XCTAssertEqual(
            Set(ShellMenu.run.commands), [
                .pauseRun, .resumeRun,
                .redirectThroughQueen, .abortRun,
            ])
        XCTAssertEqual(
            Set(ShellMenu.memory.commands), [
                .memoryOverview, .memoryLibrary, .memoryRecallLab,
                .newCuratedMemory, .memoryMaintenance, .reindexMemory,
            ])
        XCTAssertEqual(
            Set(ShellMenu.queen.commands), [
                .selectQueenClaude, .selectQueenCodex, .selectQueenGrok,
                .selectQueenKimi, .selectQueenOpenCode, .showQueenProvider,
            ])
        XCTAssertEqual(
            Set(ShellMenu.window.commands), [.minimizeWindow, .zoomWindow])
    }

    func testEveryCommandIsInExactlyOneMenu() {
        let assigned = ShellMenu.allCases.flatMap(\.commands)
        XCTAssertEqual(assigned.count, ShellCommand.allCases.count)
        XCTAssertEqual(Set(assigned), Set(ShellCommand.allCases))
    }

    func testEditMenuIsPureResponderChain() {
        for command in ShellMenu.edit.commands {
            guard case .responderChain = command.resolution else {
                XCTFail("\(command) must stay on the standard responder chain")
                return
            }
        }
    }

    /// Two items may share a shortcut only when they resolve identically —
    /// the Memory Manager and Memory→Overview rows both open the Overview
    /// screen, so ⇧⌘M still means exactly one thing.
    func testShortcutCollisionsResolveToTheSameTarget() {
        var byKey: [ShellKeyEquivalent: [ShellCommand]] = [:]
        for command in ShellCommand.allCases {
            guard let key = command.keyEquivalent else { continue }
            byKey[key, default: []].append(command)
        }
        for (key, commands) in byKey where commands.count > 1 {
            let resolutions = Set(commands.map { "\($0.resolution)" })
            XCTAssertEqual(
                resolutions.count, 1,
                "\(key.key) is bound to commands that disagree: \(commands)")
        }
    }

    /// The intent set is deliberate: converting a daemon command into a local
    /// stub (or vice versa) changes this set and fails loudly.
    func testExactlyTheDaemonBoundCommandsAreIntents() {
        let intents = ShellCommand.allCases.filter {
            if case .intent = $0.resolution { return true }
            return false
        }
        XCTAssertEqual(
            Set(intents), [
                .stopHive,
                .attachLiveTerminal, .detachTerminalView, .pauseProvider,
                .resumeProvider, .stopProvider, .terminateTerminal,
                .acknowledgeAttention, .closeAgent,
                .pauseRun, .resumeRun,
                .redirectThroughQueen, .abortRun,
                .newCuratedMemory, .reindexMemory,
                .selectQueenClaude, .selectQueenCodex, .selectQueenGrok,
                .selectQueenKimi, .selectQueenOpenCode,
            ])
    }

    /// A route command pointing at the WRONG screen is still a well-formed
    /// route, so only this table pins each one to its destination.
    func testRouteCommandsPointAtTheirContractScreens() {
        let expected: [ShellCommand: ShellRoute] = [
            .showTaskRouter: .taskRouter,
            .showModelsQuota: .modelsQuota,
            .openMemoryManager: .memoryOverview,
            .showLiveRun: .liveRun,
            .memoryOverview: .memoryOverview,
            .memoryLibrary: .memoryLibrary,
            .memoryRecallLab: .memoryRecallLab,
            .memoryMaintenance: .memoryMaintenance,
            .showQueenProvider: .queen,
        ]
        for (command, route) in expected {
            guard case .route(let resolved) = command.resolution else {
                XCTFail("\(command) lost its route resolution")
                continue
            }
            XCTAssertEqual(resolved, route, "\(command) must open \(route)")
        }
    }
}

extension ShellMenu {
    var commands: [ShellCommand] {
        ShellCommand.allCases.filter { $0.menu == self }
    }
}
