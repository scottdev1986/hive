//! §21 Process-inspection and termination algorithm — standalone module.
//!
//! Snapshot a verified root + descendants (proc_listchildpids / proc_pidinfo)
//! until two consecutive passes match or a 250 ms deadline expires. Record
//! PID / start-token / parent / pgid / session / executable. Graceful and
//! immediate termination signal deepest-first with positive wait/absence
//! readback. NEVER report terminated without wait/absence evidence.
//!
//! Authority: docs/design/terminal-stack-transition.html §21.
//! Timeouts from the doc only: 250 ms inspection, TERM-after-2s, KILL-after-2s.

const std = @import("std");
const posix = std.posix;
const builtin = @import("builtin");

const c = @cImport({
    @cInclude("libproc.h");
    @cInclude("sys/proc_info.h");
    @cInclude("sys/wait.h");
    @cInclude("signal.h");
    @cInclude("unistd.h");
});

/// §21 inspection deadline.
pub const inspection_deadline_ns: u64 = 250 * std.time.ns_per_ms;
/// §21 graceful: TERM the verified process group after 2 seconds…
pub const graceful_term_wait_ns: u64 = 2 * std.time.ns_per_s;
/// …and KILL verified survivors after another 2 seconds.
pub const graceful_kill_wait_ns: u64 = 2 * std.time.ns_per_s;
/// Immediate-stop settle bound (positive readback window after KILL).
pub const immediate_kill_wait_ns: u64 = 2 * std.time.ns_per_s;

pub const StartToken = struct {
    seconds: u64,
    microseconds: u64,

    pub fn eql(self: StartToken, other: StartToken) bool {
        return self.seconds == other.seconds and self.microseconds == other.microseconds;
    }

    pub fn format(self: StartToken, buf: []u8) ![]const u8 {
        return std.fmt.bufPrint(buf, "{d}:{d}", .{ self.seconds, self.microseconds });
    }
};

pub const ProcessIdentity = struct {
    pid: i32,
    start_token: StartToken,
    parent: i32,
    pgid: i32,
    session: i32,
    executable: [c.PROC_PIDPATHINFO_MAXSIZE]u8 = undefined,
    executable_len: usize = 0,
    /// Depth from the verified root (0 = root). Used for deepest-first order.
    depth: u32 = 0,

    pub fn executablePath(self: *const ProcessIdentity) []const u8 {
        return self.executable[0..self.executable_len];
    }

    pub fn sameIdentity(self: ProcessIdentity, other: ProcessIdentity) bool {
        return self.pid == other.pid and self.start_token.eql(other.start_token);
    }
};

pub const SnapshotStatus = enum {
    /// Two consecutive passes matched within the deadline.
    stable,
    /// Tree changed or was incomplete through the deadline — explicit UNKNOWN.
    unknown,
};

pub const Snapshot = struct {
    status: SnapshotStatus,
    /// Members observed on the last complete pass (may be partial when unknown).
    members: []ProcessIdentity,
    /// True when the verified root itself could not be revalidated.
    root_missing: bool = false,

    pub fn deinit(self: *Snapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.members);
        self.* = undefined;
    }
};

pub const TerminationMode = enum { graceful, immediate };

pub const MemberFate = enum {
    /// wait/absence evidence confirmed the exact PID+start-token is gone.
    terminated,
    /// Still alive with matching start token after the full stop policy.
    survivor,
    /// Could not revalidate (permission, PID reuse mismatch, unobservable).
    unknown,
};

pub const MemberResult = struct {
    identity: ProcessIdentity,
    fate: MemberFate,
    reason: []const u8,
};

pub const TerminationState = enum {
    terminated,
    survivors,
    unknown,
};

pub const TerminationResult = struct {
    state: TerminationState,
    members: []MemberResult,
    /// Snapshot completeness at capture time.
    snapshot_status: SnapshotStatus,

    pub fn deinit(self: *TerminationResult, allocator: std.mem.Allocator) void {
        allocator.free(self.members);
        self.* = undefined;
    }
};

