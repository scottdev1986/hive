import Foundation
import HiveXPCProtocol

// One binary, signed several ways. The trusted client and the hostile client are
// byte-identical before signing, so any difference in outcome is attributable to
// the code signature and nothing else.

let timeout: TimeInterval = 10

func out(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

/// A carried failure reason. `Result` requires an `Error`, and the failure we
/// care about is a code-signing rejection reported as a message string.
struct Failure: Error { let message: String }

func fail(_ code: String, _ detail: String) -> Never {
    out(Reply(ok: false, code: code, detail: detail).json)
    exit(1)
}

/// Runs `body`, which must call `done` exactly once. Returns nil on timeout.
func sync<T>(_ body: (@escaping (T) -> Void) -> Void) -> T? {
    let sem = DispatchSemaphore(value: 0)
    var result: T?
    let once = NSLock()
    body { value in
        once.lock()
        if result == nil { result = value; sem.signal() }
        once.unlock()
    }
    _ = sem.wait(timeout: .now() + timeout)
    return result
}

/// Describes how a connection died. A signing-requirement rejection surfaces as
/// an invalidated connection, so we report the error verbatim rather than
/// interpreting it.
func connectionFailure(_ error: Error) -> String {
    let ns = error as NSError
    return "\(ns.domain)#\(ns.code): \(ns.localizedDescription)"
}

func proxy<P>(_ connection: NSXPCConnection, _ onError: @escaping (Error) -> Void) -> P? {
    connection.remoteObjectProxyWithErrorHandler(onError) as? P
}

// MARK: - Commands

func makeCapabilityConnection(_ endpoint: NSXPCListenerEndpoint) -> NSXPCConnection {
    let c = NSXPCConnection(listenerEndpoint: endpoint)
    c.remoteObjectInterface = Interfaces.capability()
    c.resume()
    return c
}

func makeRendezvous(_ name: String) -> NSXPCConnection {
    let c = NSXPCConnection(machServiceName: name, options: [])
    c.remoteObjectInterface = Interfaces.rendezvous()
    c.resume()
    return c
}

/// Fetch a named endpoint from the (unauthenticated) rendezvous service.
func fetchEndpoint(_ rendezvousName: String, _ endpointName: String) -> NSXPCListenerEndpoint {
    let c = makeRendezvous(rendezvousName)
    let r: Result<NSXPCListenerEndpoint, Failure>? = sync { done in
        guard let p: HiveRendezvous = proxy(c, { done(.failure(Failure(message: connectionFailure($0)))) }) else {
            return done(.failure(Failure(message: "no proxy")))
        }
        p.endpoint(named: endpointName) { ep, err in
            if let ep { done(.success(ep)) } else { done(.failure(Failure(message: err ?? "nil endpoint"))) }
        }
    }
    switch r {
    case .success(let ep): return ep
    case .failure(let e): fail("RENDEZVOUS_FAILED", e.message)
    case nil: fail("RENDEZVOUS_TIMEOUT", "no reply in \(Int(timeout))s")
    }
}

/// Call `whoAmI` over a capability connection and report exactly what happened.
func probe(_ endpoint: NSXPCListenerEndpoint, label: String) -> Never {
    let c = makeCapabilityConnection(endpoint)
    let r: Result<String, Failure>? = sync { done in
        guard let p: HiveCapabilityService = proxy(c, { done(.failure(Failure(message: connectionFailure($0)))) }) else {
            return done(.failure(Failure(message: "no proxy")))
        }
        p.whoAmI { done(.success($0)) }
    }
    switch r {
    case .success(let json):
        out(json)
        exit(0)
    case .failure(let e):
        out(Reply(ok: false, code: "REJECTED", detail: "\(label): \(e.message)").json)
        exit(2)
    case nil:
        out(Reply(ok: false, code: "REJECTED_TIMEOUT", detail: label).json)
        exit(2)
    }
}

func capabilityEndpoint(_ rendezvousName: String, subject: String, role: String, branch: String) -> NSXPCListenerEndpoint {
    let c = makeRendezvous(rendezvousName)
    let r: Result<NSXPCListenerEndpoint, Failure>? = sync { done in
        guard let p: HiveRendezvous = proxy(c, { done(.failure(Failure(message: connectionFailure($0)))) }) else {
            return done(.failure(Failure(message: "no proxy")))
        }
        p.capabilityEndpoint(subject: subject, role: role, branch: branch) { ep, err in
            if let ep { done(.success(ep)) } else { done(.failure(Failure(message: err ?? "nil endpoint"))) }
        }
    }
    switch r {
    case .success(let ep): return ep
    case .failure(let e): fail("MINT_FAILED", e.message)
    case nil: fail("MINT_TIMEOUT", "no reply")
    }
}

/// Invoke one capability method by name. Returns the server's JSON reply.
func invoke(_ p: HiveCapabilityService, _ argv: [String]) -> String? {
    let verb = argv[0]
    let arg = argv.count > 1 ? argv[1] : ""
    switch verb {
    case "whoAmI":          return sync { p.whoAmI(withReply: $0) }
    case "sendMessage":     return sync { p.sendMessage("hello", to: arg.isEmpty ? "orchestrator" : arg, withReply: $0) }
    case "readOwnInbox":    return sync { p.readOwnInbox(withReply: $0) }
    case "ackOwnControl":   return sync { p.ackOwnControl(arg, withReply: $0) }
    case "readGlobalInbox": return sync { p.readGlobalInbox(withReply: $0) }
    case "spawn":           return sync { p.spawnAgent(arg, withReply: $0) }
    case "approve":         return sync { p.approve(arg, withReply: $0) }
    case "kill":            return sync { p.killAgent(arg, withReply: $0) }
    case "land":            return sync { p.land(branch: arg, simulateLostRace: false, withReply: $0) }
    case "landLostRace":    return sync { p.land(branch: arg, simulateLostRace: true, withReply: $0) }
    case "legacyLand":      return sync { p.legacyLand(subject: arg, branch: argv.count > 2 ? argv[2] : "", withReply: $0) }
    default: fail("BAD_VERB", verb)
    }
}

// MARK: - Entry

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("USAGE", "peer <probe-mach|probe-endpoint|capability> ...")
}

