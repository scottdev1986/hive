
import AppKit
import WorkspaceCore

final class ShellAvailabilityPanel: NSView {

    init(
        route: ShellRoute,
        screen: ShellScreenProjection,
        contentInset: CGFloat = Theme.Space.page
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: contentInset),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -contentInset),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: contentInset),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: bottomAnchor, constant: -contentInset),
        ])

        let title = NSTextField(labelWithString: route.title)
        title.font = Theme.Font.largeTitle
        title.compressHorizontally(priority: 460, toolTip: route.title)
        stack.addArrangedSubview(title)

        let badge = CapsuleBadge(
            text: screen.stateHeadline,
            symbol: Self.stateSymbol(for: screen.availability),
            style: Self.stateStyle(for: screen.availability))
        stack.addArrangedSubview(badge)

        let explanation = NSTextField(wrappingLabelWithString: screen.stateExplanation)
        explanation.font = Theme.Font.body
        explanation.textColor = .secondaryLabelColor
        explanation.maximumNumberOfLines = 0
        stack.addArrangedSubview(explanation)
        explanation.widthAnchor.constraint(lessThanOrEqualToConstant: 560).isActive = true
        explanation.widthAnchor.constraint(
            lessThanOrEqualTo: stack.widthAnchor).isActive = true

        if let observedAt = screen.observedAt {
            let observed = NSTextField(labelWithString: "Observed at \(observedAt)")
            observed.font = Theme.Font.caption
            observed.textColor = .tertiaryLabelColor
            observed.compressHorizontally(priority: 460, toolTip: observedAt)
            stack.addArrangedSubview(observed)
        }

        if !screen.facts.isEmpty {
            stack.addArrangedSubview(NSBox.hdsSeparator())
            let factsCard = CardView()
            for fact in screen.facts {
                let row = NSStackView()
                row.orientation = .horizontal
                row.spacing = Theme.Space.s
                let label = NSTextField(labelWithString: fact.label)
                label.font = Theme.Font.callout
                label.textColor = .secondaryLabelColor
                label.compressHorizontally(priority: 470, toolTip: fact.label)
                let value = NSTextField(wrappingLabelWithString: fact.value)
                value.font = Theme.Font.monoBody
                value.textColor = .labelColor
                value.compressHorizontally(priority: 460, toolTip: fact.value)
                row.addArrangedSubview(label)
                row.addArrangedSubview(value)
                factsCard.contentStack.addArrangedSubview(row)
                factsCard.pinToContentWidth(row)
            }
            stack.addArrangedSubview(factsCard)
            factsCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("shell-screen-\(route.rawValue)")
        setAccessibilityLabel(
            "\(route.title): \(screen.stateHeadline). \(screen.stateExplanation)")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private static func stateStyle(for availability: ProjectionAvailability) -> CapsuleBadge.Style {
        switch availability {
        case .current: return .neutral
        case .unknown, .stale, .replaced: return .info
        case .disconnected, .conflicting: return .warning
        case .unauthorized: return .critical
        }
    }

    private static func stateSymbol(for availability: ProjectionAvailability) -> String {
        switch availability {
        case .current: return "checkmark.circle.fill"
        case .unknown: return "questionmark.circle.fill"
        case .stale: return "clock.fill"
        case .disconnected: return "bolt.horizontal.circle.fill"
        case .unauthorized: return "lock.fill"
        case .conflicting: return "arrow.triangle.branch"
        case .replaced: return "arrow.uturn.right.circle.fill"
        }
    }
}
