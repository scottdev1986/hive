import Foundation

/// Every authority a caller can exercise. There is deliberately no `.anything`.
public enum Action: String, Sendable, CaseIterable {
    case sendMessage
    case readOwnInbox
    case ackOwnControl
    case land
    case spawn
    case approve
    case kill
    case readGlobalInbox

    /// Wire-stable audit event name. The HTTP control plane and this XPC plane
    /// authorize different transports against the same vocabulary, so a reviewer
    /// can diff their audit logs directly.
    public var auditName: String {
        switch self {
        case .sendMessage: return "message:send"
        case .readOwnInbox: return "inbox:read-own"
        case .ackOwnControl: return "control:ack-own"
        case .land: return "branch:land"
        case .spawn: return "agent:spawn"
        case .approve: return "approval:grant"
        case .kill: return "agent:kill"
        case .readGlobalInbox: return "inbox:read-global"
        }
    }
}

public enum Denial: String, Sendable {
    case notPermitted
    case staleEpoch
    case replayed
    case expired
    case wrongBranch
    case unknownCapability
}

public enum Decision: Equatable, Sendable {
    case allowed
    case denied(Denial)

    public var isAllowed: Bool { self == .allowed }

    public var code: String {
        switch self {
        case .allowed: return "ALLOWED"
        case .denied(let d): return "DENIED_" + d.rawValue.uppercased()
        }
    }
}

/// A capability is minted for exactly one subject inside exactly one tenant.
///
/// `tenant` and `subject` are fixed at mint time and are never parameters of an
/// authorization check. That is the whole confused-deputy defense: a caller
/// cannot name a subject it is not.
public struct Grant: Sendable {
    public let id: String
    public let tenant: String
    public let subject: String
    public let actions: Set<Action>
    /// Actions that may be exercised at most once per grant.
    public let oneShot: Set<Action>
    /// A writer may land only this branch.
    public let branch: String?
    public let epoch: Int
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString,
        tenant: String,
        subject: String,
        actions: Set<Action>,
        oneShot: Set<Action> = [],
        branch: String? = nil,
        epoch: Int,
        expiresAt: Date
    ) {
        self.id = id
        self.tenant = tenant
        self.subject = subject
        self.actions = actions
        self.oneShot = oneShot
        self.branch = branch
        self.epoch = epoch
        self.expiresAt = expiresAt
    }
}

/// The roles the blueprint names, expressed as allowlists rather than as a
/// privilege ladder. An orchestrator is not "a writer plus more": it holds no
/// write or landing capability at all.
public enum Role {
    /// "An ordinary agent may send messages, read its own inbox, and acknowledge its own controls."
    public static let agent: Set<Action> = [.sendMessage, .readOwnInbox, .ackOwnControl]

    /// "A writer receives a short-lived, one-shot right to land only its own branch
    /// at the current epoch."
    public static let writer: Set<Action> = agent.union([.land])
    public static let writerOneShot: Set<Action> = [.land]

    /// "The orchestrator may spawn and approve but holds no write or landing capability."
    public static let orchestrator: Set<Action> = agent.union([.spawn, .approve])
}

/// Authoritative, in-process authorization. Revocation advances the epoch, which
/// invalidates every grant minted before it.
public final class CapabilityRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var grants: [String: Grant] = [:]
    private var consumed: Set<String> = []          // "grantID:action" — succeeded, never again
    private var inFlight: Set<String> = []          // "grantID:action" — reserved, outcome unknown
    private var _epoch: Int
    /// Injected so tests can drive expiry without sleeping.
    private var now: () -> Date

    public init(epoch: Int = 0, now: @escaping () -> Date = { Date() }) {
        self._epoch = epoch
        self.now = now
    }

    public var epoch: Int {
        lock.lock(); defer { lock.unlock() }
        return _epoch
    }

    @discardableResult
    public func mint(_ grant: Grant) -> Grant {
        lock.lock(); defer { lock.unlock() }
        grants[grant.id] = grant
        return grant
    }

    public func grant(id: String) -> Grant? {
        lock.lock(); defer { lock.unlock() }
        return grants[id]
    }

    /// Only the deliberately-vulnerable `legacyLand` path needs this: looking a
    /// grant up by a caller-supplied subject is the confused deputy.
    public func allGrants() -> [Grant] {
        lock.lock(); defer { lock.unlock() }
        return Array(grants.values)
    }

    /// Advance the epoch. Stale rights minted at an earlier epoch stop working.
    @discardableResult
    public func revoke() -> Int {
        lock.lock(); defer { lock.unlock() }
        _epoch += 1
        return _epoch
    }

    /// The only authorization entry point. Note what it does *not* take: a tenant
    /// and a subject. Both come from the grant the connection already holds.
    ///
    /// A one-shot action is *reserved* here, not spent. The caller must then call
    /// `commit` on success or `release` on failure. Spending the right at
    /// authorization time would strand a writer whose fast-forward merge lost a
    /// race through no fault of its own.
    public func authorize(grantID: String, action: Action, branch: String? = nil) -> Decision {
        lock.lock(); defer { lock.unlock() }

        guard let grant = grants[grantID] else { return .denied(.unknownCapability) }
        guard grant.epoch == _epoch else { return .denied(.staleEpoch) }
        guard now() < grant.expiresAt else { return .denied(.expired) }
        guard grant.actions.contains(action) else { return .denied(.notPermitted) }

        if action == .land {
            // A writer lands its own branch, and only its own branch.
            guard let own = grant.branch, branch == own else { return .denied(.wrongBranch) }
        }

        if grant.oneShot.contains(action) {
            let key = "\(grant.id):\(action.rawValue)"
            // Already spent, or already in flight: either way this is a replay.
            guard !consumed.contains(key), !inFlight.contains(key) else { return .denied(.replayed) }
            inFlight.insert(key)
        }

        return .allowed
    }

    /// The action succeeded. Burn the one-shot right permanently.
    public func commit(grantID: String, action: Action) {
        lock.lock(); defer { lock.unlock() }
        let key = "\(grantID):\(action.rawValue)"
        inFlight.remove(key)
        consumed.insert(key)
    }

    /// The action failed for a reason that is not the caller's fault (a lost
    /// fast-forward race). Return the right so the caller may retry.
    public func release(grantID: String, action: Action) {
        lock.lock(); defer { lock.unlock() }
        inFlight.remove("\(grantID):\(action.rawValue)")
    }
}