pub const Error = error{
    InvalidRoot,
    InspectionFailed,
    OutOfMemory,
};

/// Injected clocks / signals for unit tests. Production uses RealPlatform.
pub const Platform = struct {
    context: *anyopaque,
    monoNowFn: *const fn (context: *anyopaque) u64,
    sleepFn: *const fn (context: *anyopaque, ns: u64) void,
    /// Signal one process. Returns true if the signal was delivered or the
    /// process was already absent (ESRCH).
    killFn: *const fn (context: *anyopaque, pid: i32, sig: i32) bool,
    /// Observe identity for a live pid. null means absent/unobservable.
    observeFn: *const fn (context: *anyopaque, pid: i32) ?ProcessIdentity,
    /// List direct children of pid. Caller owns the returned slice.
    listChildrenFn: *const fn (context: *anyopaque, allocator: std.mem.Allocator, pid: i32) anyerror![]i32,

    pub fn monoNow(self: Platform) u64 {
        return self.monoNowFn(self.context);
    }
    pub fn sleep(self: Platform, ns: u64) void {
        self.sleepFn(self.context, ns);
    }
    pub fn kill(self: Platform, pid: i32, sig: i32) bool {
        return self.killFn(self.context, pid, sig);
    }
    pub fn observe(self: Platform, pid: i32) ?ProcessIdentity {
        return self.observeFn(self.context, pid);
    }
    pub fn listChildren(self: Platform, allocator: std.mem.Allocator, pid: i32) ![]i32 {
        return self.listChildrenFn(self.context, allocator, pid);
    }
};

/// Production macOS platform: real proc_listchildpids / proc_pidinfo / kill.
pub const RealPlatform = struct {
    pub fn platform() Platform {
        return .{
            .context = undefined,
            .monoNowFn = monoNow,
            .sleepFn = sleep,
            .killFn = kill,
            .observeFn = observe,
            .listChildrenFn = listChildren,
        };
    }

    fn monoNow(_: *anyopaque) u64 {
        return @intCast(std.time.nanoTimestamp());
    }

    fn sleep(_: *anyopaque, ns: u64) void {
        std.Thread.sleep(ns);
    }

    fn kill(_: *anyopaque, pid: i32, sig: i32) bool {
        if (pid <= 1) return false;
        const rc = c.kill(pid, sig);
        if (rc == 0) return true;
        // ESRCH: already gone — counts as delivered for acting purposes, but
        // fate still requires absence/start-token readback.
        return posix.errno(rc) == .SRCH;
    }

    fn observe(_: *anyopaque, pid: i32) ?ProcessIdentity {
        return observeProcess(pid);
    }

    fn listChildren(_: *anyopaque, allocator: std.mem.Allocator, pid: i32) ![]i32 {
        return listChildPids(allocator, pid);
    }
};

pub fn observeProcess(pid: i32) ?ProcessIdentity {
    if (pid <= 0) return null;
    var info: c.struct_proc_bsdinfo = std.mem.zeroes(c.struct_proc_bsdinfo);
    const info_len = c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(c.struct_proc_bsdinfo));
    if (info_len != @sizeOf(c.struct_proc_bsdinfo)) return null;

    var result: ProcessIdentity = .{
        .pid = pid,
        .start_token = .{
            .seconds = info.pbi_start_tvsec,
            .microseconds = info.pbi_start_tvusec,
        },
        .parent = @intCast(info.pbi_ppid),
        .pgid = @intCast(info.pbi_pgid),
        .session = c.getsid(pid),
    };
    const path_len = c.proc_pidpath(pid, &result.executable, result.executable.len);
    if (path_len > 0) {
        result.executable_len = @intCast(path_len);
    } else {
        // Executable unavailable: still record the rest; incomplete identity
        // contributes to unknown if the root cannot be fully described.
        result.executable_len = 0;
    }
    return result;
}

