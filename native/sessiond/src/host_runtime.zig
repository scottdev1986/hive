const std = @import("std");
const boot_envelope = @import("boot_envelope");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const host_record = @import("host_record");
const host_registration = @import("host_registration");
const host_wire = @import("host_wire");
const protocol = @import("protocol");
const VisibilityLease = @import("visibility_lease").VisibilityLease;

const inherited_control_fd = boot_envelope.inherited_control_fd;
const ParsedRegistration = host_registration.ParsedRegistration;
const beginInheritedRegistration = host_registration.beginInheritedRegistration;
const promoteTrustedExecutableEvidence = host_registration.promoteTrustedExecutableEvidence;
const acceptPendingRegistration = host_registration.acceptPendingRegistration;
const WireLocator = host_record.WireLocator;
const readRequiredFrame = host_wire.readRequiredFrame;
const writeHostFailure = host_wire.writeFailure;

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

pub const SpawnedHost = struct {
    pid: i32,
    stream: std.net.Stream,
};

pub fn closeHostInheritedDescriptors(descriptor_limit: c_int) void {
    var fd: c_int = inherited_control_fd + 1;
    while (fd < descriptor_limit) : (fd += 1) _ = c.close(fd);
}

/// The host child must never inherit the broker's dynamic-linker knobs: any
/// DYLD_* variable in the broker's environment would inject libraries into
/// the privileged host process at exec. Everything else passes through
/// unchanged so launch behavior matches the pre-scrub baseline. The result
/// borrows the live environ entries; only the array itself is owned.
pub fn scrubbedHostEnvironment(allocator: std.mem.Allocator) ![]?[*:0]const u8 {
    var kept: usize = 0;
    var index: usize = 0;
    while (std.c.environ[index]) |entry| : (index += 1) {
        if (!std.mem.startsWith(u8, std.mem.span(entry), "DYLD_")) kept += 1;
    }
    const scrubbed = try allocator.alloc(?[*:0]const u8, kept + 1);
    errdefer allocator.free(scrubbed);
    var out: usize = 0;
    index = 0;
    while (std.c.environ[index]) |entry| : (index += 1) {
        const text = std.mem.span(entry);
        if (std.mem.startsWith(u8, text, "DYLD_")) continue;
        scrubbed[out] = entry;
        out += 1;
    }
    scrubbed[out] = null;
    return scrubbed;
}

pub fn spawnHostProcess(allocator: std.mem.Allocator, executable: []const u8) !SpawnedHost {
    if (!std.fs.path.isAbsolute(executable)) return error.InvalidHostExecutable;
    const executable_z = try allocator.dupeZ(u8, executable);
    defer allocator.free(executable_z);
    const role_z = try allocator.dupeZ(u8, "host");
    defer allocator.free(role_z);
    const descriptor_limit = c.getdtablesize();
    if (descriptor_limit <= inherited_control_fd) return error.InvalidDescriptorLimit;
    const environment = try scrubbedHostEnvironment(allocator);
    defer allocator.free(environment);

    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    errdefer {
        if (sockets[0] >= 0) _ = c.close(sockets[0]);
        if (sockets[1] >= 0) _ = c.close(sockets[1]);
    }

    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        _ = c.close(sockets[0]);
        if (sockets[1] != inherited_control_fd) {
            if (c.dup2(sockets[1], inherited_control_fd) < 0) c._exit(126);
            _ = c.close(sockets[1]);
        }
        const descriptor_flags = c.fcntl(inherited_control_fd, c.F_GETFD);
        if (descriptor_flags < 0 or
            c.fcntl(inherited_control_fd, c.F_SETFD, descriptor_flags & ~c.FD_CLOEXEC) < 0)
            c._exit(126);
        // The host inherits exactly stdio plus fd 3. Retaining the broker's
        // listener or lock descriptors would prevent clean crash recovery.
        closeHostInheritedDescriptors(descriptor_limit);
        const argv = [_:null]?[*:0]const u8{ executable_z.ptr, role_z.ptr };
        _ = c.execve(executable_z.ptr, @ptrCast(&argv), @ptrCast(environment.ptr));
        c._exit(127);
    }

    _ = c.close(sockets[1]);
    sockets[1] = -1;
    return .{
        .pid = @intCast(pid),
        .stream = .{ .handle = sockets[0] },
    };
}

