const std = @import("std");
const protocol = @import("protocol");
const generated = @import("session_protocol_generated");

const c = @cImport({
    @cInclude("libproc.h");
    @cInclude("signal.h");
    @cInclude("sys/proc_info.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/un.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

pub const ProcessStartToken = struct {
    seconds: u64,
    microseconds: u64,
};

pub const ObservedProcess = struct {
    pid: i32,
    start_token: ProcessStartToken,
    executable: [c.PROC_PIDPATHINFO_MAXSIZE]u8,
    executable_len: usize,

    pub fn executablePath(self: *const ObservedProcess) []const u8 {
        return self.executable[0..self.executable_len];
    }
};

pub fn formatStartToken(token: ProcessStartToken, output: []u8) ![]const u8 {
    return std.fmt.bufPrint(output, "{d}:{d}", .{ token.seconds, token.microseconds });
}

pub fn inspectProcess(pid: i32) !ObservedProcess {
    if (pid <= 0) return error.InvalidPid;
    var info: c.struct_proc_bsdinfo = std.mem.zeroes(c.struct_proc_bsdinfo);
    const info_len = c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(c.struct_proc_bsdinfo));
    if (info_len != @sizeOf(c.struct_proc_bsdinfo)) return error.PeerStartTokenUnavailable;
    var result: ObservedProcess = .{
        .pid = pid,
        .start_token = .{ .seconds = info.pbi_start_tvsec, .microseconds = info.pbi_start_tvusec },
        .executable = undefined,
        .executable_len = 0,
    };
    const path_len = c.proc_pidpath(pid, &result.executable, result.executable.len);
    if (path_len <= 0) return error.PeerExecutableUnavailable;
    result.executable_len = @intCast(path_len);
    return result;
}

pub const ExactProcessPresence = enum { present, absent, unknown };
pub const HostProcessOwnership = enum { child, non_parent };

fn observeKillAbsence(pid: i32) ExactProcessPresence {
    const rc = c.kill(pid, 0);
    if (rc == 0 or std.posix.errno(rc) != .SRCH) return .unknown;
    return .absent;
}

pub fn observeExactProcess(
    pid: i32,
    expected_start_token: []const u8,
    ownership: HostProcessOwnership,
) ExactProcessPresence {
    if (pid <= 0 or expected_start_token.len == 0) return .unknown;
    if (ownership == .child) {
        // Child ownership is recorded only after exact launch identity
        // readback. Until this broker reaps it, that PID cannot be reused.
        var status: c_int = 0;
        const waited = c.waitpid(pid, &status, c.WNOHANG);
        if (waited == pid) return .absent;
        if (waited != 0) return .unknown;
    }

    const observed = inspectProcess(pid) catch return observeKillAbsence(pid);
    var token_storage: [64]u8 = undefined;
    const token = formatStartToken(observed.start_token, &token_storage) catch return .unknown;
    if (!std.mem.eql(u8, token, expected_start_token)) return .absent;

    if (ownership == .child) return .present;

    const rc = c.kill(pid, 0);
    if (rc == 0) return .present;
    return if (std.posix.errno(rc) == .SRCH) .absent else .unknown;
}

const host_exit_observation_timeout_ns = generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms;
const host_exit_poll_interval_ns = 5 * std.time.ns_per_ms;

pub fn waitForExactProcessAbsence(
    pid: i32,
    expected_start_token: []const u8,
    ownership: HostProcessOwnership,
) bool {
    var timer = std.time.Timer.start() catch return false;
    while (true) {
        if (observeExactProcess(pid, expected_start_token, ownership) == .absent) return true;
        if (timer.read() >= host_exit_observation_timeout_ns) return false;
        std.Thread.sleep(host_exit_poll_interval_ns);
    }
}

pub const ObservedPeer = struct {
    uid: u32,
    gid: u32,
    pid: i32,
    start_token: ProcessStartToken,
    executable: [c.PROC_PIDPATHINFO_MAXSIZE]u8,
    executable_len: usize,

    pub fn executablePath(self: *const ObservedPeer) []const u8 {
        return self.executable[0..self.executable_len];
    }
};

/// Captures kernel-owned identity before HELLO. JSON claims are never used to
/// populate any field returned here.
pub fn inspectPeer(socket_fd: std.posix.fd_t) !ObservedPeer {
    var uid: c.uid_t = 0;
    var gid: c.gid_t = 0;
    if (c.getpeereid(socket_fd, &uid, &gid) != 0) return error.PeerCredentialsUnavailable;

    var pid: c.pid_t = 0;
    var pid_len: c.socklen_t = @sizeOf(c.pid_t);
    if (c.getsockopt(socket_fd, c.SOL_LOCAL, c.LOCAL_PEERPID, &pid, &pid_len) != 0 or
        pid_len != @sizeOf(c.pid_t) or pid <= 0)
        return error.PeerPidUnavailable;

    const process = try inspectProcess(pid);

    const result: ObservedPeer = .{
        .uid = @intCast(uid),
        .gid = @intCast(gid),
        .pid = @intCast(pid),
        .start_token = process.start_token,
        .executable = process.executable,
        .executable_len = process.executable_len,
    };
    return result;
}

pub const ExpectedPeer = struct {
    uid: u32,
    gid: u32,
    pid: i32,
    start_token: []const u8,
    executable: []const u8,
};

pub const DaemonClaimChecks = struct {
    product: bool,
    build: bool,
    protocol: bool,
    schema: bool,
    instance: bool,
    project: bool,
};

pub const VersionRange = struct { min: f64, max: f64 };
pub const SessionProtocolRange = struct { major: u8, minMinor: u8, maxMinor: u8 };

pub const DaemonControlIdentity = struct {
    productVersion: []const u8,
    buildHash: []const u8,
    wireProtocol: VersionRange,
    schemaEpoch: f64,
    instanceId: []const u8,
    hiveUuid: []const u8,
    identityKey: []const u8,
    repoFamilyKey: ?[]const u8,
};

pub const DaemonHello = struct {
    schemaVersion: u8,
    buildId: []const u8,
    instanceId: []const u8,
    protocol: SessionProtocolRange,
    clientRole: []const u8,
    daemonControl: DaemonControlIdentity,
};

pub const DaemonHandshake = struct {
    productVersion: []const u8,
    buildHash: []const u8,
    wireProtocol: VersionRange,
    schemaEpoch: f64,
    capabilities: []const []const u8,
    instanceId: []const u8,
    hiveUuid: []const u8,
    identityKey: []const u8,
    repoFamilyKey: ?[]const u8,
    generation: f64,
};

pub const DaemonLock = struct {
    pid: i32,
    instanceId: []const u8,
    startedAt: []const u8,
    startToken: []const u8,
    executablePath: []const u8,
};

pub fn equalOptionalString(left: ?[]const u8, right: ?[]const u8) bool {
    if (left == null or right == null) return left == null and right == null;
    return std.mem.eql(u8, left.?, right.?);
}

pub fn verifyDaemonHello(hello: DaemonHello, expected: DaemonHandshake) ?protocol.Failure {
    if (!std.mem.eql(u8, hello.clientRole, "daemon"))
        return .{ .code = .forbidden, .close_connection = true };
    if (!std.mem.eql(u8, hello.instanceId, expected.instanceId) or
        !std.mem.eql(u8, hello.daemonControl.instanceId, expected.instanceId))
        return .{ .code = .instance_mismatch, .close_connection = true };
    if (selectProtocolMinor(hello.protocol) == null or
        hello.daemonControl.wireProtocol.min != expected.wireProtocol.min or
        hello.daemonControl.wireProtocol.max != expected.wireProtocol.max)
        return .{ .code = .protocol_mismatch, .close_connection = true };
    if (!std.mem.eql(u8, hello.buildId, expected.buildHash) or
        !std.mem.eql(u8, hello.daemonControl.buildHash, expected.buildHash) or
        hello.daemonControl.schemaEpoch != expected.schemaEpoch)
        return .{ .code = .protocol_mismatch, .close_connection = true };
    if (!std.mem.eql(u8, hello.daemonControl.productVersion, expected.productVersion) or
        !std.mem.eql(u8, hello.daemonControl.hiveUuid, expected.hiveUuid) or
        !std.mem.eql(u8, hello.daemonControl.identityKey, expected.identityKey) or
        !equalOptionalString(hello.daemonControl.repoFamilyKey, expected.repoFamilyKey))
        return .{ .code = .forbidden, .close_connection = true };
    return null;
}

pub fn selectProtocolMinor(client: SessionProtocolRange) ?u8 {
    if (client.major != generated.protocol_major or client.minMinor > client.maxMinor)
        return null;
    const selected = @min(client.maxMinor, generated.protocol_max_minor);
    if (selected < client.minMinor or selected < generated.protocol_min_minor) return null;
    return selected;
}

pub fn parseDaemonHello(allocator: std.mem.Allocator, payload: []const u8) !std.json.Parsed(DaemonHello) {
    if (!protocol.validateControlPayload(allocator, generated.wire_schema.hello_payload, payload))
        return error.MalformedDaemonHello;
    const parsed = try std.json.parseFromSlice(DaemonHello, allocator, payload, .{
        .allocate = .alloc_always,
    });
    if (parsed.value.schemaVersion != 1 or !std.mem.eql(u8, parsed.value.clientRole, "daemon")) {
        var owned = parsed;
        owned.deinit();
        return error.MalformedDaemonHello;
    }
    return parsed;
}
pub fn verifyDaemonPeer(
    observed: *const ObservedPeer,
    expected: ExpectedPeer,
    claims: DaemonClaimChecks,
) ?protocol.Failure {
    var token_buffer: [64]u8 = undefined;
    const observed_token = formatStartToken(observed.start_token, &token_buffer) catch
        return .{ .code = .unauthenticated, .close_connection = true };
    if (observed.uid != expected.uid or observed.gid != expected.gid or observed.pid != expected.pid or
        !std.mem.eql(u8, observed_token, expected.start_token) or
        !std.mem.eql(u8, observed.executablePath(), expected.executable))
        return .{ .code = .unauthenticated, .close_connection = true };
    if (!claims.instance) return .{ .code = .instance_mismatch, .close_connection = true };
    if (!claims.product or !claims.build or !claims.protocol or !claims.schema or !claims.project)
        return .{ .code = .forbidden, .close_connection = true };
    return null;
}
