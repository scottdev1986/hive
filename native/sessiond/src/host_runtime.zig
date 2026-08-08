const std = @import("std");
const generated = @import("session_protocol_generated");
const host_wire = @import("host_wire");
const protocol = @import("protocol");
const security = @import("security_helpers");

const readRequiredFrame = host_wire.readRequiredFrame;

/// Where a host's own directory sits under the state root: its adoption capability, durable record, journal and checkpoints. No length limit applies to this tree — the socket that used to sit inside it is bound under the socket root instead, and is the only thing measured against `sun_path`.
const hosts_relative_path = "hosts";

const c = @cImport({
    @cInclude("sys/stat.h");
    @cInclude("unistd.h");
});

pub fn setControlTimeoutMs(fd: std.posix.fd_t, timeout_ms: u64) !void {
    security.setSocketTimeoutMs(fd, timeout_ms) catch |err| switch (err) {
        error.InvalidSocketTimeout => return error.InvalidControlTimeout,
        error.SocketTimeoutUnavailable => return error.ControlTimeoutUnavailable,
    };
}

/// How long the launcher waits for a freshly launched host to report READY, and how long that host waits for the acknowledgement. Both ends must agree. This is the create budget itself, not a fraction of it. Half was tried, on the reasoning that a host which will never report should fail fast and leave the create room to answer: it cost 27 of 31 hosts, because a boot that is merely slow under a wide burst is far more common than one that is broken. A create that ends at the ceiling is one lost agent; a bound that is too tight is most of them.
pub const host_ready_timeout_ms: u64 = generated.limits.create_rpc_timeout_ms;

pub fn setControlTimeout(fd: std.posix.fd_t) !void {
    return setControlTimeoutMs(fd, generated.limits.control_rpc_timeout_ms);
}

/// Absolute monotonic bound on one accepted connection's cumulative service time. SO_RCVTIMEO bounds each individual syscall, but a peer dribbling one byte per syscall window would otherwise hold the single-threaded host loop indefinitely. Exhausting the budget drops the connection (fail closed) so the loop always regains control within a bounded time.
pub const ConnectionDeadline = struct {
    timer: *std.time.Timer,
    start_ns: u64,
    budget_ns: u64,

    pub fn init(timer: *std.time.Timer) !ConnectionDeadline {
        return initWithBudget(timer, generated.limits.control_rpc_timeout_ms);
    }

    pub fn initWithBudget(timer: *std.time.Timer, budget_ms: u64) !ConnectionDeadline {
        if (budget_ms == 0) return error.InvalidControlTimeout;
        return .{
            .timer = timer,
            .start_ns = timer.read(),
            .budget_ns = try std.math.mul(u64, budget_ms, std.time.ns_per_ms),
        };
    }

    fn elapsedNs(self: *const ConnectionDeadline) u64 {
        const now = self.timer.read();
        if (now <= self.start_ns) return 0;
        return now - self.start_ns;
    }

    pub fn remainingMs(self: *const ConnectionDeadline) !u64 {
        const elapsed = self.elapsedNs();
        if (elapsed >= self.budget_ns) return error.ConnectionDeadlineExceeded;
        return std.math.divCeil(u64, self.budget_ns - elapsed, std.time.ns_per_ms) catch
            return error.ConnectionDeadlineExceeded;
    }

    /// Re-arms the per-syscall socket timeout at the remaining budget so the next blocking read/write cannot outlive the absolute deadline.
    pub fn rearm(self: *const ConnectionDeadline, handle: std.posix.fd_t) !void {
        try setControlTimeoutMs(handle, try self.remainingMs());
    }

    pub fn check(self: *const ConnectionDeadline) !void {
        _ = try self.remainingMs();
    }
};

/// One bounded frame read: the socket timeout is re-armed at the deadline's remaining budget before the blocking read, and the deadline is verified after it, so no sequence of dribbled syscalls outlives the budget.
pub fn readConnectionFrame(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    deadline: *const ConnectionDeadline,
) !protocol.Frame {
    try deadline.rearm(stream.handle);
    const frame = try readRequiredFrame(allocator, stream);
    try deadline.check();
    return frame;
}

