// MemoryScreenViews.swift Hosts the four Memory routes. Overview and Library are read-only; Recall sends a query without mutating memory; Maintenance exposes only the daemon's frozen job kinds and leaves editing surfaces out of this read-mostly phase.

import AppKit
import WorkspaceCore

final class MemoryLibraryScreenView: NSView {
    init(screen: ShellScreenProjection) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-library-screen")
        MemoryScreenLayout.install(
            [ShellAvailabilityPanel(
                route: .memoryLibrary, screen: screen, contentInset: 0)], in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryOverviewScreenView: NSView {
    init(screen: ShellScreenProjection) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-overview-screen")
        MemoryScreenLayout.install(
            [ShellAvailabilityPanel(
                route: .memoryOverview, screen: screen, contentInset: 0)], in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryRecallScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        actionsEnabled: Bool,
        onInspect: @escaping (String) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-recall-screen")
        let query = NSTextField(string: "")
        query.placeholderString = "Recall query"
        query.setAccessibilityIdentifier("memory-recall-query")
        let inspect = NSButton(title: "Inspect recall", target: nil, action: nil)
        inspect.isEnabled = actionsEnabled
        inspect.setAccessibilityIdentifier("memory-recall-inspect")
        ShellButtonTarget.shared.register(inspect) {
            let trimmed = query.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            onInspect(trimmed)
        }
        inspect.target = ShellButtonTarget.shared
        inspect.action = #selector(ShellButtonTarget.fire(_:))
        let controls = NSStackView(views: [query, inspect])
        controls.orientation = .horizontal
        controls.spacing = Theme.Space.s
        query.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        MemoryScreenLayout.install(
            [controls, ShellAvailabilityPanel(
                route: .memoryRecallLab, screen: screen, contentInset: 0)],
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryMaintenanceScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        actionsEnabled: Bool,
        onStart: @escaping (MemoryJobKind) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-maintenance-screen")
        let controls = NSStackView()
        controls.orientation = .horizontal
        controls.spacing = Theme.Space.s
        for kind in MemoryJobKind.allCases {
            let button = NSButton(title: kind.title, target: nil, action: nil)
            button.isEnabled = actionsEnabled
            button.setAccessibilityIdentifier("memory-job-\(kind.rawValue)")
            ShellButtonTarget.shared.register(button) { onStart(kind) }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            controls.addArrangedSubview(button)
        }
        MemoryScreenLayout.install(
            [controls, ShellAvailabilityPanel(
                route: .memoryMaintenance, screen: screen, contentInset: 0)],
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

private enum MemoryScreenLayout {
    static func install(_ views: [NSView], in host: NSView) {
        host.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        stack.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(
                equalTo: host.leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: host.trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: host.topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: host.bottomAnchor, constant: -Theme.Space.page),
        ])
        for view in views {
            // The panel is the page; controls beside it keep their own size rather than stretching across the window.
            if view is ShellAvailabilityPanel {
                view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            } else {
                view.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true
            }
        }
    }
}
