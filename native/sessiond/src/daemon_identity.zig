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
    var reaped_by_earlier_observation = false;
    if (ownership == .child) {
        // Child ownership is recorded only after exact launch identity readback. Until this broker reaps it, that PID cannot be reused.
        var status: c_int = 0;
        const waited = c.waitpid(pid, &status, c.WNOHANG);
        if (waited == pid) return .absent;
        if (waited != 0) {
            // ECHILD is not "I cannot tell": it means this PID is not a child of ours to wait for, and the ordinary way that happens is that an earlier observation on this same path already reaped it. Treat that as "look harder", never as `unknown`: `unknown` occupies a registry slot forever, so a host killed through a TERMINATE whose readback did not verify would take its slot with it and starve capacity until restart. Falling through to the ordinary identity evidence is strictly more evidence, never less: a gone PID answers absent through the kill probe, a REUSED PID answers absent on the start token, and a live process whose recorded identity still matches answers present. Absence is never asserted from ECHILD alone.
            if (std.posix.errno(waited) != .CHILD) return .unknown;
            reaped_by_earlier_observation = true;
        }
    }

    const observed = inspectProcess(pid) catch return observeKillAbsence(pid);
    var token_storage: [64]u8 = undefined;
    const token = formatStartToken(observed.start_token, &token_storage) catch return .unknown;
    if (!std.mem.eql(u8, token, expected_start_token)) return .absent;

    if (ownership == .child and !reaped_by_earlier_observation) return .present;

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

/// Captures kernel-owned identity before HELLO. JSON claims are never used to populate any field returned here.
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

pub fn selectProtocolMinor(client: SessionProtocolRange) ?u8 {
    if (client.major != generated.protocol_major or client.minMinor > client.maxMinor)
        return null;
    const selected = @min(client.maxMinor, generated.protocol_max_minor);
    if (selected < client.minMinor or selected < generated.protocol_min_minor) return null;
    return selected;
}

// Forks a real `/bin/sleep` child and polls until its start token is observable. The token borrows `token_storage`, which the caller owns.
fn forkSleepingChild(token_storage: *[64]u8) !struct { pid: i32, start_token: []const u8 } {
    const pid = try std.posix.fork();
    if (pid == 0) {
        const argv = [_:null]?[*:0]const u8{ "sleep", "30", null };
        const envp = [_:null]?[*:0]const u8{null};
        std.posix.execveZ("/bin/sleep", &argv, &envp) catch {};
        std.posix.exit(127);
    }

    var observed = inspectProcess(pid);
    var attempts: usize = 0;
    while (std.meta.isError(observed) and attempts < 200) : (attempts += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
        observed = inspectProcess(pid);
    }
    // The caller's cleanup defer is not registered yet, so a failure after the fork must reap the child here rather than orphan it.
    const present = observed catch |err| {
        _ = c.kill(pid, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(pid, &status, 0);
        return err;
    };
    return .{
        .pid = pid,
        .start_token = try formatStartToken(present.start_token, token_storage),
    };
}

// A killed child host must stay reclaimable after the first observation has already reaped it. `waitForExactProcessAbsence` runs inside TERMINATE and consumes the exit status; the broker's later `reapExitedHosts` pass is what actually returns the registry slot, and it must not be told `unknown` merely because there is no exit status left to collect. Real fork/exec/kill: a simulated PID cannot exercise waitpid's ECHILD at all.
test "an already-reaped child host is still observed absent" {
    var token_storage: [64]u8 = undefined;
    const child = try forkSleepingChild(&token_storage);
    const pid = child.pid;
    const start_token = child.start_token;

    try std.testing.expectEqual(
        ExactProcessPresence.present,
        observeExactProcess(pid, start_token, .child),
    );

    _ = c.kill(pid, c.SIGKILL);
    try std.testing.expect(waitForExactProcessAbsence(pid, start_token, .child));
    // Every observation after it is the broker's reap pass, and must agree.
    try std.testing.expectEqual(
        ExactProcessPresence.absent,
        observeExactProcess(pid, start_token, .child),
    );
    try std.testing.expectEqual(
        ExactProcessPresence.absent,
        observeExactProcess(pid, start_token, .child),
    );
}

// The fall-through must never manufacture absence. A live child whose recorded identity still matches is present, however its exit status was accounted for.
test "a live child host is never reported absent" {
    var token_storage: [64]u8 = undefined;
    const child = try forkSleepingChild(&token_storage);
    const pid = child.pid;
    const start_token = child.start_token;
    defer {
        _ = c.kill(pid, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(pid, &status, 0);
    }

    var index: usize = 0;
    while (index < 5) : (index += 1) {
        try std.testing.expectEqual(
            ExactProcessPresence.present,
            observeExactProcess(pid, start_token, .child),
        );
    }
}
