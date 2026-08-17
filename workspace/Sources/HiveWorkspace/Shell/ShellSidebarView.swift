import AppKit
import WorkspaceCore

// ShellSidebarView.swift
//
// Renders project identity and every declared route in one compact navigation
// rail. Selection still travels through the shell dispatcher; the sidebar does
// not own a second navigation state.

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
        wantsLayer = true
        setAccessibilityIdentifier("shell-sidebar")

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])

        let contextBlock = SidebarContextView(context: context)
        stack.addArrangedSubview(contextBlock)
        contextBlock.widthAnchor.constraint(
            equalTo: stack.widthAnchor, constant: -16).isActive = true
        stack.setCustomSpacing(14, after: contextBlock)

        for (index, group) in ShellScreenRegistry.groups.enumerated() {
            let groupLabel = NSTextField(labelWithString: group.title.uppercased())
            groupLabel.font = Theme.Font.chromeGroup
            groupLabel.textColor = Theme.tertiaryText
            groupLabel.setAccessibilityIdentifier(
                "shell-nav-group-\(group.title.lowercased().replacingOccurrences(of: " ", with: "-"))")
            if index > 0, let previous = stack.arrangedSubviews.last {
                stack.setCustomSpacing(12, after: previous)
            }
            stack.addArrangedSubview(groupLabel)
            groupLabel.widthAnchor.constraint(
                equalTo: stack.widthAnchor, constant: -16).isActive = true
            stack.setCustomSpacing(4, after: groupLabel)

            for route in group.routes {
                let button = Self.navButton(route: route) { [weak self] in
                    self?.onSelect(route)
                }
                navButtons[route] = button
                stack.addArrangedSubview(button)
                button.widthAnchor.constraint(
                    equalTo: stack.widthAnchor, constant: -16).isActive = true
            }
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Workspace navigation")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = Theme.sidebarFill.cgColor
    }

    /// Selection has both a filled row and a leading rule, so its meaning does
    /// not depend on teal text alone.
    func select(route: ShellRoute) {
        for (candidate, button) in navButtons {
            let selected = candidate == route
            button.isBordered = false
            button.state = selected ? .on : .off
            button.contentTintColor = selected ? Theme.accent : Theme.secondaryText
            (button as? ShellNavButton)?.isRouteSelected = selected
        }
    }

    var navButtonsInOrder: [NSButton] {
        ShellNavGroup.allCases.flatMap(\.routes).compactMap { navButtons[$0] }
    }

    private static func navButton(
        route: ShellRoute,
        action: @escaping () -> Void
    ) -> NSButton {
        let image = NSImage(
            systemSymbolName: symbol(for: route),
            accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
        let button = ShellNavButton(
            title: route.title,
            image: image ?? NSImage(),
            target: nil,
            action: nil)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.isBordered = false
        button.alignment = .left
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
        button.font = Theme.Font.chromeNav
        button.contentTintColor = Theme.secondaryText
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
        case .modelsQuota: return "square.grid.2x2"
        case .queen: return "crown"
        case .memoryOverview: return "circle.hexagongrid"
        case .memoryLibrary: return "rectangle.stack"
        case .memoryRecallLab: return "magnifyingglass"
        case .memoryMaintenance: return "sparkles"
        }
    }
}

private final class SidebarContextView: NSView {

    init(context: ShellSidebarView.Context) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.insetCornerRadius
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1

        let name = NSTextField(labelWithString: context.projectName)
        name.font = Theme.Font.chromeProject
        name.textColor = Theme.primaryText
        name.compressHorizontally(priority: 460, toolTip: context.projectName)

        let stack = NSStackView(views: [name])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        if let path = context.projectPath {
            let abbreviated = (path as NSString).abbreviatingWithTildeInPath
            let pathLabel = NSTextField(labelWithString: abbreviated)
            pathLabel.font = Theme.Font.chromeMetadata
            pathLabel.textColor = Theme.secondaryText
            pathLabel.lineBreakMode = .byTruncatingHead
            pathLabel.compressHorizontally(priority: 450, toolTip: path)
            stack.addArrangedSubview(pathLabel)
        }
        let instance = NSTextField(labelWithString: context.instanceLabel)
        instance.font = Theme.Font.chromeMetadata
        instance.textColor = Theme.tertiaryText
        instance.compressHorizontally(priority: 450, toolTip: context.instanceLabel)
        stack.addArrangedSubview(instance)

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("shell-project-context")
        setAccessibilityLabel(
            [context.projectName, context.projectPath, context.instanceLabel]
                .compactMap { $0 }.joined(separator: ", "))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = Theme.sidebarContextFill.cgColor
        layer?.borderColor = Theme.cardStroke.cgColor
    }
}

private final class ShellNavButton: NSButton {
    var isRouteSelected = false {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        if isRouteSelected {
            Theme.accentFill.setFill()
            NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0, dy: 1),
                xRadius: Theme.Metric.buttonCornerRadius,
                yRadius: Theme.Metric.buttonCornerRadius
            ).fill()
            Theme.accent.setFill()
            NSBezierPath(
                roundedRect: NSRect(x: 0, y: 5, width: 2, height: bounds.height - 10),
                xRadius: 1,
                yRadius: 1
            ).fill()
        }
        super.draw(dirtyRect)
    }
}