fn listChildPids(allocator: std.mem.Allocator, pid: i32) ![]i32 {
    // macOS libproc: proc_listchildpids writes pid_t entries and returns the
    // NUMBER OF PIDS written (measured on Darwin 24 / macOS 14+). Treating the
    // return as a byte count silently drops every tree (divTrunc(1, 4) == 0).
    // The nested-tree unit test is the positive control for that bug.
    var buf: [4096]c.pid_t = undefined;
    const got = c.proc_listchildpids(pid, &buf, @sizeOf(@TypeOf(buf)));
    if (got < 0) return error.InspectionFailed;
    const n: usize = @intCast(got);
    if (n > buf.len) return error.InspectionFailed;
    const out = try allocator.alloc(i32, n);
    for (buf[0..n], 0..) |child, i| out[i] = @intCast(child);
    return out;
}

fn identityLess(a: ProcessIdentity, b: ProcessIdentity) bool {
    if (a.pid != b.pid) return a.pid < b.pid;
    if (a.start_token.seconds != b.start_token.seconds)
        return a.start_token.seconds < b.start_token.seconds;
    return a.start_token.microseconds < b.start_token.microseconds;
}

fn sortIdentities(slice: []ProcessIdentity) void {
    // Insertion sort: ProcessIdentity holds a 4 KiB path buffer; std.mem.sort's
    // SIMD path overflows on that element size (Zig 0.15.2).
    var i: usize = 1;
    while (i < slice.len) : (i += 1) {
        var j = i;
        while (j > 0 and identityLess(slice[j], slice[j - 1])) : (j -= 1) {
            const tmp = slice[j - 1];
            slice[j - 1] = slice[j];
            slice[j] = tmp;
        }
    }
}

fn identitiesMatch(a: []const ProcessIdentity, b: []const ProcessIdentity) bool {
    if (a.len != b.len) return false;
    for (a, b) |left, right| {
        if (!left.sameIdentity(right)) return false;
        if (left.parent != right.parent or left.pgid != right.pgid or left.session != right.session)
            return false;
        if (!std.mem.eql(u8, left.executablePath(), right.executablePath())) return false;
    }
    return true;
}

/// Walk descendants of `root_pid` (must be live and match `root_token` if set).
fn collectTree(
    platform: Platform,
    allocator: std.mem.Allocator,
    root_pid: i32,
    expected_root_token: ?StartToken,
) !struct { members: []ProcessIdentity, root_missing: bool, incomplete: bool } {
    const root_obs = platform.observe(root_pid) orelse {
        return .{ .members = try allocator.alloc(ProcessIdentity, 0), .root_missing = true, .incomplete = true };
    };
    if (expected_root_token) |tok| {
        if (!root_obs.start_token.eql(tok)) {
            return .{ .members = try allocator.alloc(ProcessIdentity, 0), .root_missing = true, .incomplete = true };
        }
    }

    var members: std.ArrayList(ProcessIdentity) = .{};
    errdefer members.deinit(allocator);

    var root = root_obs;
    root.depth = 0;
    try members.append(allocator, root);

    // BFS for depth assignment.
    var queue: std.ArrayList(usize) = .{};
    defer queue.deinit(allocator);
    try queue.append(allocator, 0);

    var incomplete = false;
    var qi: usize = 0;
    while (qi < queue.items.len) : (qi += 1) {
        const idx = queue.items[qi];
        const parent_id = members.items[idx];
        const children = platform.listChildren(allocator, parent_id.pid) catch {
            incomplete = true;
            continue;
        };
        defer allocator.free(children);
        for (children) |child_pid| {
            if (child_pid <= 1) continue;
            const obs = platform.observe(child_pid) orelse {
                incomplete = true;
                continue;
            };
            // Skip if already present (shouldn't happen in a tree, but be safe).
            var exists = false;
            for (members.items) |m| {
                if (m.pid == obs.pid) {
                    exists = true;
                    break;
                }
            }
            if (exists) continue;
            var child = obs;
            child.depth = parent_id.depth + 1;
            try members.append(allocator, child);
            try queue.append(allocator, members.items.len - 1);
        }
    }

    return .{
        .members = try members.toOwnedSlice(allocator),
        .root_missing = false,
        .incomplete = incomplete,
    };
}

