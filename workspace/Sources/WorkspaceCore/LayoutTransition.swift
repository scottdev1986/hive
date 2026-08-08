import Foundation
import CoreGraphics

public enum LayoutTransition {
    public static let duration: TimeInterval = 0.18

    public static func progress(elapsed: TimeInterval, duration: TimeInterval = duration) -> Double {
        guard duration > 0 else { return 1 }
        let t = min(max(elapsed / duration, 0), 1)
        return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
    }

    public static func interpolate(from: CGRect, to: CGRect, progress: Double) -> CGRect {
        let p = CGFloat(min(max(progress, 0), 1))
        return CGRect(
            x: from.minX + (to.minX - from.minX) * p,
            y: from.minY + (to.minY - from.minY) * p,
            width: from.width + (to.width - from.width) * p,
            height: from.height + (to.height - from.height) * p)
    }
}