switch command {

// Connect to a *named* Mach service. Any local process can look this name up:
// it is a public bearer address. Only the signing requirement separates callers.
case "probe-mach":
    guard args.count >= 2 else { fail("USAGE", "probe-mach <machServiceName>") }
    let c = NSXPCConnection(machServiceName: args[1], options: [])
    c.remoteObjectInterface = Interfaces.capability()
    c.resume()
    let r: Result<String, Failure>? = sync { done in
        guard let p: HiveCapabilityService = proxy(c, { done(.failure(Failure(message: connectionFailure($0)))) }) else {
            return done(.failure(Failure(message: "no proxy")))
        }
        p.whoAmI { done(.success($0)) }
    }
    switch r {
    case .success(let json): out(json); exit(0)
    case .failure(let e): out(Reply(ok: false, code: "REJECTED", detail: e.message).json); exit(2)
    case nil: out(Reply(ok: false, code: "REJECTED_TIMEOUT", detail: args[1]).json); exit(2)
    }

// Obtain a real endpoint from the open rendezvous, then try to use it.
case "probe-endpoint":
    guard args.count >= 3 else { fail("USAGE", "probe-endpoint <rendezvous> <endpointName>") }
    probe(fetchEndpoint(args[1], args[2]), label: args[2])

// Mint a capability for a subject/role/branch, then run a sequence of verbs
// against it. Each verb prints one JSON line prefixed by the verb.
case "capability":
    guard args.count >= 5 else { fail("USAGE", "capability <rendezvous> <subject> <role> <branch> [verb[:arg[:arg]] ...]") }
    let ep = capabilityEndpoint(args[1], subject: args[2], role: args[3], branch: args[4])
    let c = makeCapabilityConnection(ep)
    var connectionError: String?
    let errLock = NSLock()
    guard let p = c.remoteObjectProxyWithErrorHandler({ e in
        errLock.lock(); connectionError = connectionFailure(e); errLock.unlock()
    }) as? HiveCapabilityService else { fail("NO_PROXY", "capability") }

    for spec in args.dropFirst(5) {
        let parts = spec.components(separatedBy: ":")
        guard let json = invoke(p, parts) else {
            errLock.lock(); let e = connectionError ?? "timeout"; errLock.unlock()
            out("\(parts[0]) \(Reply(ok: false, code: "REJECTED", detail: e).json)")
            exit(2)
        }
        out("\(parts[0]) \(json)")
    }
    exit(0)

// Ask the rendezvous to advance the epoch (revocation).
case "revoke":
    guard args.count >= 2 else { fail("USAGE", "revoke <rendezvous>") }
    let c = makeRendezvous(args[1])
    let e: Int? = sync { done in
        guard let p: HiveRendezvous = proxy(c, { _ in done(-1) }) else { return done(-1) }
        p.revoke { done($0) }
    }
    out(Reply(ok: true, code: "EPOCH", detail: "\(e ?? -1)").json)
    exit(0)

default:
    fail("BAD_COMMAND", command)
}