/// §21: snapshot verified root + descendants until two consecutive passes match
/// or the 250 ms inspection deadline expires.
pub fn snapshotTree(
    platform: Platform,
    allocator: std.mem.Allocator,
    root_pid: i32,
    expected_root_token: ?StartToken,
) Error!Snapshot {
    if (root_pid <= 1) return error.InvalidRoot;

    const deadline = platform.monoNow() + inspection_deadline_ns;
    var prev: ?[]ProcessIdentity = null;
    defer if (prev) |p| allocator.free(p);

    var last_incomplete = false;
    var last_root_missing = false;

    while (true) {
        const pass = collectTree(platform, allocator, root_pid, expected_root_token) catch return error.InspectionFailed;
        last_incomplete = pass.incomplete;
        last_root_missing = pass.root_missing;

        sortIdentities(pass.members);

        if (prev) |p| {
            if (!pass.root_missing and !pass.incomplete and identitiesMatch(p, pass.members)) {
                allocator.free(p);
                prev = null;
                return .{
                    .status = .stable,
                    .members = pass.members,
                    .root_missing = false,
                };
            }
            allocator.free(p);
        }
        prev = pass.members;

        if (platform.monoNow() >= deadline) break;
        // Brief yield so the tree can settle; still bounded by the deadline.
        platform.sleep(5 * std.time.ns_per_ms);
    }

    // Deadline expired without two matching complete passes → explicit UNKNOWN.
    const members = prev orelse try allocator.alloc(ProcessIdentity, 0);
    prev = null;
    return .{
        .status = .unknown,
        .members = members,
        .root_missing = last_root_missing or last_incomplete,
    };
}

fn deepestFirstLess(a: ProcessIdentity, b: ProcessIdentity) bool {
    // Higher depth first; PTY/root (depth 0) last. Stable by pid within depth.
    if (a.depth != b.depth) return a.depth > b.depth;
    return a.pid < b.pid;
}

fn deepestFirstOrder(members: []ProcessIdentity) void {
    var i: usize = 1;
    while (i < members.len) : (i += 1) {
        var j = i;
        while (j > 0 and deepestFirstLess(members[j], members[j - 1])) : (j -= 1) {
            const tmp = members[j - 1];
            members[j - 1] = members[j];
            members[j] = tmp;
        }
    }
}

fn revalidate(
    platform: Platform,
    expected: ProcessIdentity,
) MemberFate {
    const obs = platform.observe(expected.pid) orelse return .terminated;
    // PID reuse: same pid, different start token → the original is gone, but
    // we must not claim we killed this new process. Report unknown.
    if (!obs.start_token.eql(expected.start_token)) return .unknown;
    return .survivor;
}

