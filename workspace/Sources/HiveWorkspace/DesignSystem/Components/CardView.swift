import AppKit

class CardView: NSView {

    var dashed: Bool = false {
        didSet { needsDisplay = true }
    }

    let contentStack = NSStackView()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        setAccessibilityIdentifier("hds-card")

        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = Theme.Space.m
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(
                equalTo: leadingAnchor, constant: Theme.Metric.cardInset),
            contentStack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Metric.cardInset),
            contentStack.topAnchor.constraint(
                equalTo: topAnchor, constant: Theme.Metric.cardInset),
            contentStack.bottomAnchor.constraint(
                equalTo: bottomAnchor, constant: -Theme.Metric.cardInset),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ dirtyRect: NSRect) {
        let radius = Theme.Metric.cardCornerRadius
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
        Theme.cardFill.setFill()
        path.fill()
        if dashed {
            path.setLineDash([4, 3], count: 2, phase: 0)
            path.lineWidth = 1
            Theme.tertiaryText.setStroke()
        } else {
            path.lineWidth = 1
            Theme.cardStroke.setStroke()
        }
        path.stroke()
    }

    func pinToContentWidth(_ view: NSView) {
        view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
    }
}

/// The muted inset block inside a card — the unmetered panel and override notes use it. Secondary grouped fill, never error red.
class InsetPanelView: NSView {

    let contentStack = NSStackView()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.insetCornerRadius
        layer?.cornerCurve = .continuous

        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = Theme.Space.s
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.m),
            contentStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.m),
            contentStack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.m),
            contentStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.m),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = Theme.insetFill.cgColor
    }
}

extension NSBox {
    /// A hairline separator that never absorbs a stretched stack's surplus space (a stretched NSBox floats its 1 px line mid-gap, which reads as broken layout).
    static func hdsSeparator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        box.setContentHuggingPriority(.required, for: .vertical)
        return box
    }

    /// A 1-point vertical edge for a horizontal row. Vertical hugging stays
    /// below windowSizeStayPut so the box's 1-point intrinsic height cannot
    /// become the window's fitting height.
    static func hdsVerticalDivider() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        box.setContentHuggingPriority(.defaultLow, for: .vertical)
        box.widthAnchor.constraint(equalToConstant: 1).isActive = true
        return box
    }
}