pub fn killAndWait(pid: i32) void {
    if (pid <= 0) return;
    _ = c.kill(pid, c.SIGKILL);
    var status: c_int = 0;
    while (true) {
        const waited = c.waitpid(pid, &status, 0);
        if (waited == pid) return;
        if (waited >= 0) continue;
        switch (std.posix.errno(waited)) {
            .INTR => continue,
            .CHILD => return,
            else => return,
        }
    }
}

fn waitForChildExit(pid: i32, timeout_ns: u64) bool {
    var timer = std.time.Timer.start() catch return false;
    while (true) {
        var status: c_int = 0;
        const waited = c.waitpid(pid, &status, c.WNOHANG);
        if (waited == pid) return true;
        if (waited < 0) switch (std.posix.errno(waited)) {
            .INTR => continue,
            .CHILD => return true,
            else => return false,
        };
        if (timer.read() >= timeout_ns) return false;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

pub fn setControlTimeoutMs(fd: std.posix.fd_t, timeout_ms: u64) !void {
    if (timeout_ms == 0) return error.InvalidControlTimeout;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(timeout_ms / std.time.ms_per_s),
        .tv_usec = @intCast(
            (timeout_ms % std.time.ms_per_s) * std.time.us_per_ms,
        ),
    };
    if (c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0 or
        c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.ControlTimeoutUnavailable;
}

pub fn setControlTimeout(fd: std.posix.fd_t) !void {
    return setControlTimeoutMs(fd, generated.limits.control_rpc_timeout_ms);
}

/// Absolute monotonic bound on one accepted connection's cumulative service
/// time. SO_RCVTIMEO bounds each individual syscall, but a peer dribbling one
/// byte per syscall window would otherwise hold the single-threaded host loop
/// — and starve the broker's VISIBILITY_RENEW until the §21 lease self-
/// terminates the session. The budget is the same lease-bound window the
/// accept path grants a single syscall; exhausting it drops the connection
/// (fail closed) so the loop always regains control within a bounded time.
pub const ConnectionDeadline = struct {
    timer: *std.time.Timer,
    start_ns: u64,
    budget_ns: u64,

    pub fn init(timer: *std.time.Timer, lease: VisibilityLease, now_ns: u64) !ConnectionDeadline {
        const timeout_ms = try leaseBoundControlTimeoutMs(lease, now_ns);
        return .{
            .timer = timer,
            .start_ns = timer.read(),
            .budget_ns = try std.math.mul(u64, timeout_ms, std.time.ns_per_ms),
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

    /// Re-arms the per-syscall socket timeout at the remaining budget so the
    /// next blocking read/write cannot outlive the absolute deadline.
    pub fn rearm(self: *const ConnectionDeadline, handle: std.posix.fd_t) !void {
        try setControlTimeoutMs(handle, try self.remainingMs());
    }

    pub fn check(self: *const ConnectionDeadline) !void {
        _ = try self.remainingMs();
    }
};

/// One bounded frame read: the socket timeout is re-armed at the deadline's
/// remaining budget before the blocking read, and the deadline is verified
/// after it, so no sequence of dribbled syscalls outlives the budget.
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

/// Applies the lease-bound control timeout to one accepted host connection.
/// Returns false on any per-connection setup failure (lease-timeout race,
/// setsockopt on a reset/invalid socket) so the caller drops that connection
/// and keeps serving; it never surfaces a fatal error that would tear down
/// the whole host on a single bad connection.
pub fn acceptedConnectionReady(lease: VisibilityLease, handle: std.posix.fd_t, now_ns: u64) bool {
    const timeout_ms = leaseBoundControlTimeoutMs(lease, now_ns) catch return false;
    setControlTimeoutMs(handle, timeout_ms) catch return false;
    return true;
}

test "accepted-connection setup drops a bad socket without a fatal error" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var timer = try std.time.Timer.start();
    const now = timer.read();
    const lease = try VisibilityLease.initial("ws-fixture", 1, now);

    // A valid, un-expired lease + a real socket: the control timeout applies
    // and the connection is ready to serve.
    const good = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM, 0);
    try std.testing.expect(acceptedConnectionReady(lease, good, now));

    // The same fd, now closed, makes setsockopt fail (EBADF). The setup must
    // report NOT ready (drop this one connection) rather than surfacing a
    // fatal error that the host loop would let tear the whole host down.
    std.posix.close(good);
    try std.testing.expect(!acceptedConnectionReady(lease, good, now));
}

pub fn leaseBoundControlTimeoutMs(lease: VisibilityLease, now_ns: u64) !u64 {
    if (now_ns >= lease.expires_mono_ns) return error.VisibilityExpired;
    const remaining_ms = try std.math.divCeil(
        u64,
        lease.expires_mono_ns - now_ns,
        std.time.ns_per_ms,
    );
    return @min(remaining_ms, generated.limits.control_rpc_timeout_ms);
}

fn socketEvidenceAt(directory: std.fs.Dir, name: []const u8) !broker.SocketEvidence {
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
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
    if (mode) |expected| if (stat.mode & 0o777 != expected)
        return error.DirectorySubstitution;
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
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return error.SecretSubstitution;
    var actual: [32]u8 = undefined;
    defer std.crypto.secureZero(u8, &actual);
    if (try file.readAll(&actual) != actual.len) return error.InvalidAdoptionSecret;
    var extra: [1]u8 = undefined;
    if (try file.read(&extra) != 0) return error.InvalidAdoptionSecret;
    if (!std.crypto.timing_safe.eql([32]u8, actual, expected))
        return error.SecretSubstitution;
}

pub const HostRuntime = struct {
    allocator: std.mem.Allocator,
    canonical_home: []u8,
    directory: std.fs.Dir,
    socket_path: []u8,
    server: std.net.Server,
    socket_evidence: broker.SocketEvidence,

    pub fn open(
        allocator: std.mem.Allocator,
        hive_home: []const u8,
        session_id: []const u8,
        adoption_secret: [32]u8,
    ) !HostRuntime {
        if (!protocol.validSessionId(session_id)) return error.InvalidSessionId;
        const canonical_home = try std.fs.cwd().realpathAlloc(allocator, hive_home);
        errdefer allocator.free(canonical_home);
        var home = try std.fs.cwd().openDir(canonical_home, .{ .no_follow = true });
        defer home.close();
        var runtime = try home.openDir("runtime", .{ .no_follow = true });
        defer runtime.close();
        // The broker owns `$HIVE_HOME/runtime`; the private authority boundary
        // begins at runtime/sessiond, which is mode 0700.
        try requireOwnedDirectory(runtime, null);
        var sessiond = try runtime.openDir("sessiond", .{ .no_follow = true });
        defer sessiond.close();
        try requireOwnedDirectory(sessiond, 0o700);
        var hosts = try sessiond.openDir("hosts", .{ .no_follow = true });
        defer hosts.close();
        try requireOwnedDirectory(hosts, 0o700);
        var directory = try hosts.openDir(session_id, .{ .no_follow = true, .iterate = true });
        errdefer directory.close();
        try requireOwnedDirectory(directory, 0o700);
        try readAndVerifyAdoptionSecret(directory, adoption_secret);
        _ = std.posix.fstatat(
            directory.fd,
            "host.sock",
            std.posix.AT.SYMLINK_NOFOLLOW,
        ) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return error.SocketSubstitution,
        };

        const socket_path = try std.fs.path.join(allocator, &.{
            canonical_home,
            "runtime/sessiond/hosts",
            session_id,
            "host.sock",
        });
        errdefer allocator.free(socket_path);
        const address = try std.net.Address.initUnix(socket_path);
        // host.sock's 0600 mode is fixed atomically at bind() through a
        // saved/restored umask: 0177 masks exactly group/other (and the
        // owner-execute bit) off the 0777 bind base. A post-bind path chmod
        // both follows symlinks and leaves the socket briefly permissive, so
        // no path-based chmod remains — socketEvidenceAt below is the fstat
        // proof of the mode the socket was born with.
        const saved_umask = c.umask(0o177);
        const listen_result = address.listen(.{});
        _ = c.umask(saved_umask);
        var server = try listen_result;
        errdefer server.deinit();
        const evidence = try socketEvidenceAt(directory, "host.sock");
        const flags = c.fcntl(server.stream.handle, c.F_GETFL);
        if (flags < 0 or c.fcntl(server.stream.handle, c.F_SETFL, flags | c.O_NONBLOCK) < 0)
            return error.SocketNonBlockingFailed;
        return .{
            .allocator = allocator,
            .canonical_home = canonical_home,
            .directory = directory,
            .socket_path = socket_path,
            .server = server,
            .socket_evidence = evidence,
        };
    }

    pub fn deinit(self: *HostRuntime) void {
        self.server.deinit();
        if (socketEvidenceAt(self.directory, "host.sock")) |current| {
            if (std.meta.eql(current, self.socket_evidence))
                self.directory.deleteFile("host.sock") catch {};
        } else |_| {}
        self.directory.close();
        self.allocator.free(self.socket_path);
        self.allocator.free(self.canonical_home);
        self.* = undefined;
    }

    pub fn accept(self: *HostRuntime) !?std.net.Stream {
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.directory, "host.sock"),
        )) return error.SocketSubstitution;
        const connection = self.server.accept() catch |err| switch (err) {
            error.WouldBlock => return null,
            else => return err,
        };
        errdefer connection.stream.close();
        // The listener is nonblocking so the PTY/lease loop can make
        // progress. Darwin propagates that state to accepted descriptors;
        // broker RPCs use the generated SO_RCVTIMEO bound and must block
        // while a complete frame arrives.
        const flags = c.fcntl(connection.stream.handle, c.F_GETFL);
        if (flags < 0 or
            c.fcntl(connection.stream.handle, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0)
            return error.SocketBlockingFailed;
        if (!std.meta.eql(
            self.socket_evidence,
            try socketEvidenceAt(self.directory, "host.sock"),
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

pub const LaunchClient = struct {
    allocator: std.mem.Allocator,
    parsed: ParsedRegistration,
    wire: broker.WireHostClient,
    host_pid: i32,
    /// Retained so finalize can prove THIS broker owns the freshly admitted
    /// host (the host fails closed for privileged RPCs until HOST_ADOPT).
    /// Zeroed on every teardown path.
    adoption_secret: [32]u8,
    pending_id: ?broker.PendingRegistration,
    pending_stream: ?std.net.Stream,
    pending_header: protocol.Header,

    fn deinit(self: *LaunchClient) void {
        if (self.pending_stream) |stream| {
            stream.close();
            killAndWait(self.host_pid);
        }
        // Closing broker control must not kill a successfully registered host.
        // The host's independent visibility lease owns broker-crash cleanup.
        self.wire.deinit();
        self.parsed.deinit(self.allocator);
        std.crypto.secureZero(u8, &self.adoption_secret);
        self.* = undefined;
    }

    fn control(self: *LaunchClient) broker.HostControl {
        return self.wire.control();
    }
};

/// Production WP3 HostLauncher injection. It forks and execs the exact
/// executable argument in `host` role and transfers all sensitive boot state
/// only through fd 3. The launcher owns returned HostControl contexts.
pub const ProductionHostLauncher = struct {
    allocator: std.mem.Allocator,
    canonical_home: []u8,
    next_pending_id: broker.PendingRegistration = 1,
    clients: std.ArrayList(*LaunchClient) = .{},

    pub fn init(
        allocator: std.mem.Allocator,
        hive_home: []const u8,
    ) !ProductionHostLauncher {
        return .{
            .allocator = allocator,
            .canonical_home = try std.fs.cwd().realpathAlloc(allocator, hive_home),
        };
    }

    pub fn deinit(self: *ProductionHostLauncher) void {
        for (self.clients.items) |client| {
            client.deinit();
            self.allocator.destroy(client);
        }
        self.clients.deinit(self.allocator);
        self.allocator.free(self.canonical_home);
        self.* = undefined;
    }

    pub fn launcher(self: *ProductionHostLauncher) broker.HostLauncher {
        return .{
            .context = self,
            .launch_fn = launchCallback,
            .finalize_fn = finalizeCallback,
        };
    }

    fn launchCallback(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        adoption_secret: [32]u8,
        broker_now_ns: u64,
    ) ?broker.HostLaunchReadback {
        // This value is intentionally non-authoritative in the host process's
        // independent monotonic clock domain.
        _ = broker_now_ns;
        const self: *ProductionHostLauncher = @ptrCast(@alignCast(context));
        return self.launchOne(
            allocator,
            executable,
            spec_json,
            initial_input,
            adoption_secret,
        ) catch |err| {
            std.log.err("production host launch failed: {s}; broker will report verification_unknown", .{
                @errorName(err),
            });
            return null;
        };
    }

    fn launchOne(
        self: *ProductionHostLauncher,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        adoption_secret: [32]u8,
    ) !broker.HostLaunchReadback {
        if (!protocol.validateControlPayload(
            allocator,
            generated.wire_schema.create_begin_payload,
            spec_json,
        )) return error.InvalidCreateSpec;
        const SpecProjection = struct {
            locator: WireLocator,
            argv: []const []const u8,
            expectedExecutable: []const u8,
        };
        var spec = try std.json.parseFromSlice(SpecProjection, allocator, spec_json, .{
            .ignore_unknown_fields = true,
        });
        defer spec.deinit();
        const instance_id = spec.value.locator.instanceId;
        const build_id = try executableBuildHash(allocator, executable);
        defer allocator.free(build_id);

        var child = try spawnHostProcess(allocator, executable);
        var child_owned = true;
        errdefer if (child_owned) killAndWait(child.pid);
        var stream_owned = true;
        errdefer if (stream_owned) child.stream.close();
        try setControlTimeout(child.stream.handle);
        var pending = try beginInheritedRegistration(
            allocator,
            child.stream,
            spec_json,
            initial_input,
            adoption_secret,
            build_id,
            instance_id,
        );
        var parsed_owned = true;
        errdefer if (parsed_owned) pending.parsed.deinit(allocator);
        if (pending.parsed.registration.record.host_pid != child.pid or
            !std.mem.eql(u8, pending.parsed.registration.record.locator.session_id, spec.value.locator.sessionId))
            return error.HostIdentityMismatch;
        const observed = try broker.inspectProcess(child.pid);
        var token_storage: [64]u8 = undefined;
        const token = try broker.formatStartToken(observed.start_token, &token_storage);
        if (!std.mem.eql(u8, token, pending.parsed.registration.record.host_start_token) or
            !std.mem.eql(u8, observed.executablePath(), executable))
            return error.HostIdentityMismatch;

        const host_directory_path = try std.fs.path.join(allocator, &.{
            self.canonical_home,
            "runtime/sessiond/hosts",
            spec.value.locator.sessionId,
        });
        defer allocator.free(host_directory_path);
        var host_directory = try std.fs.openDirAbsolute(host_directory_path, .{
            .no_follow = true,
        });
        defer host_directory.close();
        try requireOwnedDirectory(host_directory, 0o700);
        const socket_evidence = try socketEvidenceAt(host_directory, "host.sock");
        const socket_path = try std.fs.path.join(allocator, &.{
            host_directory_path,
            "host.sock",
        });
        defer allocator.free(socket_path);
        var wire = try broker.WireHostClient.init(
            allocator,
            host_directory,
            socket_path,
            socket_evidence,
            pending.parsed.registration.record,
            build_id,
        );
        errdefer wire.deinit();
        try wire.enableNeutralControl(self.canonical_home);
        const created_payload = try promoteTrustedExecutableEvidence(
            allocator,
            spec.value.expectedExecutable,
            spec.value.argv,
            &pending.parsed,
        );
        errdefer allocator.free(created_payload);

        const pending_id = self.next_pending_id;
        self.next_pending_id = std.math.add(
            broker.PendingRegistration,
            pending_id,
            1,
        ) catch return error.PendingRegistrationExhausted;

        const client = try self.allocator.create(LaunchClient);
        errdefer self.allocator.destroy(client);
        client.* = .{
            .allocator = allocator,
            .parsed = pending.parsed,
            .wire = wire,
            .host_pid = child.pid,
            .adoption_secret = adoption_secret,
            .pending_id = pending_id,
            .pending_stream = child.stream,
            .pending_header = pending.request_header,
        };
        try self.clients.append(self.allocator, client);
        parsed_owned = false;
        child_owned = false;
        stream_owned = false;
        return .{
            .record = client.parsed.registration.record,
            .record_json = client.parsed.record_json,
            .created_payload = created_payload,
            .host = client.control(),
            .pending = pending_id,
        };
    }

    fn finalizeCallback(
        context: *anyopaque,
        pending: broker.PendingRegistration,
        decision: broker.HostLaunchDecision,
    ) bool {
        const self: *ProductionHostLauncher = @ptrCast(@alignCast(context));
        return self.finalizeOne(pending, decision) catch false;
    }

    pub fn finalizeOne(
        self: *ProductionHostLauncher,
        pending: broker.PendingRegistration,
        decision: broker.HostLaunchDecision,
    ) !bool {
        var index: usize = 0;
        while (index < self.clients.items.len) : (index += 1) {
            if (self.clients.items[index].pending_id == pending) break;
        }
        if (index == self.clients.items.len) return false;
        const client = self.clients.items[index];
        const stream = client.pending_stream orelse return false;
        client.pending_id = null;
        client.pending_stream = null;

        switch (decision) {
            .admitted => {
                acceptPendingRegistration(stream, client.pending_header) catch {
                    stream.close();
                    killAndWait(client.host_pid);
                    _ = self.clients.orderedRemove(index);
                    client.deinit();
                    self.allocator.destroy(client);
                    return false;
                };
                stream.close();
                // Admission is final, so the host now serves host.sock — but
                // it fails closed for terminate/grant_register/
                // visibility_renew until HOST_ADOPT proves the 32-byte secret.
                // Adopt immediately so the legit fresh-launch flow keeps
                // working; a host that refuses adoption is not the host this
                // broker launched and must not stay registered. The readback
                // is discarded, so its now_ns input is irrelevant (0).
                if (client.control().adopt(
                    client.parsed.registration.record.locator,
                    client.adoption_secret,
                    0,
                ) == null) {
                    killAndWait(client.host_pid);
                    _ = self.clients.orderedRemove(index);
                    client.deinit();
                    self.allocator.destroy(client);
                    return false;
                }
                return true;
            },
            .rejected => |code| {
                const wrote_rejection = blk: {
                    writeHostFailure(
                        client.allocator,
                        stream,
                        client.pending_header,
                        code,
                    ) catch break :blk false;
                    break :blk true;
                };
                stream.close();
                const exited_cleanly = waitForChildExit(
                    client.host_pid,
                    generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms,
                );
                if (!exited_cleanly) killAndWait(client.host_pid);
                _ = self.clients.orderedRemove(index);
                client.deinit();
                self.allocator.destroy(client);
                return wrote_rejection and exited_cleanly;
            },
        }
    }
};
