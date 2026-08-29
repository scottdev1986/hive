import Foundation

/// Terminal pixel/cell geometry reported by Ghostty.
public struct TerminalGeometry: Equatable, Sendable, Encodable {
    public var columns: Int
    public var rows: Int
    public var widthPx: Int
    public var heightPx: Int
    public var cellWidthPx: Double
    public var cellHeightPx: Double

    public init(
        columns: Int,
        rows: Int,
        widthPx: Int,
        heightPx: Int,
        cellWidthPx: Double,
        cellHeightPx: Double
    ) {
        self.columns = columns
        self.rows = rows
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.cellWidthPx = cellWidthPx
        self.cellHeightPx = cellHeightPx
    }

    public var isUsable: Bool {
        columns > 0 && rows > 0 && widthPx > 0 && heightPx > 0
    }
}

public enum TerminalSurfaceState: Equatable, Sendable {
    case starting
    case live
    case exited(evidence: String)
    case lost(evidence: String)
    case rendererFailed(evidence: String)

    public var isFailure: Bool {
        switch self {
        case .starting, .live:
            return false
        default:
            return true
        }
    }
}

public enum InputSubmissionState: Equatable, Sendable {
    case idle
}