/// Applies the control timeout to one accepted host connection. Returns false on any per-connection setup failure (setsockopt on a reset/invalid socket) so the caller drops that connection and keeps serving; it never surfaces a fatal error that would tear down the whole host on a single bad connection.
pub fn acceptedConnectionReady(handle: std.posix.fd_t) bool {
    setControlTimeout(handle) catch return false;
    return true;
}

test "accepted-connection setup drops a bad socket without a fatal error" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    // A real socket: the control timeout applies and the connection is ready to serve.
    const good = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM, 0);
    try std.testing.expect(acceptedConnectionReady(good));

    // The same fd, now closed, makes setsockopt fail (EBADF). The setup must report NOT ready (drop this one connection) rather than surfacing a fatal error that the host loop would let tear the whole host down.
    std.posix.close(good);
    try std.testing.expect(!acceptedConnectionReady(good));
}

const SocketEvidence = struct {
    device: u64,
    inode: u64,
    owner_uid: u32,
    mode: u16,
};

fn socketEvidenceAt(directory: std.fs.Dir, name: []const u8) !SocketEvidence {
    const stat = try std.posix.fstatat(directory.fd, name, std.posix.AT.SYMLINK_NOFOLLOW);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
        stat.mode & 0o777 != 0o600)
        return error.SocketSubstitution;
    return .{
        .device = @intCast(stat.dev),
        .inode = @intCast(stat.ino),
        .owner_uid = @intCast(stat.uid),
        .mode = @intCast(stat.mode & 0o777),
    };
}

fn requireOwnedDirectory(directory: std.fs.Dir, mode: ?u16) !void {
    // Host path historically only asserted; keep .assert so open of launcher-owned
    // runtime trees does not chmod shared parents.
    try security.requireOwnedDirectory(directory, mode, .assert);
}

