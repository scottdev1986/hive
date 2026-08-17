// ShellSidebarView.swift The semantic sidebar: a read-only project/instance context block, then the nav groups. Selecting a row navigates through the dispatcher like any menu route command — the sidebar is one more command surface, never a parallel navigation path.

import AppKit
import WorkspaceCore

final class ShellSidebarView: NSView {

    struct Context: Equatable {
        let projectName: String
        let projectPath: String?
        let instanceLabel: String
    }

    private var navButtons: [ShellRoute: NSButton] = [:]
    var onSelect: (ShellRoute) -> Void

    init(
        context: Context,
        onSelect: @escaping (ShellRoute) -> Void
    ) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        Theme.paint(self, Theme.Chrome.sidebar)

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        stack.setContentHuggingPriority(.defaultLow, for: .vertical)
        stack.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        setContentHuggingPriority(.defaultLow, for: .vertical)
        setContentCompressionResistancePriority(.init(100), for: .vertical)

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.contentView = SidebarClipView()
        scroll.documentView = stack
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.init(100), for: .vertical)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])

        stack.addArrangedSubview(Self.brandBlock())
        stack.setCustomSpacing(Theme.Space.l, after: stack.arrangedSubviews[0])
        let project = CardView()
        let contextBlock = Self.contextBlock(context)
        project.contentStack.addArrangedSubview(contextBlock)
        project.pinToContentWidth(contextBlock)
        stack.addArrangedSubview(project)
        project.widthAnchor.constraint(
            equalTo: stack.widthAnchor, constant: -Theme.Space.m * 2
        ).isActive = true
        stack.setCustomSpacing(Theme.Space.l, after: project)

        for (index, group) in ShellScreenRegistry.groups.enumerated() {
            let groupLabel = NSTextField(labelWithString: group.title.uppercased())
            groupLabel.font = Theme.Font.sectionLabel
            groupLabel.textColor = Theme.Chrome.faint
            stack.addArrangedSubview(groupLabel)
            if index > 0, stack.arrangedSubviews.count >= 2 {
                stack.setCustomSpacing(
                    Theme.Space.m,
                    after: stack.arrangedSubviews[stack.arrangedSubviews.count - 2])
            }
            for route in group.routes {
                let button = Self.navButton(route: route) { [weak self] in
                    self?.onSelect(route)
                }
                navButtons[route] = button
                stack.addArrangedSubview(button)
                button.widthAnchor.constraint(
                    equalTo: stack.widthAnchor, constant: -Theme.Space.m * 2
                ).isActive = true
            }
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Workspace navigation")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The selected row carries a persistent fill and leading edge in addition to the accent tint, so selection is never color alone.
    func select(route: ShellRoute) {
        for (candidate, button) in navButtons {
            let selected = candidate == route
            button.isBordered = false
            button.state = selected ? .on : .off
            button.contentTintColor = selected ? Theme.Chrome.accent : Theme.Chrome.muted
            (button as? ShellNavButton)?.isRouteSelected = selected
        }
    }

    var navButtonsInOrder: [NSButton] {
        ShellNavGroup.allCases.flatMap(\.routes).compactMap { navButtons[$0] }
    }

    private static func brandBlock() -> NSView {
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 22).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let name = NSTextField(labelWithString: "Hive")
        name.font = Theme.Font.title
        name.textColor = Theme.Chrome.text
        let mark = NSTextField(labelWithString: "AGENTIC WORKSPACE")
        mark.font = Theme.Font.sectionLabel
        mark.textColor = Theme.Chrome.muted
        let copy = NSStackView(views: [name, mark])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 1

        let row = NSStackView(views: [icon, copy])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        row.setAccessibilityElement(true)
        row.setAccessibilityRole(.staticText)
        row.setAccessibilityLabel("Hive Agentic Workspace")
        row.setAccessibilityIdentifier("shell-brand")
        return row
    }

    private static func contextBlock(_ context: Context) -> NSView {
        let name = NSTextField(labelWithString: context.projectName)
        name.font = Theme.Font.title
        name.textColor = Theme.Chrome.text
        name.compressHorizontally(priority: 460, toolTip: context.projectName)

        let stack = NSStackView(views: [name])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2

        if let path = context.projectPath {
            let pathLabel = NSTextField(labelWithString: path)
            pathLabel.font = Theme.Font.monoCaption
            pathLabel.textColor = Theme.Chrome.muted
            pathLabel.lineBreakMode = .byTruncatingHead
            pathLabel.compressHorizontally(priority: 450, toolTip: path)
            stack.addArrangedSubview(pathLabel)
        }

        let instance = NSTextField(labelWithString: context.instanceLabel)
        instance.font = Theme.Font.caption
        instance.textColor = Theme.Chrome.faint
        instance.compressHorizontally(priority: 450, toolTip: context.instanceLabel)
        stack.addArrangedSubview(instance)
        return stack
    }

    private static func navButton(
        route: ShellRoute,
        action: @escaping () -> Void
    ) -> NSButton {
        let image = NSImage(
            systemSymbolName: symbol(for: route),
            accessibilityDescription: nil)
        let button = ShellNavButton(
            title: "  \(route.title)",
            image: image ?? NSImage(),
            target: nil,
            action: nil)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.bezelStyle = .rounded
        button.isBordered = false
        button.showsBorderOnlyWhileMouseInside = true
        button.alignment = .left
        button.imagePosition = .imageLeading
        button.font = Theme.Font.body
        button.contentTintColor = Theme.Chrome.muted
        button.heightAnchor.constraint(
            greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight).isActive = true
        button.setAccessibilityLabel("\(route.title), navigation")
        button.setAccessibilityIdentifier("shell-nav-\(route.rawValue)")
        button.setAccessibilityRole(.button)
        button.target = ShellButtonTarget.shared
        button.action = #selector(ShellButtonTarget.fire(_:))
        ShellButtonTarget.shared.register(button, action: action)
        return button
    }

    private static func symbol(for route: ShellRoute) -> String {
        switch route {
        case .liveRun: return "play.rectangle"
        case .taskRouter: return "arrow.triangle.branch"
        case .modelsQuota: return "gauge"
        case .queen: return "crown"
        case .memoryOverview: return "book"
        case .memoryLibrary: return "books.vertical"
        case .memoryRecallLab: return "magnifyingglass"
        case .memoryMaintenance: return "wrench.and.screwdriver"
        }
    }
}

private final class SidebarClipView: NSClipView {
    override var isFlipped: Bool { true }
}

private final class ShellNavButton: NSButton {
    var isRouteSelected = false {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        if isRouteSelected {
            Theme.Chrome.navActive.setFill()
            NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0, dy: 1),
                xRadius: 7,
                yRadius: 7
            ).fill()
            Theme.Chrome.accent.setFill()
            NSBezierPath(
                roundedRect: NSRect(
                    x: 0,
                    y: Theme.Space.xs,
                    width: 2,
                    height: max(0, bounds.height - Theme.Space.s)),
                xRadius: 1,
                yRadius: 1
            ).fill()
        }
        super.draw(dirtyRect)
    }
}
