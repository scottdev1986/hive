import Foundation

// Adversarial descriptor-inheritance test, three real processes:
//
//   broker (this, role=broker)
//     └─ agent (this, role=agent)          spawned by the broker
//          └─ grandchild (this, role=grandchild)   spawned by the agent
//
// The broker opens a "capability descriptor" (a real fd) and marks it CLOEXEC.
// The blueprint requires that no descendant inherit a reusable credential. We
// prove that adversarially: the grandchild is hostile and actively tries to read
// the fd number it was told about.
//
// Negative control: the broker also opens a second fd *without* CLOEXEC. If the
// grandchild cannot read the CLOEXEC fd but CAN read the non-CLOEXEC one, the
// test is not vacuous — the mechanism, not the harness, is what stops it.

func log(_ s: String) {
    FileHandle.standardError.write("[fdtest] \(s)\n".data(using: .utf8)!)
}

/// Attempt to read a secret from an inherited fd. A leaked credential reads back.
/// A closed fd fails with EBADF. Returns (readable, bytesOrErrno).
func tryRead(fd: Int32) -> (Bool, String) {
    var buf = [UInt8](repeating: 0, count: 256)
    // Rewind: an inherited open file description shares its offset with the parent,
    // which may have read to EOF. If the fd is closed, lseek itself fails.
    if lseek(fd, 0, SEEK_SET) == -1 {
        return (false, "errno=\(errno)(\(String(cString: strerror(errno))))")
    }
    let n = read(fd, &buf, buf.count)
    if n < 0 { return (false, "errno=\(errno)(\(String(cString: strerror(errno))))") }
    let s = String(decoding: buf[0..<n], as: UTF8.self)
    return (n > 0, "read \(n) bytes: \(s.trimmingCharacters(in: .whitespacesAndNewlines))")
}

let role = ProcessInfo.processInfo.environment["FDTEST_ROLE"] ?? "broker"

func selfExec() -> String { CommandLine.arguments[0] }

/// Spawn a child of this same binary in `childRole`, inheriting fds 0/1/2 and
/// whatever else is not CLOEXEC. We do NOT use posix_spawn file actions to pass
/// anything — inheritance is left to the OS exactly as it would be for a real
/// provider process. The fd numbers are passed as plain env so a hostile child
/// knows exactly what to reach for.
func spawnChild(role childRole: String, secretFDs: [String: Int32]) -> Int32 {
    var env = ProcessInfo.processInfo.environment
    env["FDTEST_ROLE"] = childRole
    for (name, fd) in secretFDs { env["FDTEST_\(name)_FD"] = "\(fd)" }
    var envp = env.map { "\($0)=\($1)" }

    let argv = [selfExec()]
    var pid: pid_t = 0
    let cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
    let cEnvp: [UnsafeMutablePointer<CChar>?] = envp.map { strdup($0) } + [nil]
    defer { cArgv.forEach { free($0) }; cEnvp.forEach { free($0) } }

    let rc = posix_spawn(&pid, selfExec(), nil, nil, cArgv, cEnvp)
    if rc != 0 {
        log("posix_spawn failed rc=\(rc)")
        exit(70)
    }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    return status
}

switch role {

case "broker":
    let secret = "CAP-SECRET-\(getpid())"

    // A real backing file so that a leaked descriptor would read back something
    // observable rather than empty.
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cap-\(getpid()).secret")
    try? secret.data(using: .utf8)!.write(to: tmp)

    // The capability descriptor: CLOEXEC. This must NOT survive exec into a child.
    let capFD = open(tmp.path, O_RDONLY)
    guard capFD >= 0 else { log("open cap failed"); exit(71) }
    // Mark CLOEXEC — the credential must not cross an exec boundary.
    let flags = fcntl(capFD, F_GETFD)
    _ = fcntl(capFD, F_SETFD, flags | FD_CLOEXEC)
    let capIsCloexec = (fcntl(capFD, F_GETFD) & FD_CLOEXEC) != 0

    // Negative control: same secret, NOT CLOEXEC. Proves inheritance is real
    // when nobody stops it, so the CLOEXEC pass is meaningful.
    let leakFD = open(tmp.path, O_RDONLY)
    guard leakFD >= 0 else { log("open leak failed"); exit(72) }
    let leakFlags = fcntl(leakFD, F_GETFD)
    _ = fcntl(leakFD, F_SETFD, leakFlags & ~FD_CLOEXEC)
    let leakIsCloexec = (fcntl(leakFD, F_GETFD) & FD_CLOEXEC) != 0

    log("cap fd=\(capFD) cloexec=\(capIsCloexec)  control fd=\(leakFD) cloexec=\(leakIsCloexec)")
    log("spawning agent; secret backing file has \(secret.utf8.count) bytes")

    let status = spawnChild(role: "agent", secretFDs: ["CAP": capFD, "LEAK": leakFD])
    try? FileManager.default.removeItem(at: tmp)
    exit(status == 0 ? 0 : 1)

case "agent":
    // The agent is an honest intermediary. It does not touch the fds; it just
    // spawns a grandchild, exactly as an agent would spawn a subprocess. The
    // fd numbers are handed down so the *grandchild* can attack them.
    let cap = Int32(ProcessInfo.processInfo.environment["FDTEST_CAP_FD"] ?? "-1")!
    let leak = Int32(ProcessInfo.processInfo.environment["FDTEST_LEAK_FD"] ?? "-1")!
    log("agent pid=\(getpid()) forwarding cap=\(cap) leak=\(leak) to grandchild")
    let status = spawnChild(role: "grandchild", secretFDs: ["CAP": cap, "LEAK": leak])
    exit(status)

case "grandchild":
    // Hostile. It knows the exact fd numbers and tries to read both.
    let cap = Int32(ProcessInfo.processInfo.environment["FDTEST_CAP_FD"] ?? "-1")!
    let leak = Int32(ProcessInfo.processInfo.environment["FDTEST_LEAK_FD"] ?? "-1")!

    let (capReadable, capDetail) = tryRead(fd: cap)
    let (leakReadable, leakDetail) = tryRead(fd: leak)

    log("grandchild pid=\(getpid()) attacking cap=\(cap) leak=\(leak)")
    log("  CLOEXEC cap fd -> readable=\(capReadable) (\(capDetail))")
    log("  control leak fd -> readable=\(leakReadable) (\(leakDetail))")

    // PASS requires BOTH:
    //   - the CLOEXEC capability fd did NOT survive (not readable), and
    //   - the non-CLOEXEC control fd DID survive (readable) — proving the test
    //     can observe a leak when one exists.
    let pass = (!capReadable) && leakReadable
    let payload: [String: Any] = [
        "ok": pass,
        "code": pass ? "CLOEXEC_ENFORCED" : "CLOEXEC_FAILED",
        "cloexec_fd_readable": capReadable,
        "control_fd_readable": leakReadable,
        "cap_detail": capDetail,
        "control_detail": leakDetail,
    ]
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(pass ? 0 : 3)

default:
    log("unknown role \(role)")
    exit(64)
}