/// Signal every known verified member deepest-first, then positively read back.
/// A changing/incomplete capture still attempts already-verified members and
/// reports everything that could not be revalidated as unknown.
pub fn terminateTree(
    platform: Platform,
    allocator: std.mem.Allocator,
    root_pid: i32,
    expected_root_token: ?StartToken,
    mode: TerminationMode,
) Error!TerminationResult {
    var snap = try snapshotTree(platform, allocator, root_pid, expected_root_token);
    defer snap.deinit(allocator);

    // Work on a mutable deepest-first copy of verified members.
    const ordered = try allocator.dupe(ProcessIdentity, snap.members);
    defer allocator.free(ordered);
    deepestFirstOrder(ordered);

    switch (mode) {
        .graceful => {
            // Send provider-side graceful action is the host's job; here we
            // TERM verified members deepest-first, wait 2s, then KILL survivors.
            for (ordered) |m| {
                _ = platform.kill(m.pid, c.SIGTERM);
            }
            platform.sleep(graceful_term_wait_ns);
            for (ordered) |m| {
                if (revalidate(platform, m) == .survivor) {
                    _ = platform.kill(m.pid, c.SIGKILL);
                }
            }
            platform.sleep(graceful_kill_wait_ns);
        },
        .immediate => {
            for (ordered) |m| {
                _ = platform.kill(m.pid, c.SIGKILL);
            }
            platform.sleep(immediate_kill_wait_ns);
        },
    }

    var results: std.ArrayList(MemberResult) = .{};
    errdefer results.deinit(allocator);

    var any_survivor = false;
    var any_unknown = snap.status == .unknown or snap.root_missing;

    for (ordered) |m| {
        const fate = revalidate(platform, m);
        const reason: []const u8 = switch (fate) {
            .terminated => "wait-or-absence",
            .survivor => "still-alive-after-stop-policy",
            .unknown => "pid-reuse-or-unobservable",
        };
        if (fate == .survivor) any_survivor = true;
        if (fate == .unknown) any_unknown = true;
        try results.append(allocator, .{
            .identity = m,
            .fate = fate,
            .reason = reason,
        });
    }

    // If the snapshot was empty because the root was already gone, require
    // absence/reuse evidence for the root itself before claiming terminated.
    const state: TerminationState = blk: {
        if (any_survivor) break :blk .survivors;
        if (any_unknown) break :blk .unknown;
        if (ordered.len == 0 and snap.root_missing) {
            break :blk if (rootAbsent(platform, root_pid, expected_root_token))
                .terminated
            else
                .unknown;
        }
        break :blk .terminated;
    };

    return .{
        .state = state,
        .members = try results.toOwnedSlice(allocator),
        .snapshot_status = snap.status,
    };
}

fn rootAbsent(platform: Platform, root_pid: i32, expected_root_token: ?StartToken) bool {
    const obs = platform.observe(root_pid) orelse return true;
    if (expected_root_token) |tok| {
        if (!obs.start_token.eql(tok)) return true; // original root is gone (reuse)
    }
    return false;
}

// ── Unit tests: real child process trees ────────────────────────────────────

const testing = std.testing;

/// Spawn `sleep 60` in a new session; returns pid. Caller must reap/kill.
fn spawnSleepChild() !i32 {
    const pid = try posix.fork();
    if (pid == 0) {
        // Child: new session so it can outlive parent reparenting scenarios.
        _ = c.setsid();
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        const envp = [_:null]?[*:0]const u8{};
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
        posix.exit(127);
    }
    return pid;
}

/// Spawn a parent that itself spawns a child sleep (2-level tree).
/// Returns the intermediate parent pid after the grandchild is live.
fn spawnNestedTree() !i32 {
    const pipe_fds = try posix.pipe();
    errdefer {
        posix.close(pipe_fds[0]);
        posix.close(pipe_fds[1]);
    }

    const pid = try posix.fork();
    if (pid == 0) {
        posix.close(pipe_fds[0]);
        _ = c.setsid();
        const child = posix.fork() catch posix.exit(126);
        if (child == 0) {
            posix.close(pipe_fds[1]);
            const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
            const envp = [_:null]?[*:0]const u8{};
            _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
            posix.exit(127);
        }
        // Signal readiness (grandchild pid) then wait forever.
        var buf: [32]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "{d}\n", .{child}) catch posix.exit(125);
        _ = posix.write(pipe_fds[1], msg) catch {};
        posix.close(pipe_fds[1]);
        while (true) {
            std.Thread.sleep(60 * std.time.ns_per_s);
        }
    }

    posix.close(pipe_fds[1]);
    defer posix.close(pipe_fds[0]);
    var acc: [32]u8 = undefined;
    var filled: usize = 0;
    while (filled < acc.len) {
        const n = posix.read(pipe_fds[0], acc[filled..]) catch break;
        if (n == 0) break;
        filled += n;
        if (std.mem.indexOfScalar(u8, acc[0..filled], '\n') != null) break;
    }
    // Ensure the reported grandchild is observable before returning.
    const line = std.mem.trim(u8, acc[0..filled], " \n\r\t");
    const grandchild = try std.fmt.parseInt(i32, line, 10);
    var attempts: usize = 0;
    while (attempts < 50) : (attempts += 1) {
        if (observeProcess(grandchild) != null) break;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    return pid;
}

