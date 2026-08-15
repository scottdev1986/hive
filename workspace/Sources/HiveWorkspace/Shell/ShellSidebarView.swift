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

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])

        stack.addArrangedSubview(Self.contextBlock(context))
        stack.setCustomSpacing(Theme.Space.l, after: stack.arrangedSubviews[0])

        for (index, group) in ShellScreenRegistry.groups.enumerated() {
            let groupLabel = NSTextField(labelWithString: group.title.uppercased())
            groupLabel.font = Theme.Font.sectionLabel
            groupLabel.textColor = .tertiaryLabelColor
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
            button.contentTintColor = selected ? .controlAccentColor : .labelColor
            (button as? ShellNavButton)?.isRouteSelected = selected
        }
    }

    var navButtonsInOrder: [NSButton] {
        ShellNavGroup.allCases.flatMap(\.routes).compactMap { navButtons[$0] }
    }

    private static func contextBlock(_ context: Context) -> NSView {
        let name = NSTextField(labelWithString: context.projectName)
        name.font = Theme.Font.title
        name.compressHorizontally(priority: 460, toolTip: context.projectName)

        let stack = NSStackView(views: [name])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2

        if let path = context.projectPath {
            let pathLabel = NSTextField(labelWithString: path)
            pathLabel.font = Theme.Font.monoCaption
            pathLabel.textColor = .secondaryLabelColor
            pathLabel.lineBreakMode = .byTruncatingHead
            pathLabel.compressHorizontally(priority: 450, toolTip: path)
            stack.addArrangedSubview(pathLabel)
        }

        let instance = NSTextField(labelWithString: context.instanceLabel)
        instance.font = Theme.Font.caption
        instance.textColor = .tertiaryLabelColor
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
        button.contentTintColor = .labelColor
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

private final class ShellNavButton: NSButton {
    var isRouteSelected = false {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        if isRouteSelected {
            NSColor.controlAccentColor.withAlphaComponent(0.14).setFill()
            NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0, dy: 1),
                xRadius: 7,
                yRadius: 7
            ).fill()
            NSColor.controlAccentColor.setFill()
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
