import Foundation

/// Names of the pre-built listeners the server vends over the rendezvous service.
public enum EndpointName {
    /// Anonymous listener with **no** code-signing requirement.
    /// Possessing this endpoint is sufficient to be served.
    public static let open = "open"
    /// The same anonymous listener shape, but guarded by a cdhash requirement.
    public static let guarded = "guarded"
    /// Requirement-strength matrix: identical service, different requirement string.
    public static let reqIdentifier = "req-identifier"
    public static let reqCDHash = "req-cdhash"
    public static let reqAnchorApple = "req-anchor-apple"
}

/// The rendezvous service is deliberately **unauthenticated**. It stands in for
/// a leaked bearer address: any local process may call it and walk away holding
/// a real `NSXPCListenerEndpoint`. That is what makes the hypothesis-2 test
/// meaningful — the adversary does not have to steal anything.
///
/// In the shipping design the minting authority is the broker, and it is itself
/// behind a signing requirement.
@objc public protocol HiveRendezvous {
    func endpoint(named name: String, withReply reply: @escaping (NSXPCListenerEndpoint?, String?) -> Void)

    /// Mint a capability bound to one subject, and return an endpoint that *is*
    /// that capability. The endpoint carries the authority; nothing the caller
    /// says afterwards can widen it.
    func capabilityEndpoint(
        subject: String,
        role: String,
        branch: String,
        withReply reply: @escaping (NSXPCListenerEndpoint?, String?) -> Void
    )

    func revoke(withReply reply: @escaping (Int) -> Void)
    func currentEpoch(withReply reply: @escaping (Int) -> Void)
}

/// The capability service. Every method's authority is determined entirely by
/// which connection it arrived on.
///
/// Read the signatures: there is no `tenant:` and no `subject:` anywhere except
/// on `legacyLand`, which exists only to be exploited.
@objc public protocol HiveCapabilityService {
    func whoAmI(withReply reply: @escaping (String) -> Void)

    func sendMessage(_ body: String, to recipient: String, withReply reply: @escaping (String) -> Void)
    func readOwnInbox(withReply reply: @escaping (String) -> Void)
    func ackOwnControl(_ controlID: String, withReply reply: @escaping (String) -> Void)

    /// The writer's one-shot right. `simulateLostRace` is a test lever standing
    /// in for a fast-forward merge that lost to a concurrent lander; it lets the
    /// prototype prove the right is released rather than burned.
    func land(branch: String, simulateLostRace: Bool, withReply reply: @escaping (String) -> Void)

    func spawnAgent(_ name: String, withReply reply: @escaping (String) -> Void)
    func approve(_ approvalID: String, withReply reply: @escaping (String) -> Void)
    func killAgent(_ name: String, withReply reply: @escaping (String) -> Void)
    func readGlobalInbox(withReply reply: @escaping (String) -> Void)

    /// **Deliberately vulnerable.** Mirrors an HTTP body field that names its own
    /// subject. Present so the prototype can demonstrate the confused deputy it
    /// is claiming to prevent, rather than merely asserting the claim.
    func legacyLand(subject: String, branch: String, withReply reply: @escaping (String) -> Void)
}

public enum Interfaces {
    public static func rendezvous() -> NSXPCInterface {
        let iface = NSXPCInterface(with: HiveRendezvous.self)
        let allowed = NSSet(array: [NSXPCListenerEndpoint.self, NSString.self]) as! Set<AnyHashable>
        iface.setClasses(
            allowed,
            for: #selector(HiveRendezvous.endpoint(named:withReply:)),
            argumentIndex: 0, ofReply: true
        )
        iface.setClasses(
            allowed,
            for: #selector(HiveRendezvous.capabilityEndpoint(subject:role:branch:withReply:)),
            argumentIndex: 0, ofReply: true
        )
        return iface
    }

    public static func capability() -> NSXPCInterface {
        NSXPCInterface(with: HiveCapabilityService.self)
    }
}

/// Machine-readable result, so the evidence script asserts on codes rather than prose.
public struct Reply: Codable {
    public var ok: Bool
    public var code: String
    public var subject: String?
    public var detail: String?

    public init(ok: Bool, code: String, subject: String? = nil, detail: String? = nil) {
        self.ok = ok
        self.code = code
        self.subject = subject
        self.detail = detail
    }

    public var json: String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(data: data, encoding: .utf8) ?? #"{"ok":false,"code":"ENCODE_FAILED"}"#
    }

    public static func decode(_ s: String) -> Reply? {
        guard let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Reply.self, from: d)
    }
}
