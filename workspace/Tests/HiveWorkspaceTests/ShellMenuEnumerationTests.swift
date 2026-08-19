// ShellMenuEnumerationTests.swift
//
// Walks the menu tree the user actually gets — the built menu installed as
// NSApp.mainMenu, with the window presented and the update pass run — and
// proves every item maps to exactly one registry command. AppKit appends its
// native window-list row to the Window menu on that tree, so the one allowed
// class of non-command items is exactly that row, exactly there; anything
// else unaccounted fails. The responder half fires each item through the one
// dispatch entry and checks the outcome.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class ShellMenuEnumerationTests: XCTestCase {

    /// Same retired sets as the registry tests (test targets cannot import
    /// each other); the assertion power lives in the enumeration below.
    private static let retiredCommandIdentifiers = [
        "promote-to-master", "return-queen-to-master", "close-pane",
        "focus-queen", "show-projects", "project-switcher", "navigate",
        "show-attention-queue", "floating-attention", "approve-provider-request",
        // The eighteen dead menu-intent commands.
        "select-queen-claude", "select-queen-codex", "select-queen-grok",
        "select-queen-kimi", "select-queen-opencode",
        "pause-provider", "resume-provider", "stop-provider", "terminate-terminal",
        "acknowledge-attention", "close-agent",
        "pause-run", "resume-run", "redirect-through-queen", "abort-run",
        "new-curated-memory", "reindex-memory", "stop-hive",
    ]
    private static let retiredTitles = [
        "Promote to Master", "Return Queen to Master", "Show Projects",
        "Close Pane", "Focus Queen", "Navigate", "Show Attention Queue",
        "Communications", "Gates",
        "Select Claude…", "Select Codex…", "Select Grok…", "Select Kimi Code…",
        "Select OpenCode…", "Pause Provider", "Resume Provider",
        "Stop Provider…", "Terminate Terminal…", "Acknowledge Attention",
        "Close Agent…", "Pause Run…", "Resume Run…", "Redirect Through Queen…",
        "Abort Run…", "New Curated Memory…", "Reindex…", "Stop Hive…",
    ]

    private func makeController() -> WorkspaceShellWindowController {
        _ = NSApplication.shared
        var state = ShellState()
        state.apply(
            screen: ShellScreenProjection(
                availability: .current,
                freshness: .current,
                source: ProjectionSource(revision: "8", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                evidence: nil,
                contract: .frozen,
                facts: []),
            for: .liveRun)
        return WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/tmp/hive",
                instanceLabel: "instance · test"),
            state: state)
    }

    private func makeItem(_ command: ShellCommand) -> NSMenuItem {
        let item = NSMenuItem(title: command.title, action: nil, keyEquivalent: "")
        item.identifier = NSUserInterfaceItemIdentifier(command.rawValue)
        return item
    }

    /// The built menu installed as the app's real main menu, the window
    /// presented, and the update pass forced. AppKit only appends its
    /// window-list row to the Window menu on that presented, installed tree,
    /// so that tree — not the freshly built one — is the enumeration target.
    private func withInstalledMenu(
        _ controller: WorkspaceShellWindowController,
        _ body: (NSMenu) throws -> Void
    ) rethrows {
        let menu = ShellMenuBuilder.build(target: controller)
        let previous = NSApp.mainMenu
        NSApp.mainMenu = menu
        defer { NSApp.mainMenu = previous }
        controller.window?.makeKeyAndOrderFront(nil)
        menu.update()
        try body(menu)
    }

    /// Every non-separator item in the tree, flattened, with its submenu.
    private func flatten(
        _ menu: NSMenu
    ) -> [(submenu: String, item: NSMenuItem)] {
        menu.items.flatMap { item -> [(submenu: String, item: NSMenuItem)] in
            if let submenu = item.submenu { return flatten(submenu) }
            if item.isSeparatorItem { return [] }
            return [(menu.title, item)]
        }
    }

    func testInstalledPresentedMenuAccountsForEveryItem() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            var seen: [ShellCommand: Int] = [:]
            var windowListRows = 0
            for (submenu, item) in flatten(menu) {
                if item.action == #selector(NSWindow.makeKeyAndOrderFront(_:)) {
                    // The one allowed non-command class: the native
                    // window-list row, only inside the Window menu. AppKit
                    // marks these rows with the action name as identifier.
                    XCTAssertEqual(
                        submenu, ShellMenu.window.rawValue,
                        "window-list row \(item.title) outside the Window menu")
                    windowListRows += 1
                    continue
                }
                guard let identifier = item.identifier,
                      let command = ShellCommand(rawValue: identifier.rawValue)
                else {
                    XCTFail("unaccounted menu item \(item.title) "
                        + "(action \(String(describing: item.action)))")
                    continue
                }
                seen[command, default: 0] += 1
            }
            for (command, count) in seen {
                XCTAssertEqual(count, 1, "\(command) appears \(count) times")
            }
            XCTAssertEqual(
                Set(seen.keys), Set(ShellCommand.allCases),
                "the presented menu tree and the registry cover each other exactly")
            XCTAssertGreaterThanOrEqual(
                windowListRows, 1,
                "positive control: the presented window must appear "
                    + "as a window-list row")
        }
    }

    func testMenuTitlesAreTheSevenContractMenus() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            XCTAssertEqual(
                menu.items.compactMap { $0.submenu?.title },
                ["Hive", "Edit", "View", "Agent", "Memory", "Queen", "Window"])
        }
    }

    func testNoRetiredCommandExistsInTheBuiltTree() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            for (_, item) in flatten(menu) {
                XCTAssertFalse(
                    Self.retiredCommandIdentifiers.contains(
                        item.identifier?.rawValue ?? ""),
                    "\(item.title) uses a retired identifier")
                XCTAssertFalse(
                    Self.retiredTitles.contains(item.title),
                    "\(item.title) is a retired title")
            }
            // The retired menus themselves must not exist either.
            XCTAssertEqual(
                menu.items.compactMap { $0.submenu?.title }
                    .filter { ["Navigate", "Pane", "Communications", "Gates", "Run"].contains($0) },
                [])
        }
    }

    func testEveryShortcutMatchesTheCatalog() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            for (_, item) in flatten(menu) {
                guard let command = item.identifier
                    .flatMap({ ShellCommand(rawValue: $0.rawValue) }) else { continue }
                let catalogKey = command.keyEquivalent
                XCTAssertEqual(
                    item.keyEquivalent, catalogKey?.key ?? "",
                    "\(command)'s key equivalent drifted from the catalog")
                XCTAssertEqual(
                    item.keyEquivalentModifierMask,
                    catalogKey.map { ShellMenuBuilder.modifierMask($0.modifiers) } ?? .command,
                    "\(command)'s modifiers drifted from the catalog")
            }
        }
    }

    func testNothingIsDisabledWithoutAMeasuredAbsence() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            for (_, item) in flatten(menu) {
                XCTAssertTrue(
                    item.isEnabled,
                    "\(item.title) is greyed out — an in-flight wire must report "
                        + "its failure, never hide behind a disabled item")
            }
        }
    }

    func testItemActionsMatchTheirResolutionKind() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            for (_, item) in flatten(menu) {
                guard let command = item.identifier
                    .flatMap({ ShellCommand(rawValue: $0.rawValue) }) else { continue }
                switch command.resolution {
                case .responderChain(let action):
                    XCTAssertEqual(item.action, Selector(action), "\(command)")
                    XCTAssertNil(item.target, "\(command) must ride the responder chain")
                default:
                    XCTAssertEqual(
                        item.action,
                        #selector(WorkspaceShellWindowController.performShellCommand(_:)),
                        "\(command) must enter through the one dispatch point")
                    XCTAssertTrue(item.target === controller, "\(command)'s target")
                }
            }
        }
    }

    /// The responder half: every menu item, fired through its own action,
    /// produces the registry's outcome.
    func testFiringEveryItemResolvesLikeTheRegistrySays() {
        let controller = makeController()
        controller.window?.makeKeyAndOrderFront(nil)
        for command in ShellCommand.allCases {
            switch command.resolution {
            case .responderChain:
                continue // native selectors are AppKit's own behavior
            case .route(let route):
                controller.performShellCommand(makeItem(command))
                XCTAssertEqual(
                    controller.currentState.activeRoute, route,
                    "\(command) must route to \(route)")
                XCTAssertEqual(
                    controller.currentState.lastOutcome, .routed(route))
            case .local(.attachLiveTerminal), .local(.detachTerminalView):
                // No Live Run workbench is installed on this controller, so
                // both honestly refuse rather than claim a viewer that isn't there.
                controller.performShellCommand(makeItem(command))
                guard case .surfaceUnavailable(let observed, _) =
                    controller.currentState.lastOutcome else {
                    XCTFail("\(command) did not resolve against the viewer")
                    continue
                }
                XCTAssertEqual(observed, command)
            case .local(.toggleAttentionDrawer):
                let before = controller.currentState.attentionDrawerVisible
                controller.performShellCommand(makeItem(command))
                XCTAssertEqual(
                    controller.currentState.attentionDrawerVisible, !before)
            case .local(.toggleInspector):
                let before = controller.currentState.inspectorVisible
                controller.performShellCommand(makeItem(command))
                XCTAssertEqual(
                    controller.currentState.inspectorVisible, !before)
            case .local(.unavailableSurface):
                controller.performShellCommand(makeItem(command))
                guard case .surfaceUnavailable(let surfaced, _) =
                    controller.currentState.lastOutcome
                else {
                    XCTFail("\(command) must report its absence honestly")
                    continue
                }
                XCTAssertEqual(surfaced, command)
            case .local(.aboutPanel), .local(.detachWorkspace),
                 .local(.enterFullTerminal):
                continue // window- and app-level effects, not state outcomes
            }
        }
    }

    /// Shortcut metadata proves nothing by itself: a real key-equivalent
    /// event must travel the installed menu and change state.
    func testARealKeyEquivalentEventReachesTheCommand() throws {
        let controller = makeController()
        try withInstalledMenu(controller) { menu in
            let event = try XCTUnwrap(NSEvent.keyEvent(
                with: .keyDown,
                location: .zero,
                modifierFlags: [.command, .option],
                timestamp: 0,
                windowNumber: controller.window?.windowNumber ?? 0,
                context: nil,
                characters: "a",
                charactersIgnoringModifiers: "a",
                isARepeat: false,
                keyCode: 0))
            XCTAssertFalse(controller.currentState.attentionDrawerVisible)
            XCTAssertTrue(
                menu.performKeyEquivalent(with: event),
                "⌥⌘A must match a live menu item")
            XCTAssertTrue(
                controller.currentState.attentionDrawerVisible,
                "the event must reach the dispatcher and toggle the drawer")
        }
    }
}
