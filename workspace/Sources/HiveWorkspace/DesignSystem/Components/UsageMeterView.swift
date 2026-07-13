import AppKit
import WorkspaceCore

/// One usage window: label, track, value, reset caption.
///
/// The honesty contract is structural here (spec §7.6):
/// - `.measured` draws a determinate fill; "0% used" only ever means a real 0.
/// - `.unknown` draws NO track at all — a dotted rule and "Usage unknown".
///   There is no code path that renders an empty bar for missing data.
/// - `.stale` keeps the last percent at reduced contrast, with its age,
///   under a "Stale reading" badge. Never presented as fresh.
final class UsageMeterView: NSView {

    private let titleLabel = NSTextField(labelWithString: "")
    private let valueLabel = NSTextField(labelWithString: "")
    private let captionLabel = NSTextField(labelWithString: "")
    private let track = MeterTrackView()
    private var badge: NSView?
    private let topRow = NSStackView()
    private let stack = NSStackView()

    /// Near-limit thresholds as fractions of REMAINING (spec §3.3). These are
    /// the shipped config defaults; a later read surface can carry live values.
    private let warningRemainingPct: Double
    private let criticalRemainingPct: Double

    init(warningRemainingPct: Double = 0.25, criticalRemainingPct: Double = 0.1) {
        self.warningRemainingPct = warningRemainingPct
        self.criticalRemainingPct = criticalRemainingPct
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = Theme.Font.caption
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        valueLabel.font = Theme.Font.monoDigits
        valueLabel.textColor = .labelColor
        valueLabel.alignment = .right
        valueLabel.lineBreakMode = .byTruncatingTail
        captionLabel.font = Theme.Font.caption
        captionLabel.textColor = .tertiaryLabelColor
        captionLabel.lineBreakMode = .byWordWrapping
        captionLabel.maximumNumberOfLines = 3

        // AppKit may grow the window instead of truncating a label at 500 or
        // higher. Every label in this width-constrained component stays below it.
        titleLabel.setContentCompressionResistancePriority(.init(490), for: .horizontal)
        valueLabel.setContentCompressionResistancePriority(.init(490), for: .horizontal)
        captionLabel.setContentCompressionResistancePriority(.init(200), for: .horizontal)
        valueLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        topRow.orientation = .horizontal
        topRow.alignment = .firstBaseline
        topRow.spacing = Theme.Space.s
        topRow.addArrangedSubview(titleLabel)
        topRow.addArrangedSubview(NSView.spacer())
        topRow.addArrangedSubview(valueLabel)

        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        stack.addArrangedSubview(topRow)
        stack.addArrangedSubview(track)
        stack.addArrangedSubview(captionLabel)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            topRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            track.widthAnchor.constraint(equalTo: stack.widthAnchor),
            captionLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func apply(window: MeterWindow, now: Date = Date()) {
        titleLabel.stringValue = window.label
        badge?.removeFromSuperview()
        badge = nil

        switch window.state {
        case .measured(let usedPercent, let resetsAt, _, _):
            let percent = Int(usedPercent.rounded())
            track.state = .fill(
                fraction: usedPercent / 100,
                color: fillColor(usedPercent: usedPercent))
            valueLabel.stringValue = MCCCopy.meterUsedPct(percent)
            valueLabel.textColor = .labelColor
            captionLabel.stringValue = resetsAt.map {
                MCCCopy.meterResetsIn(Self.relative(from: now, to: $0))
            } ?? ""
            captionLabel.isHidden = captionLabel.stringValue.isEmpty
            let remaining = (100 - usedPercent) / 100
            if remaining <= criticalRemainingPct {
                attach(badge: CapsuleBadge(
                    text: MCCCopy.badgeCritical,
                    symbol: "exclamationmark.octagon.fill", style: .critical))
            } else if remaining <= warningRemainingPct {
                attach(badge: CapsuleBadge(
                    text: MCCCopy.badgeNearLimit,
                    symbol: "exclamationmark.triangle.fill", style: .warning))
            }
            setAccessibilityLabel(MCCCopy.a11yMeter(window.label, percent))

        case .stale(let usedPercent, let observedAt, _):
            let percent = Int(usedPercent.rounded())
            track.state = .fill(
                fraction: usedPercent / 100,
                color: Theme.meterUnknownHatch)
            valueLabel.stringValue = MCCCopy.meterUsedPct(percent)
            valueLabel.textColor = .secondaryLabelColor
            let age = observedAt.map { Self.relative(from: $0, to: now) } ?? "unknown time"
            captionLabel.stringValue = MCCCopy.meterStaleAge(age)
            captionLabel.isHidden = false
            attach(badge: CapsuleBadge(
                text: MCCCopy.badgeUsageStale, symbol: "clock.arrow.circlepath",
                style: .warning))
            setAccessibilityLabel(
                "\(MCCCopy.a11yMeter(window.label, percent)), stale reading")

        case .unknown(let reason):
            // No determinate track. The truth is "we cannot tell", and a bar —
            // even an empty one — would claim measured emptiness.
            track.isHidden = false
            track.state = .indeterminate
            valueLabel.stringValue = MCCCopy.badgeUsageUnknown
            valueLabel.textColor = .secondaryLabelColor
            captionLabel.stringValue = reason.isEmpty ? MCCCopy.meterUnknownBody : reason
            captionLabel.isHidden = false
            setAccessibilityLabel(MCCCopy.a11yMeterUnknown(window.label))

        case .notMetered:
            // No track AT ALL — not even the indeterminate one, which reads as
            // "unknown" and would blame a probe that answered. The plan has no
            // such window, so there is nothing to gauge and we say so instead.
            track.isHidden = true
            valueLabel.stringValue = MCCCopy.badgeNotMetered
            valueLabel.textColor = .secondaryLabelColor
            captionLabel.stringValue = MCCCopy.meterNotMeteredBody(window.label)
            captionLabel.isHidden = false
            setAccessibilityLabel("\(window.label), not metered on this plan")
        }
        titleLabel.toolTip = titleLabel.stringValue
        valueLabel.toolTip = valueLabel.stringValue
        captionLabel.toolTip = captionLabel.stringValue
    }

    private func fillColor(usedPercent: Double) -> NSColor {
        let remaining = (100 - usedPercent) / 100
        if remaining <= criticalRemainingPct { return Theme.meterFillCritical }
        if remaining <= warningRemainingPct { return Theme.meterFillWarning }
        return Theme.meterFillHealthy
    }

    private func attach(badge: NSView) {
        self.badge = badge
        topRow.insertArrangedSubview(badge, at: 1)
    }

    static func relative(from: Date, to: Date) -> String {
        let seconds = abs(to.timeIntervalSince(from))
        if seconds < 90 { return "\(Int(seconds))s" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 {
            let rest = minutes % 60
            return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
        }
        return "\(hours / 24)d"
    }
}

/// The meter's track. Three drawing modes and no fourth:
/// a colored fill over the track, or a dotted "cannot tell" rule with no
/// track at all. `fraction == 0` still draws the track (measured empty);
/// `.indeterminate` draws no track (unknown) — visibly different things.
final class MeterTrackView: NSView {

    enum State: Equatable {
        case fill(fraction: Double, color: NSColor)
        case indeterminate
    }

    var state: State = .indeterminate {
        didSet { needsDisplay = true }
    }

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: Theme.Metric.meterTrackHeight).isActive = true
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        switch state {
        case .fill(let fraction, let color):
            let track = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
            Theme.meterTrack.setFill()
            track.fill()
            let clamped = max(0, min(1, fraction))
            guard clamped > 0 else { return }
            let width = max(bounds.height, bounds.width * clamped)
            let fillRect = NSRect(x: 0, y: 0, width: width, height: bounds.height)
            let fill = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
            color.setFill()
            fill.fill()
        case .indeterminate:
            // Dots, not a bar: nothing here can be read as a fill level.
            let dotDiameter: CGFloat = 3
            let gap: CGFloat = 6
            let y = (bounds.height - dotDiameter) / 2
            var x: CGFloat = 1
            Theme.meterUnknownHatch.setFill()
            while x + dotDiameter < bounds.width {
                NSBezierPath(ovalIn: NSRect(
                    x: x, y: y, width: dotDiameter, height: dotDiameter)).fill()
                x += dotDiameter + gap
            }
        }
    }
}

extension NSView {
    /// A zero-content flexible spacer for stack views.
    static func spacer() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentHuggingPriority(.init(1), for: .horizontal)
        view.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return view
    }
}
