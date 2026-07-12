import AppKit

/// The grouped-inset card every settings surface sits on: rounded continuous
/// corners, a quiet fill over the window background, a hairline stroke.
/// `dashed` marks an unavailable provider (spec §7.4) — a visibly different
/// border that does not rely on color.
class CardView: NSView {

    var dashed: Bool = false {
        didSet { needsDisplay = true }
    }

    let contentStack = NSStackView()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true

        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = Theme.Space.m
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.l),
            contentStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.l),
            contentStack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.l),
            contentStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.l),
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
            NSColor.tertiaryLabelColor.setStroke()
        } else {
            path.lineWidth = 1
            Theme.cardStroke.setStroke()
        }
        path.stroke()
    }

    /// Pin an arranged subview to the card's full content width. Stack views
    /// left-align by default; rows want the whole row.
    func pinToContentWidth(_ view: NSView) {
        view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
    }
}

/// The muted inset block inside a card — the unmetered panel and override
/// notes use it. Secondary grouped fill, never error red (spec §7.5).
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