/// Escapee: child that double-forks and setsid so it is NOT a descendant of
/// the returned root. Returns .{ root, escapee }.
fn spawnTreeWithEscapee() !struct { root: i32, escapee: i32 } {
    // Pipe so the escapee can report its pid to the test process.
    const pipe_fds = try posix.pipe();
    errdefer {
        posix.close(pipe_fds[0]);
        posix.close(pipe_fds[1]);
    }

    const root = try posix.fork();
    if (root == 0) {
        posix.close(pipe_fds[0]);
        _ = c.setsid();

        // Child A: stays in the tree (sleep).
        const in_tree = posix.fork() catch posix.exit(126);
        if (in_tree == 0) {
            const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
            const envp = [_:null]?[*:0]const u8{};
            _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
            posix.exit(127);
        }

        // Child B: double-fork escapee.
        const mid = posix.fork() catch posix.exit(126);
        if (mid == 0) {
            _ = c.setsid();
            const esc = posix.fork() catch posix.exit(126);
            if (esc == 0) {
                // Report pid then sleep.
                var buf: [32]u8 = undefined;
                const msg = std.fmt.bufPrint(&buf, "{d}\n", .{c.getpid()}) catch posix.exit(125);
                _ = posix.write(pipe_fds[1], msg) catch {};
                posix.close(pipe_fds[1]);
                const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
                const envp = [_:null]?[*:0]const u8{};
                _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
                posix.exit(127);
            }
            // Mid exits so escapee is reparented to launchd/init — not under root.
            posix.exit(0);
        }
        _ = posix.waitpid(mid, 0);
        posix.close(pipe_fds[1]);
        while (true) std.Thread.sleep(60 * std.time.ns_per_s);
    }

    posix.close(pipe_fds[1]);
    defer posix.close(pipe_fds[0]);

    var acc: [32]u8 = undefined;
    var filled: usize = 0;
    while (filled < acc.len) {
        const n = posix.read(pipe_fds[0], acc[filled..]) catch break;
        if (n == 0) break;
        filled += n;
        if (std.mem.indexOfScalar(u8, acc[0..filled], '\n') != null) break;
    }
    const line = std.mem.trim(u8, acc[0..filled], " \n\r\t");
    const escapee = try std.fmt.parseInt(i32, line, 10);
    // Give the tree a moment to settle.
    std.Thread.sleep(50 * std.time.ns_per_ms);
    return .{ .root = root, .escapee = escapee };
}

fn forceKill(pid: i32) void {
    _ = c.kill(pid, c.SIGKILL);
    // libc waitpid: ignore ECHILD (already reaped / not our child). Zig's
    // posix.waitpid panics on that errno.
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
}

fn forceKillMaybeReparented(pid: i32) void {
    _ = c.kill(pid, c.SIGKILL);
    // Non-child: poll absence rather than waitpid (which panics on ECHILD).
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        if (!isAlive(pid)) return;
        std.Thread.sleep(10 * std.time.ns_per_ms);
        _ = c.kill(pid, c.SIGKILL);
    }
}

fn isAlive(pid: i32) bool {
    return observeProcess(pid) != null;
}

test "snapshotTree records identity tuple for a live root" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const pid = try spawnSleepChild();
    defer forceKill(pid);

    std.Thread.sleep(30 * std.time.ns_per_ms);
    const token = observeProcess(pid).?.start_token;

    var snap = try snapshotTree(RealPlatform.platform(), testing.allocator, pid, token);
    defer snap.deinit(testing.allocator);

    try testing.expectEqual(SnapshotStatus.stable, snap.status);
    try testing.expect(snap.members.len >= 1);
    try testing.expectEqual(pid, snap.members[0].pid);
    try testing.expect(snap.members[0].start_token.eql(token));
    try testing.expect(snap.members[0].pgid != 0);
    try testing.expect(snap.members[0].executable_len > 0);
}

