import AppKit
import WorkspaceCore

/// Aggregates every project's attention queue into one severity+time ordered
/// list, and shows it as a native panel. Selecting an item activates its
/// project and pane — activation is focus only and never approves, dismisses,
/// or clears the item.
final class AttentionCenter: NSObject {

    private var states: [ProjectState] = []
    var activateHandler: ((ProjectID, PaneID) -> Void)?
    private var panel: NSPanel?
    private let tableView = NSTableView()
    private var orderedCache: [AttentionItem] = []

    func register(state: ProjectState) {
        states.append(state)
    }

    func orderedItems() -> [AttentionItem] {
        var queue = AttentionQueue()
        for state in states {
            for item in state.attention.ordered {
                queue.raise(item)
            }
        }
        return queue.ordered
    }

    func refresh() {
        orderedCache = orderedItems()
        tableView.reloadData()
    }

    func showPanel() {
        if panel == nil {
            buildPanel()
        }
        refresh()
        panel?.makeKeyAndOrderFront(nil)
    }

    private func buildPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 320),
            styleMask: [.titled, .closable, .utilityWindow, .resizable],
            backing: .buffered, defer: false)
        panel.title = "Attention"
        panel.isFloatingPanel = true

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.rowHeight = 44
        tableView.style = .inset
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        tableView.doubleAction = #selector(activateSelectedItem)
        tableView.setAccessibilityLabel("Attention queue")

        let scroll = NSScrollView()
        scroll.documentView = tableView
        scroll.hasVerticalScroller = true
        panel.contentView = scroll
        panel.center()
        self.panel = panel
    }

    @objc private func activateSelectedItem() {
        let row = tableView.clickedRow >= 0 ? tableView.clickedRow : tableView.selectedRow
        guard row >= 0, row < orderedCache.count else { return }
        let item = orderedCache[row]
        activateHandler?(item.projectID, item.paneID)
    }
}

extension AttentionCenter: NSTableViewDataSource, NSTableViewDelegate {

    func numberOfRows(in tableView: NSTableView) -> Int {
        orderedCache.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < orderedCache.count else { return nil }
        let item = orderedCache[row]

        let cell = NSTableCellView()
        let icon = NSImageView(image: NSImage(systemSymbolName: Theme.severitySymbol(for: item.severity),
                                              accessibilityDescription: nil)!)
        icon.contentTintColor = Theme.severityColor(for: item.severity)
        icon.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: item.title)
        title.font = Theme.headerFont
        title.lineBreakMode = .byTruncatingTail
        title.compressHorizontally(toolTip: item.title)
        title.translatesAutoresizingMaskIntoConstraints = false

        let detailText = "\(item.projectID.raw) · \(item.detail)"
        let detail = NSTextField(labelWithString: detailText)
        detail.font = Theme.captionFont
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        detail.compressHorizontally(priority: 200, toolTip: detailText)
        detail.translatesAutoresizingMaskIntoConstraints = false

        cell.addSubview(icon)
        cell.addSubview(title)
        cell.addSubview(detail)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            icon.heightAnchor.constraint(equalToConstant: 18),

            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            title.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            title.topAnchor.constraint(equalTo: cell.topAnchor, constant: 5),

            detail.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            detail.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 1),
        ])
        cell.setAccessibilityLabel("\(item.title), \(item.detail)")
        return cell
    }
}
