/// How one pane's focus indicator must read, given who actually holds the
/// keyboard and whether the window is key.
///
/// The honesty rule lives here: a pane can hold first responder while the
/// window is not key — focus is real, but keystrokes are going to another app.
/// That state gets its own, visibly quieter indicator. A vivid "active" ring on
/// a window that receives no input is a confident lie, and the user acts on it.
public enum PaneFocusIndicator: Equatable, Sendable {
    /// Not the first responder's pane: no ring.
    case none
    /// Holds first responder in the key window — keystrokes land here.
    case active
    /// Holds first responder, but the window is not key: nothing is being typed
    /// into it right now.
    case inactive
}

/// Resolves the indicator from real focus state, never from the last click.
/// `firstResponderPane` is the pane that actually owns the window's first
/// responder (nil when no pane does).
public func paneFocusIndicator(
    pane: PaneID,
    firstResponderPane: PaneID?,
    windowIsKey: Bool
) -> PaneFocusIndicator {
    guard pane == firstResponderPane else { return .none }
    return windowIsKey ? .active : .inactive
}
