
import AppKit

final class ShellButtonAction: NSObject {
    let fire: () -> Void

    init(_ fire: @escaping () -> Void) {
        self.fire = fire
    }
}

final class ShellButtonTarget: NSObject {
    static let shared = ShellButtonTarget()

    private let actions = NSMapTable<NSButton, ShellButtonAction>.weakToStrongObjects()

    func register(_ button: NSButton, action: @escaping () -> Void) {
        actions.setObject(ShellButtonAction(action), forKey: button)
    }

    @objc func fire(_ sender: NSButton) {
        actions.object(forKey: sender)?.fire()
    }
}