test "snapshotTree nested tree includes descendant" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const root = try spawnNestedTree();
    defer {
        // Kill process group-ish: walk and kill.
        if (observeProcess(root)) |_| {
            var snap = snapshotTree(RealPlatform.platform(), testing.allocator, root, null) catch null;
            if (snap) |*s| {
                defer s.deinit(testing.allocator);
                deepestFirstOrder(s.members);
                for (s.members) |m| _ = c.kill(m.pid, c.SIGKILL);
            }
            _ = c.kill(root, c.SIGKILL);
            _ = posix.waitpid(root, 0);
        }
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    var snap = try snapshotTree(RealPlatform.platform(), testing.allocator, root, null);
    defer snap.deinit(testing.allocator);

    try testing.expectEqual(SnapshotStatus.stable, snap.status);
    try testing.expect(snap.members.len >= 2);
}

test "immediate stop terminates real tree with absence evidence" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const root = try spawnNestedTree();
    // On failure paths, still try to reap.
    errdefer {
        _ = c.kill(root, c.SIGKILL);
        _ = posix.waitpid(root, 0);
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    const token = observeProcess(root).?.start_token;

    var result = try terminateTree(
        RealPlatform.platform(),
        testing.allocator,
        root,
        token,
        .immediate,
    );
    defer result.deinit(testing.allocator);

    // Reap zombies so waitpid does not leave them.
    _ = posix.waitpid(root, 0);

    try testing.expectEqual(TerminationState.terminated, result.state);
    for (result.members) |m| {
        try testing.expectEqual(MemberFate.terminated, m.fate);
        try testing.expect(!isAlive(m.identity.pid) or
            (observeProcess(m.identity.pid) != null and
                !observeProcess(m.identity.pid).?.start_token.eql(m.identity.start_token)));
    }
}

test "graceful stop TERM-then-KILL terminates real tree" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const root = try spawnNestedTree();
    errdefer {
        _ = c.kill(root, c.SIGKILL);
        _ = posix.waitpid(root, 0);
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    const token = observeProcess(root).?.start_token;

    var result = try terminateTree(
        RealPlatform.platform(),
        testing.allocator,
        root,
        token,
        .graceful,
    );
    defer result.deinit(testing.allocator);
    _ = posix.waitpid(root, 0);

    try testing.expectEqual(TerminationState.terminated, result.state);
    for (result.members) |m| {
        try testing.expectEqual(MemberFate.terminated, m.fate);
    }
}

test "positive control: escapee is NOT reported terminated; unrelated process survives" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    // Unrelated process the inspector must never touch.
    const unrelated = try spawnSleepChild();
    defer forceKill(unrelated);
    const unrelated_token = observeProcess(unrelated).?.start_token;

    const tree = try spawnTreeWithEscapee();
    errdefer {
        _ = c.kill(tree.root, c.SIGKILL);
        _ = posix.waitpid(tree.root, 0);
        _ = c.kill(tree.escapee, c.SIGKILL);
    }

    const root_token = observeProcess(tree.root).?.start_token;
    try testing.expect(isAlive(tree.escapee));

    var result = try terminateTree(
        RealPlatform.platform(),
        testing.allocator,
        tree.root,
        root_token,
        .immediate,
    );
    defer result.deinit(testing.allocator);
    _ = posix.waitpid(tree.root, 0);

    // Tree members should be terminated.
    try testing.expectEqual(TerminationState.terminated, result.state);

    // CRITICAL positive control: escapee must still be alive. A buggy
    // implementation that SIGKILLs by process group or session, or that
    // invents success without readback, would kill it — and this test fails.
    try testing.expect(isAlive(tree.escapee));
    // Escapee must not appear in the terminated set.
    for (result.members) |m| {
        try testing.expect(m.identity.pid != tree.escapee);
    }

    // Unrelated process must survive.
    try testing.expect(isAlive(unrelated));
    try testing.expect(observeProcess(unrelated).?.start_token.eql(unrelated_token));

    // Cleanup escapee (not part of the tree under test; may be reparented).
    forceKillMaybeReparented(tree.escapee);
}

