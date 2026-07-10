import Foundation
import HiveCapability
import HiveXPCProtocol

// The server is launched by launchd with two MachServices:
//   <label>.rendezvous  — no signing requirement (a bearer address, on purpose)
//   <label>.guarded     — cdhash requirement (authenticated)
//
// Everything else is an anonymous listener whose endpoint is vended over the
// rendezvous service.

let env = ProcessInfo.processInfo.environment

func requireEnv(_ key: String) -> String {
    guard let v = env[key], !v.isEmpty else {
        FileHandle.standardError.write("server: missing env \(key)\n".data(using: .utf8)!)
        exit(78)  // EX_CONFIG
    }
    return v
}

let rendezvousName = requireEnv("HIVE_RENDEZVOUS_SERVICE")
let guardedName = requireEnv("HIVE_GUARDED_SERVICE")
let trustedCDHash = requireEnv("HIVE_TRUSTED_CDHASH")
let trustedIdentifier = requireEnv("HIVE_TRUSTED_IDENTIFIER")

let cdhashRequirement = "cdhash H\"\(trustedCDHash)\""
let identifierRequirement = "identifier \"\(trustedIdentifier)\""
let anchorRequirement = "anchor apple generic"

func log(_ s: String) {
    FileHandle.standardError.write("[server] \(s)\n".data(using: .utf8)!)
}

let registry = CapabilityRegistry()

// MARK: - Capability service, bound to one grant

/// One instance per accepted connection. The grant is captured here, not passed
/// in by the caller. This object is the entire authorization surface.
final class CapabilityService: NSObject, HiveCapabilityService {
    private let grantID: String
    private let registry: CapabilityRegistry

    init(grantID: String, registry: CapabilityRegistry) {
        self.grantID = grantID
        self.registry = registry
    }

    private var subject: String { registry.grant(id: grantID)?.subject ?? "<unknown>" }

    private func check(_ action: Action, branch: String? = nil) -> Decision {
        let d = registry.authorize(grantID: grantID, action: action, branch: branch)
        log("audit subject=\(subject) action=\(action.auditName) decision=\(d.code)")
        return d
    }

    private func reply(_ d: Decision, detail: String? = nil) -> String {
        Reply(ok: d.isAllowed, code: d.code, subject: subject, detail: detail).json
    }

    func whoAmI(withReply r: @escaping (String) -> Void) {
        r(Reply(ok: true, code: "ALLOWED", subject: subject,
                detail: "epoch=\(registry.epoch)").json)
    }

    func sendMessage(_ body: String, to recipient: String, withReply r: @escaping (String) -> Void) {
        r(reply(check(.sendMessage), detail: "to=\(recipient) bytes=\(body.utf8.count)"))
    }

    func readOwnInbox(withReply r: @escaping (String) -> Void) {
        r(reply(check(.readOwnInbox)))
    }

    func ackOwnControl(_ controlID: String, withReply r: @escaping (String) -> Void) {
        r(reply(check(.ackOwnControl), detail: "control=\(controlID)"))
    }

    func land(branch: String, simulateLostRace: Bool, withReply r: @escaping (String) -> Void) {
        let d = check(.land, branch: branch)
        guard d.isAllowed else { return r(reply(d, detail: "branch=\(branch)")) }

        if simulateLostRace {
            // main moved under us; --ff-only refused. Not the writer's fault.
            registry.release(grantID: grantID, action: .land)
            log("audit subject=\(subject) action=branch:land outcome=FF_REJECTED right=released")
            return r(Reply(ok: false, code: "FF_REJECTED", subject: subject,
                           detail: "right released; rebase and retry").json)
        }

        registry.commit(grantID: grantID, action: .land)
        log("audit subject=\(subject) action=branch:land outcome=MERGED right=consumed")
        r(Reply(ok: true, code: "MERGED", subject: subject, detail: "branch=\(branch)").json)
    }

    func spawnAgent(_ name: String, withReply r: @escaping (String) -> Void) {
        r(reply(check(.spawn), detail: "name=\(name)"))
    }

    func approve(_ approvalID: String, withReply r: @escaping (String) -> Void) {
        r(reply(check(.approve), detail: "approval=\(approvalID)"))
    }

    func killAgent(_ name: String, withReply r: @escaping (String) -> Void) {
        r(reply(check(.kill), detail: "target=\(name)"))
    }

    func readGlobalInbox(withReply r: @escaping (String) -> Void) {
        r(reply(check(.readGlobalInbox)))
    }

    /// The vulnerable variant. It trusts a caller-supplied subject, looks up that
    /// subject's grant, and authorizes against it. This is the confused deputy.
    func legacyLand(subject requested: String, branch: String, withReply r: @escaping (String) -> Void) {
        guard let victim = registry.allGrants().first(where: { $0.subject == requested }) else {
            return r(Reply(ok: false, code: "DENIED_UNKNOWNCAPABILITY", subject: requested).json)
        }
        let d = registry.authorize(grantID: victim.id, action: .land, branch: branch)
        log("audit caller=\(subject) claimed=\(requested) action=branch:land decision=\(d.code) [LEGACY]")
        if d.isAllowed { registry.commit(grantID: victim.id, action: .land) }
        r(Reply(ok: d.isAllowed, code: d.isAllowed ? "MERGED" : d.code, subject: requested,
                detail: "caller was \(subject)").json)
    }
}

// MARK: - Listener plumbing

