
import AppKit
import WorkspaceCore

enum ShellProviderProbeRefreshState: Equatable {
    case idle
    case refreshing
    case succeeded(String)
    case failed(String)
}

final class ModelsQuotaScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        view: WorkspaceModelControlView?,
        mutationsAllowed: Bool,
        probeState: ShellProviderProbeRefreshState,
        onProbe: @escaping () -> Void,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let panel = ShellAvailabilityPanel(
            route: .modelsQuota, screen: screen, contentInset: 0)
        let probeTitle = probeState == .refreshing
            ? "Refreshing provider probes…"
            : "Refresh provider probes"
        let probe = NSButton(title: probeTitle, target: nil, action: nil)
        probe.bezelStyle = .rounded
        probe.isEnabled = probeState != .refreshing
        probe.setAccessibilityIdentifier("models-quota-probe-refresh")
        ShellButtonTarget.shared.register(probe, action: onProbe)
        probe.target = ShellButtonTarget.shared
        probe.action = #selector(ShellButtonTarget.fire(_:))

        let stack = NSStackView(views: [panel, probe])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        stack.translatesAutoresizingMaskIntoConstraints = false
        switch probeState {
        case .idle, .refreshing:
            break
        case .succeeded(let message), .failed(let message):
            let status = NSTextField(labelWithString: message)
            status.font = Theme.Font.caption
            status.textColor = probeState.isFailure
                ? .systemRed
                : .secondaryLabelColor
            status.setAccessibilityIdentifier(
                probeState.isFailure
                    ? "models-quota-probe-error"
                    : "models-quota-probe-status")
            stack.addArrangedSubview(status)
        }
        if let view {
            let meters = CardView()
            for row in Self.meterRows(view: view) {
                meters.contentStack.addArrangedSubview(row)
                meters.pinToContentWidth(row)
            }
            stack.addArrangedSubview(meters)
            meters.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            let card = CardView()
            for view in Self.enablementRows(
                view: view,
                writable: mutationsAllowed,
                onWrite: onWrite)
            {
                card.contentStack.addArrangedSubview(view)
                card.pinToContentWidth(view)
            }
            stack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: bottomAnchor, constant: -Theme.Space.page),
            panel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// One meter per provider window exactly as the daemon presented it.
    private static func meterRows(view: WorkspaceModelControlView) -> [NSView] {
        var views: [NSView] = []
        for provider in view.providerIDs {
            let usage = view.provider(provider)?.usage.rendered
                ?? ProviderUsage.unknown(reason: "daemon presentation missing")
            guard case .metered(let windows) = usage else {
                let label = NSTextField(labelWithString:
                    "\(provider.rawValue): \(Self.describe(usage))")
                label.font = Theme.Font.caption
                label.textColor = .secondaryLabelColor
                label.setAccessibilityIdentifier("models-quota-usage-\(provider.rawValue)")
                views.append(label)
                continue
            }
            for window in windows {
                let meter = UsageMeterView()
                meter.apply(window: window)
                meter.setAccessibilityIdentifier(
                    "models-quota-meter-\(provider.rawValue)-\(window.label)")
                views.append(meter)
            }
        }
        return views
    }

    private static func describe(_ usage: ProviderUsage) -> String {
        switch usage {
        case .metered: return "metered"
        case .silent(let reason): return "no reading — \(reason)"
        case .unmetered: return "this vendor publishes no capacity surface"
        case .unknown(let reason): return "unknown — \(reason)"
        }
    }

    /// One row per provider, then one per model its catalog advertises. A provider Hive could not read shows the measured reason instead of an empty model list, so an unreadable vendor never looks like a vendor with nothing in it.
    private static func enablementRows(
        view: WorkspaceModelControlView,
        writable: Bool,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) -> [NSView] {
        var views: [NSView] = []
        for provider in view.providerIDs {
            let state = view.routing.providerState(provider)
            views.append(toggle(
                identifier: "models-quota-provider-\(provider.rawValue)",
                title: provider.rawValue,
                detail: state ?? "policy unavailable",
                on: state == "enabled",
                enabled: writable,
                indent: 0,
                write: .provider(provider, enabled: state != "enabled"),
                onWrite: onWrite))
            switch view.provider(provider)?.catalogState {
            case "available":
                for model in view.provider(provider)?.models ?? [] {
                    let reading = view.routing.modelState(
                        provider: provider, model: model.canonicalId)
                    views.append(toggle(
                        identifier: "models-quota-model-"
                            + "\(provider.rawValue)-\(model.canonicalId)",
                        title: model.canonicalId,
                        detail: reading.map { "\($0.state) via \($0.source)" }
                            ?? "policy unavailable",
                        on: reading?.state == "enabled",
                        enabled: writable,
                        indent: Theme.Space.l,
                        write: .model(
                            provider,
                            model: model.canonicalId,
                            enabled: reading?.state != "enabled"),
                        onWrite: onWrite))
                }
            case "unavailable":
                let label = NSTextField(labelWithString:
                    view.provider(provider)?.catalogReason
                        ?? "The daemon did not provide a model catalog.")
                label.font = Theme.Font.caption
                label.textColor = .secondaryLabelColor
                label.setAccessibilityIdentifier(
                    "models-quota-catalog-\(provider.rawValue)")
                views.append(label)
            default:
                break
            }
        }
        return views
    }

    private static func toggle(
        identifier: String,
        title: String,
        detail: String,
        on: Bool,
        enabled: Bool,
        indent: CGFloat,
        write: ShellPolicyWrite,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) -> NSView {
        let button = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        button.state = on ? .on : .off
        button.isEnabled = enabled
        button.setAccessibilityIdentifier(identifier)
        ShellButtonTarget.shared.register(button) { onWrite(write) }
        button.target = ShellButtonTarget.shared
        button.action = #selector(ShellButtonTarget.fire(_:))

        let reading = NSTextField(labelWithString: detail)
        reading.font = Theme.Font.caption
        reading.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [button, reading])
        stack.orientation = .horizontal
        stack.spacing = Theme.Space.s
        stack.edgeInsets = NSEdgeInsets(top: 0, left: indent, bottom: 0, right: 0)
        return stack
    }
}

private extension ShellProviderProbeRefreshState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}
