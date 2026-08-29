import AppKit
import Foundation

public struct ManualSurfaceSemanticRow: Equatable {
    public let utf8Range: NSRange
    public let utf16Range: NSRange
    public let lineBreakUTF8Length: Int
    public let lineBreakUTF16Length: Int
    public let cellUTF16Offsets: [Int]
}

public struct ManualSurfaceSemanticSelection: Equatable {
    public let text: String
    public let visibleUTF16Range: NSRange?
    public let isRectangular: Bool
    public let rangeIsClipped: Bool
}

public struct ManualSurfaceSemanticCursor: Equatable {
    public let utf16Offset: Int?
    public let line: Int?
    public let column: Int
    public let row: Int
    public let framePixels: NSRect
    public let isVisible: Bool
    public let isPendingWrap: Bool
}

public struct ManualSurfaceSemanticViewport: Equatable {
    public let total: UInt64
    public let offset: UInt64
    public let length: UInt64
    public let followsBottom: Bool
}

public struct ManualSurfaceSemanticGeometry: Equatable {
    public let columns: Int
    public let rows: Int
    public let widthPixels: Int
    public let heightPixels: Int
    public let cellWidthPixels: Int
    public let cellHeightPixels: Int
    public let paddingTopPixels: Int
    public let paddingBottomPixels: Int
    public let paddingRightPixels: Int
    public let paddingLeftPixels: Int
}

public struct ManualSurfaceSemanticSnapshot: Equatable {
    public let generation: UInt64
    public let text: String
    public let textUTF16Length: Int
    public let visibleRows: [ManualSurfaceSemanticRow]
    public let selection: ManualSurfaceSemanticSelection?
    public let cursor: ManualSurfaceSemanticCursor
    public let viewport: ManualSurfaceSemanticViewport
    public let geometry: ManualSurfaceSemanticGeometry
}

public protocol ManualSurfaceSemanticSnapshotProviding: AnyObject {
    func semanticSnapshot() -> ManualSurfaceSemanticSnapshot?
}

extension GhosttyManualSurface: ManualSurfaceSemanticSnapshotProviding {
    func semanticSnapshot() -> ManualSurfaceSemanticSnapshot? {
        nil
    }
}
