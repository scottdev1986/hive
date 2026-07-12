import Foundation

public enum WaitingKind: String, Codable, Equatable {
    case userInput
    case approval
}

/// Semantic pane status. Unknown is explicit so an unrecognized feed word can
/// never be silently upgraded to a healthy state.
/// The focus ring is a separate signal and never overwrites the status border.
public enum PaneStatus: Equatable, Codable {
    case running
    case waiting(WaitingKind)
    case completed(acknowledged: Bool)
    case failed(acknowledged: Bool)
    case unknown
    case disconnected(reason: String, lastConfirmed: String)

    /// Whether the amber pulse burst applies (bounded burst handled by the view;
    /// semantic state never depends on animation).
    public var isWaiting: Bool {
        if case .waiting = self { return true }
        return false
    }

    public var needsAttention: Bool {
        switch self {
        case .running: return false
        case .waiting: return true
        case .completed(let acknowledged): return !acknowledged
        case .failed(let acknowledged): return !acknowledged
        case .unknown: return false
        case .disconnected: return true
        }
    }
}

/// Bounded amber pulse: a short burst, then steady. Exposed as data so the
/// view layer and tests agree on the bound.
public enum StatusMotion {
    public static let waitingPulseCycleSeconds: TimeInterval = 0.7
    public static let waitingPulseCycles = 3
    public static var waitingPulseBurstSeconds: TimeInterval {
        waitingPulseCycleSeconds * TimeInterval(waitingPulseCycles)
    }
}
