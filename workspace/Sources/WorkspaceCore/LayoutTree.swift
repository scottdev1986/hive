import Foundation
import CoreGraphics

/// Split orientation of an interior layout node.
/// `.horizontal` places children side by side (split along a vertical line);
/// `.vertical` stacks children (first on top).
public enum SplitOrientation: String, Codable, Equatable {
    case horizontal
    case vertical
}

/// A binary split tree over the satellite region.
public indirect enum LayoutNode: Equatable, Codable {
    case leaf(PaneID)
    case split(orientation: SplitOrientation, ratio: Double, first: LayoutNode, second: LayoutNode)

    /// Pane IDs in deterministic depth-first (first, second) traversal order.
    public var paneIDs: [PaneID] {
        switch self {
        case .leaf(let id): return [id]
        case .split(_, _, let first, let second): return first.paneIDs + second.paneIDs
        }
    }

    public func contains(_ pane: PaneID) -> Bool {
        paneIDs.contains(pane)
    }

    /// Removes `pane`; the sibling of the removed leaf replaces its parent split,
    /// so exactly one split collapses and nothing else moves.
    /// Returns nil when the tree becomes empty.
    public func removing(_ pane: PaneID) -> LayoutNode? {
        switch self {
        case .leaf(let id):
            return id == pane ? nil : self
        case .split(let orientation, let ratio, let first, let second):
            if case .leaf(let id) = first, id == pane { return second }
            if case .leaf(let id) = second, id == pane { return first }
            // A split child containing the pane keeps at least its sibling
            // after removal, so removing(_:) below can never return nil.
            if first.contains(pane) {
                return .split(orientation: orientation, ratio: ratio, first: first.removing(pane)!, second: second)
            }
            if second.contains(pane) {
                return .split(orientation: orientation, ratio: ratio, first: first, second: second.removing(pane)!)
            }
            return self
        }
    }

    /// Replaces the leaf holding `pane` with `replacement` (used by promote-swap).
    public func replacingLeaf(_ pane: PaneID, with replacement: PaneID) -> LayoutNode {
        switch self {
        case .leaf(let id):
            return id == pane ? .leaf(replacement) : self
        case .split(let orientation, let ratio, let first, let second):
            return .split(
                orientation: orientation,
                ratio: ratio,
                first: first.replacingLeaf(pane, with: replacement),
                second: second.replacingLeaf(pane, with: replacement)
            )
        }
    }

    /// Replaces the leaf holding `pane` with an arbitrary node (used by insertion splits).
    public func replacingLeaf(_ pane: PaneID, with node: LayoutNode) -> LayoutNode {
        switch self {
        case .leaf(let id):
            return id == pane ? node : self
        case .split(let orientation, let ratio, let first, let second):
            return .split(
                orientation: orientation,
                ratio: ratio,
                first: first.replacingLeaf(pane, with: node),
                second: second.replacingLeaf(pane, with: node)
            )
        }
    }
}

/// Geometry constants for the deterministic solver.
public struct LayoutMetrics: Equatable {
    /// Fraction of the usable width the master pane occupies while satellites exist.
    /// The blueprint fixes the band at 55–60%.
    public var masterRatio: Double
    /// Gap between panes, in points.
    public var gap: Double

    public init(masterRatio: Double = 0.58, gap: Double = 8) {
        self.masterRatio = min(max(masterRatio, 0.55), 0.60)
        self.gap = gap
    }
}

/// The master/satellite layout for one project window.
///
/// Invariants:
/// - The master pane is rendered as the left column at `metrics.masterRatio`
///   whenever at least one satellite exists; alone it fills the bounds.
/// - Satellites live in a binary split tree; traversal order is the
///   deterministic "ordered pane tree" the blueprint refers to.
/// - All mutations are pure tree operations; the same operation sequence with
///   the same geometry always yields the same tree and the same frames.
public struct LayoutTree: Equatable, Codable {
    public private(set) var master: PaneID?
    public private(set) var satellites: LayoutNode?
    public var metrics: LayoutMetrics {
        get { LayoutMetrics(masterRatio: masterRatio, gap: gap) }
        set { masterRatio = newValue.masterRatio; gap = newValue.gap }
    }
    private var masterRatio: Double
    private var gap: Double

    public init(metrics: LayoutMetrics = LayoutMetrics()) {
        self.masterRatio = metrics.masterRatio
        self.gap = metrics.gap
    }

    public var paneIDs: [PaneID] {
        var ids: [PaneID] = []
        if let master { ids.append(master) }
        if let satellites { ids.append(contentsOf: satellites.paneIDs) }
        return ids
    }

    public var isEmpty: Bool { master == nil && satellites == nil }

    public func contains(_ pane: PaneID) -> Bool { paneIDs.contains(pane) }

    // MARK: Insertion