test "never report terminated without absence evidence — live root is survivor" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    // Platform that "signals" but does not actually kill — acting is not being.
    const FakeKill = struct {
        real: Platform = RealPlatform.platform(),
        signals: std.ArrayList(i32) = .{},
        allocator: std.mem.Allocator,

        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real.monoNow();
        }
        fn sleep(ctx: *anyopaque, ns: u64) void {
            // Shorten sleeps for the test; still call through for shape.
            _ = ns;
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.real.sleep(10 * std.time.ns_per_ms);
        }
        fn kill(ctx: *anyopaque, pid: i32, sig: i32) bool {
            _ = sig;
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.signals.append(self.allocator, pid) catch {};
            // Pretend success — do NOT actually kill. This is the acting trap.
            return true;
        }
        fn observe(ctx: *anyopaque, pid: i32) ?ProcessIdentity {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real.observe(pid);
        }
        fn listChildren(ctx: *anyopaque, allocator: std.mem.Allocator, pid: i32) ![]i32 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real.listChildren(allocator, pid);
        }
    };

    const pid = try spawnSleepChild();
    defer forceKill(pid);
    std.Thread.sleep(30 * std.time.ns_per_ms);
    const token = observeProcess(pid).?.start_token;

    var fake = FakeKill{ .allocator = testing.allocator };
    defer fake.signals.deinit(testing.allocator);

    var result = try terminateTree(fake.platform(), testing.allocator, pid, token, .immediate);
    defer result.deinit(testing.allocator);

    // Positive control: if we trusted kill() return values, we would wrongly
    // report terminated. The process is still alive → survivors.
    try testing.expectEqual(TerminationState.survivors, result.state);
    try testing.expect(isAlive(pid));
    try testing.expect(result.members.len >= 1);
    try testing.expectEqual(MemberFate.survivor, result.members[0].fate);
}

test "PID reuse yields unknown not terminated for the new process" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    // Synthetic platform: observe returns a different start token for same pid
    // after kill (simulating reuse).
    const Reuse = struct {
        original: ProcessIdentity,
        phase: enum { before, after } = .before,
        now: u64 = 0,

        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            // Advance past inspection deadline after a few calls.
            self.now += 100 * std.time.ns_per_ms;
            return self.now;
        }
        fn sleep(_: *anyopaque, _: u64) void {}
        fn kill(ctx: *anyopaque, pid: i32, _: i32) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid == self.original.pid) self.phase = .after;
            return true;
        }
        fn observe(ctx: *anyopaque, pid: i32) ?ProcessIdentity {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid != self.original.pid) return null;
            var id = self.original;
            if (self.phase == .after) {
                // New process reused the PID — different start token.
                id.start_token.seconds += 1000;
            }
            return id;
        }
        fn listChildren(_: *anyopaque, allocator: std.mem.Allocator, _: i32) ![]i32 {
            return try allocator.alloc(i32, 0);
        }
    };

    var sim = Reuse{
        .original = .{
            .pid = 4242,
            .start_token = .{ .seconds = 1, .microseconds = 2 },
            .parent = 1,
            .pgid = 4242,
            .session = 4242,
            .executable_len = 0,
            .depth = 0,
        },
    };

    var result = try terminateTree(
        sim.platform(),
        testing.allocator,
        4242,
        sim.original.start_token,
        .immediate,
    );
    defer result.deinit(testing.allocator);

    // Original identity is gone (reuse) → fate unknown, not "we terminated the new one".
    try testing.expect(result.members.len >= 1);
    try testing.expectEqual(MemberFate.unknown, result.members[0].fate);
    try testing.expect(result.state == .unknown or result.state == .survivors);
}

test "inspection constants match §21" {
    try testing.expectEqual(@as(u64, 250 * std.time.ns_per_ms), inspection_deadline_ns);
    try testing.expectEqual(@as(u64, 2 * std.time.ns_per_s), graceful_term_wait_ns);
    try testing.expectEqual(@as(u64, 2 * std.time.ns_per_s), graceful_kill_wait_ns);
}
