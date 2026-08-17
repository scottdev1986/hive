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
        Theme.Chrome.panel2.setFill()
        path.fill()
        if dashed {
            path.setLineDash([4, 3], count: 2, phase: 0)
            path.lineWidth = 1
            Theme.Chrome.faint.setStroke()
        } else {
            path.lineWidth = 1
            Theme.Chrome.line.setStroke()
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
}
