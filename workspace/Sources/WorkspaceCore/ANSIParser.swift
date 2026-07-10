import Foundation

/// A styled run of text produced from ANSI/SGR input. Colors are semantic
/// slots resolved by the view layer to system colors (HIG: semantic colors
/// that adapt to appearance), plus raw truecolor when the stream demands it.
public struct StyledSpan: Equatable {
    public enum Color: Equatable {
        case standard(Int)      // 0–7 (30–37 / 40–47)
        case bright(Int)        // 0–7 (90–97 / 100–107)
        case palette256(Int)    // 0–255
        case rgb(UInt8, UInt8, UInt8)
    }

    public var text: String
    public var foreground: Color?
    public var background: Color?
    public var bold = false
    public var italic = false
    public var underline = false

    public init(text: String, foreground: Color? = nil, background: Color? = nil,
                bold: Bool = false, italic: Bool = false, underline: Bool = false) {
        self.text = text
        self.foreground = foreground
        self.background = background
        self.bold = bold
        self.italic = italic
        self.underline = underline
    }
}

/// Minimal, forgiving SGR parser: understands color/weight/underline SGR
/// sequences, silently drops every other CSI/OSC sequence, and never lets a
/// malformed escape leak into rendered text. Not a terminal emulator — the
/// transcript renders styled logs, it does not host TUIs (SwiftTerm's job later).
public enum ANSIParser {

    private struct State {
        var foreground: StyledSpan.Color?
        var background: StyledSpan.Color?
        var bold = false
        var italic = false
        var underline = false
    }

    public static func parse(_ input: String) -> [StyledSpan] {
        var spans: [StyledSpan] = []
        var state = State()
        var pending = ""

        func flush() {
            guard !pending.isEmpty else { return }
            spans.append(StyledSpan(
                text: pending, foreground: state.foreground, background: state.background,
                bold: state.bold, italic: state.italic, underline: state.underline))
            pending = ""
        }

        let scalars = Array(input.unicodeScalars)
        var i = 0
        while i < scalars.count {
            let scalar = scalars[i]
            guard scalar == "\u{1B}" else {
                pending.unicodeScalars.append(scalar)
                i += 1
                continue
            }
            // Escape sequence
            guard i + 1 < scalars.count else { break } // trailing bare ESC: drop
            let kind = scalars[i + 1]
            if kind == "[" { // CSI
                var j = i + 2
                var params = ""
                while j < scalars.count, !isCSIFinal(scalars[j]) {
                    params.unicodeScalars.append(scalars[j])
                    j += 1
                }
                guard j < scalars.count else { break } // unterminated: drop rest of escape
                let final = scalars[j]
                if final == "m" {
                    flush()
                    applySGR(params: params, to: &state)
                }
                // every other CSI (cursor movement, erase, …) is dropped
                i = j + 1
            } else if kind == "]" { // OSC: consume until BEL or ST
                var j = i + 2
                while j < scalars.count {
                    if scalars[j] == "\u{07}" { j += 1; break }
                    if scalars[j] == "\u{1B}", j + 1 < scalars.count, scalars[j + 1] == "\\" { j += 2; break }
                    j += 1
                }
                i = j
            } else {
                i += 2 // two-character escape (ESC c, ESC 7, …): drop
            }
        }
        flush()
        return spans
    }

    /// Convenience: parsed input with styling discarded (for accessibility
    /// values and searching).
    public static func plainText(_ input: String) -> String {
        parse(input).map(\.text).joined()
    }

    private static func isCSIFinal(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value >= 0x40 && scalar.value <= 0x7E
    }

    private static func applySGR(params: String, to state: inout State) {
        var codes = params.split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) ?? 0 }
        if codes.isEmpty { codes = [0] }

        var index = 0
        while index < codes.count {
            let code = codes[index]
            switch code {
            case 0: state = State()
            case 1: state.bold = true
            case 3: state.italic = true
            case 4: state.underline = true
            case 22: state.bold = false
            case 23: state.italic = false
            case 24: state.underline = false
            case 30...37: state.foreground = .standard(code - 30)
            case 39: state.foreground = nil
            case 40...47: state.background = .standard(code - 40)
            case 49: state.background = nil
            case 90...97: state.foreground = .bright(code - 90)
            case 100...107: state.background = .bright(code - 100)
            case 38, 48:
                let isForeground = code == 38
                if index + 1 < codes.count, codes[index + 1] == 5, index + 2 < codes.count {
                    let value = min(max(codes[index + 2], 0), 255)
                    if isForeground { state.foreground = .palette256(value) }
                    else { state.background = .palette256(value) }
                    index += 2
                } else if index + 1 < codes.count, codes[index + 1] == 2, index + 4 < codes.count {
                    let r = UInt8(clamping: codes[index + 2])
                    let g = UInt8(clamping: codes[index + 3])
                    let b = UInt8(clamping: codes[index + 4])
                    if isForeground { state.foreground = .rgb(r, g, b) }
                    else { state.background = .rgb(r, g, b) }
                    index += 4
                }
            default:
                break // unknown SGR: ignore
            }
            index += 1
        }
    }
}
