import Foundation

/// WCAG 2.x relative luminance and contrast ratio.
///
/// WCAG 2.2 is the only normative contrast standard; WCAG 3.0 remains a
/// Working Draft carrying no normative contrast algorithm, so APCA is
/// deliberately not implemented here.
enum WCAGContrast {
    enum ColorError: Error, Equatable {
        case malformedHex(String)
    }

    /// Parses exactly six hex digits. Anything shorter, longer, or containing a
    /// non-hex character is rejected rather than silently truncated — a lenient
    /// parser reports a typo'd entry as a confident pass.
    static func channels(_ hex: String) throws -> (Double, Double, Double) {
        let scalars = Array(hex.utf8)
        guard scalars.count == 6 else { throw ColorError.malformedHex(hex) }
        var value: UInt32 = 0
        for byte in scalars {
            let digit: UInt32
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"):
                digit = UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"):
                digit = UInt32(byte - UInt8(ascii: "a")) + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"):
                digit = UInt32(byte - UInt8(ascii: "A")) + 10
            default:
                throw ColorError.malformedHex(hex)
            }
            value = value << 4 | digit
        }
        return (
            Double((value >> 16) & 0xff) / 255,
            Double((value >> 8) & 0xff) / 255,
            Double(value & 0xff) / 255
        )
    }

    static func relativeLuminance(_ hex: String) throws -> Double {
        let (r, g, b) = try channels(hex)
        func linear(_ c: Double) -> Double {
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    static func ratio(_ a: String, _ b: String) throws -> Double {
        let la = try relativeLuminance(a)
        let lb = try relativeLuminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
