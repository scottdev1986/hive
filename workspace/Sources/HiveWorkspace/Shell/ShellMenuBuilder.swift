// ShellMenuBuilder.swift Builds the new shell's menu bar from the ShellCommand catalog: the layout below names every item and separator, and the enumeration tests prove it covers the catalog one-for-one — a command can never be added to the registry without appearing here, nor appear here without a registry entry. Items dispatch through one entry point on the window controller, carrying their command in `identifier`; responder-chain items keep their native selectors and a nil target.

import AppKit
import WorkspaceCore

enum ShellMenuBuilder {

    static let layout: [(menu: ShellMenu, items: [ShellCommand?])] = [
        (.hive, [
            .aboutHive,
            nil,
            .openMemoryManager,
            nil,
            .detachWorkspace,
            .stopHive,
        ]),
        (.edit, [
            .undo,
            .redo,
            nil,
            .cut,
            .copy,
            .paste,
            .selectAll,
        ]),
        (.view, [
            .showLiveRun,
            .showTaskRouter,
            .showModelsQuota,
            .toggleAttention,
            .toggleInspector,
            .enterFullTerminal,
        ]),
        (.agent, [
            .attachLiveTerminal,
            .detachTerminalView,
            nil,
            .pauseProvider,
            .resumeProvider,
            .stopProvider,
            .terminateTerminal,
            nil,
            .acknowledgeAttention,
            .closeAgent,
        ]),
        (.run, [
            .pauseRun,
            .resumeRun,
            .redirectThroughQueen,
            .abortRun,
        ]),
        (.memory, [
            .memoryOverview,
            .memoryLibrary,
            .memoryRecallLab,
            .newCuratedMemory,
            nil,
            .memoryMaintenance,
            .reindexMemory,
        ]),
        (.queen, [
            .selectQueenClaude,
            .selectQueenCodex,
            .selectQueenGrok,
            .selectQueenKimi,
            .selectQueenOpenCode,
            nil,
            .showQueenProvider,
        ]),
        (.window, [
            .minimizeWindow,
            .zoomWindow,
        ]),
    ]

    static func build(target: WorkspaceShellWindowController) -> NSMenu {
        let mainMenu = NSMenu()
        for (menu, items) in layout {
            let menuItem = NSMenuItem()
            mainMenu.addItem(menuItem)
            let submenu = NSMenu(title: menu.rawValue)
            menuItem.submenu = submenu
            for entry in items {
                guard let command = entry else {
                    submenu.addItem(.separator())
                    continue
                }
                submenu.addItem(makeItem(command, target: target))
            }
            if menu == .window {
                NSApp.windowsMenu = submenu
            }
        }
        return mainMenu
    }

    private static func makeItem(
        _ command: ShellCommand,
        target: WorkspaceShellWindowController
    ) -> NSMenuItem {
        let item: NSMenuItem
        switch command.resolution {
        case .responderChain(let action):
            item = NSMenuItem(
                title: command.title,
                action: Selector(action),
                keyEquivalent: command.keyEquivalent?.key ?? "")
            item.target = nil
        default:
            item = NSMenuItem(
                title: command.title,
                action: #selector(WorkspaceShellWindowController.performShellCommand(_:)),
                keyEquivalent: command.keyEquivalent?.key ?? "")
            item.target = target
        }
        item.identifier = NSUserInterfaceItemIdentifier(command.rawValue)
        if let modifiers = command.keyEquivalent?.modifiers {
            item.keyEquivalentModifierMask = modifierMask(modifiers)
        }
        return item
    }

    static func modifierMask(_ modifiers: ShellKeyModifiers) -> NSEvent.ModifierFlags {
        var mask: NSEvent.ModifierFlags = []
        if modifiers.contains(.command) { mask.insert(.command) }
        if modifiers.contains(.shift) { mask.insert(.shift) }
        if modifiers.contains(.option) { mask.insert(.option) }
        if modifiers.contains(.control) { mask.insert(.control) }
        return mask
    }
}
