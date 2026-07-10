import Foundation
import CoreGraphics

public enum Direction: String, Codable, CaseIterable {
    case left, right, up, down
}

/// Spatial focus movement over solved pane frames.
///
/// Coordinates are the solver's: x grows right, y grows down (top-left origin).
/// A candidate must lie strictly beyond the source pane's edge in the travel
/// direction. Candidates sharing perpendicular overlap with the source win
/// over non-overlapping ones; then smallest travel distance; then largest
/// overlap; then PaneID for a total deterministic order.
public enum SpatialNavigator {

    public static func pane(
        from source: PaneID,
        in frames: [PaneID: CGRect],
        direction: Direction
    ) -> PaneID? {
        guard let sourceFrame = frames[source] else { return nil }

        struct Candidate {
            let id: PaneID
            let travel: CGFloat
            let overlap: CGFloat
            let centerDistance: CGFloat
        }

        var candidates: [Candidate] = []
        for (id, frame) in frames where id != source {
            let travel: CGFloat
            let overlap: CGFloat
            switch direction {
            case .right:
                travel = frame.minX - sourceFrame.maxX
                overlap = perpendicularOverlap(sourceFrame, frame, vertical: true)
            case .left:
                travel = sourceFrame.minX - frame.maxX
                overlap = perpendicularOverlap(sourceFrame, frame, vertical: true)
            case .down:
                travel = frame.minY - sourceFrame.maxY
                overlap = perpendicularOverlap(sourceFrame, frame, vertical: false)
            case .up:
                travel = sourceFrame.minY - frame.maxY
                overlap = perpendicularOverlap(sourceFrame, frame, vertical: false)
            }
            guard travel >= 0 else { continue }
            let dx = frame.midX - sourceFrame.midX
            let dy = frame.midY - sourceFrame.midY
            candidates.append(Candidate(
                id: id, travel: travel, overlap: overlap,
                centerDistance: (dx * dx + dy * dy).squareRoot()))
        }
        guard !candidates.isEmpty else { return nil }

        let overlapping = candidates.filter { $0.overlap > 0 }
        let pool = overlapping.isEmpty ? candidates : overlapping
        return pool.min { a, b in
            if a.travel != b.travel { return a.travel < b.travel }
            if a.overlap != b.overlap { return a.overlap > b.overlap }
            if a.centerDistance != b.centerDistance { return a.centerDistance < b.centerDistance }
            return a.id < b.id
        }?.id
    }

    private static func perpendicularOverlap(_ a: CGRect, _ b: CGRect, vertical: Bool) -> CGFloat {
        if vertical {
            return max(0, min(a.maxY, b.maxY) - max(a.minY, b.minY))
        } else {
            return max(0, min(a.maxX, b.maxX) - max(a.minX, b.minX))
        }
    }
}
