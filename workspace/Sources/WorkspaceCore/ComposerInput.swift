import Foundation

/// The user-visible composer transition represented by one terminal input.
/// Delivery protection begins before an edit reaches the PTY and ends only
/// after a submit or cancellation has reached it.
public enum ComposerInputAction: Equatable {
    case editing
    case submitted
    case cancelled
    case ignored
}

public func classifyComposerInput(
    characters: String,
    command: Bool = false,
    control: Bool = false
) -> ComposerInputAction {
    if characters == "\r" || characters == "\n" {
        return .submitted
    }
    if characters == "\u{1b}" || characters == "\u{3}" || characters == "\u{15}" {
        return .cancelled
    }
    if control {
        let lowered = characters.lowercased()
        if lowered == "c" || lowered == "u" { return .cancelled }
    }
    if command {
        return characters.lowercased() == "v" ? .editing : .ignored
    }
    guard !characters.isEmpty else { return .ignored }
    if characters.unicodeScalars.allSatisfy({ (0xF700...0xF8FF).contains(Int($0.value)) }) {
        return .ignored
    }
    return .editing
}
