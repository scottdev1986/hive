public enum PaneFocusIndicator: Equatable, Sendable {
    case none
    case active
    case inactive
}

/// Resolves the indicator from real focus state, never from the last click. `firstResponderPane` is the pane that actually owns the window's first responder (nil when no pane does).
public func paneFocusIndicator(
    pane: PaneID,
    firstResponderPane: PaneID?,
    windowIsKey: Bool
) -> PaneFocusIndicator {
    guard pane == firstResponderPane else { return .none }
    return windowIsKey ? .active : .inactive
}