/// Accepts connections and hands each one a capability service bound to `grantID`.
final class CapabilityDelegate: NSObject, NSXPCListenerDelegate {
    let grantID: String
    let label: String
    init(grantID: String, label: String) {
        self.grantID = grantID
        self.label = label
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        // If a signing requirement is set, the peer was already validated and
        // rejected before reaching this delegate.
        log("accept listener=\(label) pid=\(c.processIdentifier) grant=\(grantID.prefix(8))")
        c.exportedInterface = Interfaces.capability()
        c.exportedObject = CapabilityService(grantID: grantID, registry: registry)
        c.resume()
        return true
    }
}

var retained: [AnyObject] = []

func makeAnonymousListener(grantID: String, requirement: String?, label: String) -> NSXPCListener {
    let listener = NSXPCListener.anonymous()
    if let requirement {
        listener.setConnectionCodeSigningRequirement(requirement)
    }
    let delegate = CapabilityDelegate(grantID: grantID, label: label)
    listener.delegate = delegate
    retained.append(delegate)
    retained.append(listener)
    listener.resume()
    log("listener \(label) requirement=\(requirement ?? "<none>")")
    return listener
}

func expiry(_ seconds: TimeInterval = 600) -> Date { Date().addingTimeInterval(seconds) }

func actions(forRole role: String) -> (Set<Action>, Set<Action>) {
    switch role {
    case "writer": return (Role.writer, Role.writerOneShot)
    case "orchestrator": return (Role.orchestrator, [])
    default: return (Role.agent, [])
    }
}

// A generic probe grant, used by the listeners whose purpose is to test *who*
// gets in rather than *what* they may do.
let probeGrant = registry.mint(Grant(
    tenant: "HIVE-A", subject: "probe", actions: Role.agent, epoch: registry.epoch, expiresAt: expiry()
))

let namedListeners: [String: NSXPCListener] = [
    EndpointName.open: makeAnonymousListener(grantID: probeGrant.id, requirement: nil, label: "open"),
    EndpointName.guarded: makeAnonymousListener(grantID: probeGrant.id, requirement: cdhashRequirement, label: "guarded-anon"),
    EndpointName.reqIdentifier: makeAnonymousListener(grantID: probeGrant.id, requirement: identifierRequirement, label: "req-identifier"),
    EndpointName.reqCDHash: makeAnonymousListener(grantID: probeGrant.id, requirement: cdhashRequirement, label: "req-cdhash"),
    EndpointName.reqAnchorApple: makeAnonymousListener(grantID: probeGrant.id, requirement: anchorRequirement, label: "req-anchor-apple"),
]

final class RendezvousService: NSObject, HiveRendezvous {
    func endpoint(named name: String, withReply r: @escaping (NSXPCListenerEndpoint?, String?) -> Void) {
        guard let l = namedListeners[name] else { return r(nil, "no such endpoint: \(name)") }
        r(l.endpoint, nil)
    }

    func capabilityEndpoint(
        subject: String, role: String, branch: String,
        withReply r: @escaping (NSXPCListenerEndpoint?, String?) -> Void
    ) {
        let (allowed, oneShot) = actions(forRole: role)
        let grant = registry.mint(Grant(
            tenant: "HIVE-A", subject: subject, actions: allowed, oneShot: oneShot,
            branch: branch.isEmpty ? nil : branch,
            epoch: registry.epoch, expiresAt: expiry()
        ))
        // Layered: the endpoint is the capability (authorization), and the
        // requirement authenticates who may pick it up.
        let listener = makeAnonymousListener(
            grantID: grant.id, requirement: cdhashRequirement, label: "cap:\(subject)"
        )
        log("mint subject=\(subject) role=\(role) branch=\(branch) epoch=\(grant.epoch)")
        r(listener.endpoint, nil)
    }

    func revoke(withReply r: @escaping (Int) -> Void) {
        let e = registry.revoke()
        log("revoke -> epoch=\(e)")
        r(e)
    }

    func currentEpoch(withReply r: @escaping (Int) -> Void) { r(registry.epoch) }
}

final class RendezvousDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        log("accept listener=rendezvous pid=\(c.processIdentifier)")
        c.exportedInterface = Interfaces.rendezvous()
        c.exportedObject = RendezvousService()
        c.resume()
        return true
    }
}

// The guarded Mach service: a *named*, publicly discoverable endpoint that any
// local process can look up, protected only by the signing requirement.
final class GuardedMachDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        log("accept listener=guarded-mach pid=\(c.processIdentifier)")
        c.exportedInterface = Interfaces.capability()
        c.exportedObject = CapabilityService(grantID: probeGrant.id, registry: registry)
        c.resume()
        return true
    }
}

let rendezvousListener = NSXPCListener(machServiceName: rendezvousName)
let rendezvousDelegate = RendezvousDelegate()
rendezvousListener.delegate = rendezvousDelegate
retained.append(rendezvousDelegate)
rendezvousListener.resume()
log("mach service \(rendezvousName) requirement=<none>")

let guardedListener = NSXPCListener(machServiceName: guardedName)
guardedListener.setConnectionCodeSigningRequirement(cdhashRequirement)
let guardedDelegate = GuardedMachDelegate()
guardedListener.delegate = guardedDelegate
retained.append(guardedDelegate)
guardedListener.resume()
log("mach service \(guardedName) requirement=\(cdhashRequirement)")

log("ready pid=\(getpid())")
RunLoop.main.run()