    /// Inserts a pane using the least-disruptive split: the first pane becomes
    /// master; later panes split the geometrically largest satellite leaf in
    /// half along its longer axis, leaving every other pane's region untouched.
    /// Ties break on traversal order, so insertion is deterministic.
    public mutating func insert(_ pane: PaneID, in bounds: CGRect) {
        precondition(!contains(pane), "pane \(pane) already in layout")
        guard master != nil else {
            master = pane
            return
        }
        guard let tree = satellites else {
            satellites = .leaf(pane)
            return
        }
        let regionFrames = frames(in: bounds)
        var target: PaneID?
        var targetArea = -Double.infinity
        for id in tree.paneIDs { // traversal order = deterministic tie-break
            guard let frame = regionFrames[id] else { continue }
            let area = Double(frame.width * frame.height)
            if area > targetArea {
                targetArea = area
                target = id
            }
        }
        guard let target, let targetFrame = regionFrames[target] else {
            // Degenerate geometry: append after the last leaf.
            let last = tree.paneIDs.last!
            satellites = tree.replacingLeaf(last, with: LayoutNode.split(
                orientation: .vertical, ratio: 0.5, first: .leaf(last), second: .leaf(pane)))
            return
        }
        let orientation: SplitOrientation = targetFrame.width >= targetFrame.height ? .horizontal : .vertical
        satellites = tree.replacingLeaf(target, with: LayoutNode.split(
            orientation: orientation, ratio: 0.5, first: .leaf(target), second: .leaf(pane)))
    }

    // MARK: Close

    /// Removes a pane. Closing a satellite collapses only its parent split.
    /// Closing the master pulls `preferredMaster` (falling back to the first
    /// satellite in traversal order) out of the satellite tree into the master
    /// slot, leaving the remaining satellite order intact.
    public mutating func close(_ pane: PaneID, preferredMaster: PaneID? = nil) {
        if pane == master {
            guard let tree = satellites else {
                master = nil
                return
            }
            let candidates = tree.paneIDs
            let replacement = (preferredMaster.flatMap { candidates.contains($0) ? $0 : nil }) ?? candidates[0]
            satellites = tree.removing(replacement)
            master = replacement
            return
        }
        satellites = satellites?.removing(pane)
    }

    // MARK: Promotion

    /// Atomically swaps `pane` with the current master. The pane takes the
    /// master slot and the old master takes the pane's satellite leaf, so the
    /// rest of the satellite order never changes.
    public mutating func promote(_ pane: PaneID) {
        guard let currentMaster = master, pane != currentMaster else { return }
        guard let tree = satellites, tree.contains(pane) else { return }
        satellites = tree.replacingLeaf(pane, with: currentMaster)
        master = pane
    }

    // MARK: Frames

    /// Deterministic frames for the current tree in `bounds` (top-left origin
    /// agnostic; caller decides coordinate flip). Same tree + same bounds
    /// always produces identical output.
    public func frames(in bounds: CGRect) -> [PaneID: CGRect] {
        var result: [PaneID: CGRect] = [:]
        guard let master else { return result }
        guard let satellites else {
            result[master] = bounds
            return result
        }
        let masterWidth = ((bounds.width - gap) * masterRatio).rounded(.down)
        let masterFrame = CGRect(x: bounds.minX, y: bounds.minY, width: masterWidth, height: bounds.height)
        let satelliteFrame = CGRect(
            x: bounds.minX + masterWidth + gap,
            y: bounds.minY,
            width: bounds.width - masterWidth - gap,
            height: bounds.height
        )
        result[master] = masterFrame
        collectFrames(node: satellites, region: satelliteFrame, into: &result)
        return result
    }

    private func collectFrames(node: LayoutNode, region: CGRect, into result: inout [PaneID: CGRect]) {
        switch node {
        case .leaf(let id):
            result[id] = region
        case .split(let orientation, let ratio, let first, let second):
            switch orientation {
            case .horizontal:
                let firstWidth = ((region.width - gap) * ratio).rounded(.down)
                let firstRegion = CGRect(x: region.minX, y: region.minY, width: firstWidth, height: region.height)
                let secondRegion = CGRect(
                    x: region.minX + firstWidth + gap, y: region.minY,
                    width: region.width - firstWidth - gap, height: region.height)
                collectFrames(node: first, region: firstRegion, into: &result)
                collectFrames(node: second, region: secondRegion, into: &result)
            case .vertical:
                let firstHeight = ((region.height - gap) * ratio).rounded(.down)
                let firstRegion = CGRect(x: region.minX, y: region.minY, width: region.width, height: firstHeight)
                let secondRegion = CGRect(
                    x: region.minX, y: region.minY + firstHeight + gap,
                    width: region.width, height: region.height - firstHeight - gap)
                collectFrames(node: first, region: firstRegion, into: &result)
                collectFrames(node: second, region: secondRegion, into: &result)
            }
        }
    }
}