fn readAndVerifyAdoptionSecret(
    directory: std.fs.Dir,
    expected: [32]u8,
) !void {
    const fd = try std.posix.openat(directory.fd, "adopt.cap", .{
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    try security.requireOwnedPrivateFile(fd, error.SecretSubstitution);
    var actual: [32]u8 = undefined;
    defer std.crypto.secureZero(u8, &actual);
    if (try file.readAll(&actual) != actual.len) return error.InvalidAdoptionSecret;
    var extra: [1]u8 = undefined;
    if (try file.read(&extra) != 0) return error.InvalidAdoptionSecret;
    if (!std.crypto.timing_safe.eql([32]u8, actual, expected))
        return error.SecretSubstitution;
}

/// The name this host's socket takes under the socket root. Derived from the session id, which the launcher and the host both already hold, so neither has to tell the other where the socket is.
pub fn hostSocketName(session_id: []const u8) [security.socket_name_length]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(session_id, &digest, .{});
    return security.socketName(digest);
}

pub const HostRuntime = struct {
    allocator: std.mem.Allocator,
    canonical_state_root: []u8,
    directory: std.fs.Dir,
    socket_directory: std.fs.Dir,
    socket_name: [security.socket_name_length]u8,
    socket_path: []u8,
    server: std.net.Server,
    socket_evidence: SocketEvidence,

    pub fn open(
        allocator: std.mem.Allocator,
        roots: security.Roots,
        session_id: []const u8,
        adoption_secret: [32]u8,
    ) !HostRuntime {
        if (!protocol.validSessionId(session_id)) return error.InvalidSessionId;
        const canonical_state_root = try std.fs.cwd().realpathAlloc(allocator, roots.state);
        errdefer allocator.free(canonical_state_root);
        var state_root = try std.fs.cwd().openDir(canonical_state_root, .{ .no_follow = true });
        defer state_root.close();
        // The launcher owns the state root itself; the private authority boundary begins at hosts, which is mode 0700.
        try requireOwnedDirectory(state_root, null);
        var hosts = try state_root.openDir(hosts_relative_path, .{ .no_follow = true });
        defer hosts.close();
        try requireOwnedDirectory(hosts, 0o700);
        var directory = try hosts.openDir(session_id, .{ .no_follow = true, .iterate = true });
        errdefer directory.close();
        try requireOwnedDirectory(directory, 0o700);
        try readAndVerifyAdoptionSecret(directory, adoption_secret);

        const canonical_socket_root = try std.fs.cwd().realpathAlloc(allocator, roots.socket);
        defer allocator.free(canonical_socket_root);
        var socket_directory = try std.fs.cwd().openDir(canonical_socket_root, .{ .no_follow = true });
        errdefer socket_directory.close();
        // Measured before anything is bound, and on this tree as well as the neutral one: a ceiling checked on one of two trees is a ceiling nobody is enforcing.
        try security.requireBindableSocketRoot(allocator, socket_directory, canonical_socket_root);
        const socket_name = hostSocketName(session_id);
        const socket_path = try std.fs.path.join(allocator, &.{
            canonical_socket_root,
            &socket_name,
        });
        errdefer allocator.free(socket_path);
        // This name is derived from the session id, so the same session asks for it again on every
        // recovery and adoption. An inode left by a host that was killed before it could unlink its
        // own socket used to fall through to `listen` and surface as a bare EADDRINUSE — the error
        // an operator can do least with, for a session that is not actually running anywhere.
        _ = try security.reclaimDeadSocket(socket_directory, &socket_name, socket_path);
        const address = try std.net.Address.initUnix(socket_path);
        // The socket's 0600 mode is fixed atomically at bind through a saved/restored umask: 0177 masks exactly group/other (and the owner-execute bit) off the 0777 bind base. A post-bind path chmod both follows symlinks and leaves the socket briefly permissive, so no path-based chmod remains — socketEvidenceAt below is the fstat proof of the mode the socket was born with.
        const saved_umask = c.umask(0o177);
        const listen_result = address.listen(.{});
        _ = c.umask(saved_umask);
        var server = try listen_result;
        errdefer server.deinit();
        const evidence = try socketEvidenceAt(socket_directory, &socket_name);
        try security.setNonBlocking(server.stream.handle, error.SocketNonBlockingFailed);
        return .{
            .allocator = allocator,
            .canonical_state_root = canonical_state_root,
            .directory = directory,
            .socket_directory = socket_directory,
            .socket_name = socket_name,
            .socket_path = socket_path,
            .server = server,
            .socket_evidence = evidence,
        };
    }

    pub fn deinit(self: *HostRuntime) void {
        self.server.deinit();
        if (socketEvidenceAt(self.socket_directory, &self.socket_name)) |current| {
            if (std.meta.eql(current, self.socket_evidence))
                self.socket_directory.deleteFile(&self.socket_name) catch {};
        } else |_| {}
        self.socket_directory.close();
        self.directory.close();
        self.allocator.free(self.socket_path);
        self.allocator.free(self.canonical_state_root);
        self.* = undefined;
    }

    pub fn accept(self: *HostRuntime) !?std.net.Stream {
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.socket_directory, &self.socket_name),
        )) return error.SocketSubstitution;
        const connection = self.server.accept() catch |err| switch (err) {
            error.WouldBlock => return null,
            else => return err,
        };
        errdefer connection.stream.close();
        // The listener is nonblocking so the PTY/lease loop can make progress. Darwin propagates that state to accepted descriptors; control RPCs use the generated SO_RCVTIMEO bound and must block while a complete frame arrives.
        try security.setBlocking(connection.stream.handle, error.SocketBlockingFailed);
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.socket_directory, &self.socket_name),
        )) return error.SocketSubstitution;
        return connection.stream;
    }
};

pub fn executableBuildHash(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var storage: [16 * 1024]u8 = undefined;
    while (true) {
        const count = try file.read(&storage);
        if (count == 0) break;
        hasher.update(storage[0..count]);
    }
    const digest = hasher.finalResult();
    const hex = std.fmt.bytesToHex(digest, .lower);
    return allocator.dupe(u8, &hex);
}
