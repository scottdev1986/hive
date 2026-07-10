import AppKit

/// Native menu bar. Every pane item sends a nil-targeted action down the
/// responder chain, so the key window's controller handles it — the same
/// command model as clicks and accessibility actions, routed by key window.
enum MainMenuBuilder {

    static func build() -> NSMenu {
        let mainMenu = NSMenu()

        // Application
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Hive Workspace",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Hive Workspace",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Edit (native text editing + find)
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        let find = NSMenuItem(title: "Find…", action: #selector(NSTextView.performFindPanelAction(_:)), keyEquivalent: "f")
        find.tag = NSTextFinder.Action.showFindInterface.rawValue
        editMenu.addItem(find)
        let findNext = NSMenuItem(title: "Find Next", action: #selector(NSTextView.performFindPanelAction(_:)), keyEquivalent: "g")
        findNext.tag = NSTextFinder.Action.nextMatch.rawValue
        editMenu.addItem(findNext)

        // Pane (the shared command model, keyboard-first)
        let paneItem = NSMenuItem()
        mainMenu.addItem(paneItem)
        let paneMenu = NSMenu(title: "Pane")
        paneItem.submenu = paneMenu
        paneMenu.addItem(withTitle: "Promote to Master",
                         action: #selector(ProjectWindowController.promoteFocusedPane(_:)), keyEquivalent: "\r")
        let returnItem = NSMenuItem(title: "Return Orchestrator to Master",
                                    action: #selector(ProjectWindowController.returnOrchestratorToMaster(_:)),
                                    keyEquivalent: "\r")
        returnItem.keyEquivalentModifierMask = [.command, .shift]
        paneMenu.addItem(returnItem)
        paneMenu.addItem(.separator())

        let focusOrch = NSMenuItem(title: "Focus Orchestrator",
                                   action: #selector(ProjectWindowController.focusOrchestrator(_:)), keyEquivalent: "0")
        paneMenu.addItem(focusOrch)
        let arrows: [(String, Selector, String)] = [
            ("Focus Left", #selector(ProjectWindowController.moveFocusLeft(_:)), String(UnicodeScalar(NSLeftArrowFunctionKey)!)),
            ("Focus Right", #selector(ProjectWindowController.moveFocusRight(_:)), String(UnicodeScalar(NSRightArrowFunctionKey)!)),
            ("Focus Up", #selector(ProjectWindowController.moveFocusUp(_:)), String(UnicodeScalar(NSUpArrowFunctionKey)!)),
            ("Focus Down", #selector(ProjectWindowController.moveFocusDown(_:)), String(UnicodeScalar(NSDownArrowFunctionKey)!)),
        ]
        for (title, selector, key) in arrows {
            let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            item.keyEquivalentModifierMask = [.command, .option]
            paneMenu.addItem(item)
        }
        paneMenu.addItem(.separator())

        let acknowledge = NSMenuItem(title: "Acknowledge",
                                     action: #selector(ProjectWindowController.acknowledgeFocusedPane(_:)),
                                     keyEquivalent: "k")
        acknowledge.keyEquivalentModifierMask = [.command, .shift]
        paneMenu.addItem(acknowledge)
        let approve = NSMenuItem(title: "Approve Pending Request",
                                 action: #selector(ProjectWindowController.approvePendingRequest(_:)),
                                 keyEquivalent: "y")
        approve.keyEquivalentModifierMask = [.command, .shift]
        paneMenu.addItem(approve)
        let deny = NSMenuItem(title: "Deny Pending Request",
                              action: #selector(ProjectWindowController.denyPendingRequest(_:)),
                              keyEquivalent: "n")
        deny.keyEquivalentModifierMask = [.command, .shift]
        paneMenu.addItem(deny)
        paneMenu.addItem(.separator())
        let close = NSMenuItem(title: "Close Pane",
                               action: #selector(ProjectWindowController.closeFocusedPane(_:)), keyEquivalent: "w")
        close.keyEquivalentModifierMask = [.command, .shift]
        paneMenu.addItem(close)

        // Workspace (cross-project surfaces)
        let workspaceItem = NSMenuItem()
        mainMenu.addItem(workspaceItem)
        let workspaceMenu = NSMenu(title: "Workspace")
        workspaceItem.submenu = workspaceMenu
        let attention = NSMenuItem(title: "Show Attention Queue",
                                   action: #selector(AppDelegate.showAttentionPanel(_:)), keyEquivalent: "a")
        attention.keyEquivalentModifierMask = [.command, .option]
        workspaceMenu.addItem(attention)
        let switcher = NSMenuItem(title: "Show Projects",
                                  action: #selector(AppDelegate.showProjectSwitcher(_:)), keyEquivalent: "p")
        switcher.keyEquivalentModifierMask = [.command, .shift]
        workspaceMenu.addItem(switcher)

        // Window
        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        return mainMenu
    }
}
