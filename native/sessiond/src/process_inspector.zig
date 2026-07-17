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
    @cInclude("errno.h");
});

/// §21 inspection deadline.
pub const inspection_deadline_ns: u64 = 250 * std.time.ns_per_ms;
/// §21 graceful: TERM verified members deepest-first, wait 2 seconds…
pub const graceful_term_wait_ns: u64 = 2 * std.time.ns_per_s;
/// …then KILL verified survivors after another 2 seconds.
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
    /// True when the verified root itself could not be observed (absent or unobservable).
    root_missing: bool = false,
    /// True when the tree walk was incomplete or consecutive passes disagreed (L2: not root_missing).
    incomplete: bool = false,

    pub fn deinit(self: *Snapshot, allocator: std.mem.Allocator) void {
        allocator.free(self.members);
        self.* = undefined;
    }
};

/// Observation result — ESRCH/absence is not the same as EPERM/unobservable (§18 fail closed).
pub const ObserveResult = union(enum) {
    present: ProcessIdentity,
    /// Positive absence: ESRCH / process does not exist.
    absent,
    /// Alive-or-unknown but not readable (EPERM, short buffer, etc.). Fail closed.
    unobservable,
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
    /// Typed observation: absent (ESRCH) ≠ unobservable (EPERM/other).
    observeFn: *const fn (context: *anyopaque, pid: i32) ObserveResult,
    /// waitpid(WNOHANG) for a direct child. true = reaped (wait evidence).
    waitNoHangFn: *const fn (context: *anyopaque, pid: i32) bool,
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
    pub fn observe(self: Platform, pid: i32) ObserveResult {
        return self.observeFn(self.context, pid);
    }
    pub fn waitNoHang(self: Platform, pid: i32) bool {
        return self.waitNoHangFn(self.context, pid);
    }
    pub fn listChildren(self: Platform, allocator: std.mem.Allocator, pid: i32) ![]i32 {
        return self.listChildrenFn(self.context, allocator, pid);
    }
};

/// Production macOS platform: real proc_listchildpids / proc_pidinfo / kill / wait.
pub const RealPlatform = struct {
    /// Monotonic base for monoNow (std.time.Instant — not wall clock; M2).
    started: std.time.Instant = undefined,
    started_ok: bool = false,

    pub fn init() RealPlatform {
        var self: RealPlatform = .{};
        if (std.time.Instant.now()) |now| {
            self.started = now;
            self.started_ok = true;
        } else |_| {
            self.started_ok = false;
        }
        return self;
    }

    pub fn platform(self: *RealPlatform) Platform {
        return .{
            .context = self,
            .monoNowFn = monoNow,
            .sleepFn = sleep,
            .killFn = kill,
            .observeFn = observe,
            .waitNoHangFn = waitNoHang,
            .listChildrenFn = listChildren,
        };
    }

    fn monoNow(ctx: *anyopaque) u64 {
        const self: *RealPlatform = @ptrCast(@alignCast(ctx));
        if (!self.started_ok) return 0;
        const now = std.time.Instant.now() catch return 0;
        // Instant.since returns u64 ns; no wall-clock NTP jump.
        return now.since(self.started);
    }

    fn sleep(_: *anyopaque, ns: u64) void {
        std.Thread.sleep(ns);
    }

    fn kill(_: *anyopaque, pid: i32, sig: i32) bool {
        if (pid <= 1) return false;
        const rc = c.kill(pid, sig);
        if (rc == 0) return true;
        // ESRCH: already gone — counts as delivered for acting purposes, but
        // fate still requires wait/absence readback.
        return std.posix.errno(rc) == .SRCH;
    }

    fn observe(_: *anyopaque, pid: i32) ObserveResult {
        return observeProcess(pid);
    }

    fn waitNoHang(_: *anyopaque, pid: i32) bool {
        if (pid <= 1) return false;
        var status: c_int = 0;
        const rc = c.waitpid(pid, &status, c.WNOHANG);
        // rc == pid: reaped — real wait evidence.
        // rc == 0: still running. rc < 0: not our child / error — not wait evidence.
        return rc == pid;
    }

    fn listChildren(_: *anyopaque, allocator: std.mem.Allocator, pid: i32) ![]i32 {
        return listChildPids(allocator, pid);
    }
};

/// Observe a process with errno discrimination (B1).
/// ESRCH → .absent (real absence). EPERM/other shortfall → .unobservable.
pub fn observeProcess(pid: i32) ObserveResult {
    if (pid <= 0) return .absent;
    var info: c.struct_proc_bsdinfo = std.mem.zeroes(c.struct_proc_bsdinfo);
    // Clear errno so a stale value cannot be mistaken for this call's result.
    std.c._errno().* = 0;
    const info_len = c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(c.struct_proc_bsdinfo));
    if (info_len != @sizeOf(c.struct_proc_bsdinfo)) {
        const e: std.posix.E = @enumFromInt(std.c._errno().*);
        // ESRCH: no such process.
        if (e == .SRCH) return .absent;
        // Cross-uid / CHECK_SAME_USER → EPERM: alive-but-unreadable → UNKNOWN.
        // Any other shortfall is also fail-closed unobservable (§18).
        return .unobservable;
    }

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
        // Executable path unavailable is not absence; identity is still usable
        // for termination tracking (token/pid/pgid recorded).
        result.executable_len = 0;
    }
    return .{ .present = result };
}

/// Convenience for call sites that only need a present identity.
pub fn observeProcessPresent(pid: i32) ?ProcessIdentity {
    return switch (observeProcess(pid)) {
        .present => |id| id,
        .absent, .unobservable => null,
    };
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
    const root_result = platform.observe(root_pid);
    const root_obs: ProcessIdentity = switch (root_result) {
        .present => |id| id,
        // Absent root: missing, not "incomplete tree walk".
        .absent => return .{
            .members = try allocator.alloc(ProcessIdentity, 0),
            .root_missing = true,
            .incomplete = false,
        },
        // Unobservable root: fail closed — missing + incomplete (cannot verify).
        .unobservable => return .{
            .members = try allocator.alloc(ProcessIdentity, 0),
            .root_missing = true,
            .incomplete = true,
        },
    };
    if (expected_root_token) |tok| {
        if (!root_obs.start_token.eql(tok)) {
            // PID reuse at root: original identity is gone.
            return .{
                .members = try allocator.alloc(ProcessIdentity, 0),
                .root_missing = true,
                .incomplete = false,
            };
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
            switch (platform.observe(child_pid)) {
                .present => |obs| {
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
                },
                // Child vanished between list and observe: tree is changing.
                .absent => incomplete = true,
                // Child exists but unreadable: fail closed incomplete.
                .unobservable => incomplete = true,
            }
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

    const deadline = platform.monoNow() +% inspection_deadline_ns;
    var prev: ?[]ProcessIdentity = null;
    defer if (prev) |p| allocator.free(p);

    var last_incomplete = false;
    var last_root_missing = false;
    // Previous pass was clean root_missing (for stable-absence detection; N1).
    var prev_clean_absent = false;

    while (true) {
        const pass = collectTree(platform, allocator, root_pid, expected_root_token) catch return error.InspectionFailed;
        last_incomplete = pass.incomplete;
        last_root_missing = pass.root_missing;

        sortIdentities(pass.members);

        if (prev) |p| {
            // Stable live tree: two complete matching passes.
            if (!pass.root_missing and !pass.incomplete and identitiesMatch(p, pass.members)) {
                allocator.free(p);
                prev = null;
                return .{
                    .status = .stable,
                    .members = pass.members,
                    .root_missing = false,
                    .incomplete = false,
                };
            }
            // N1: stable absence — two consecutive clean root_missing passes.
            // (Must not require !root_missing on the live path; otherwise absence
            // can never stabilize and M1's rootEvidence terminated path is dead.)
            if (pass.root_missing and !pass.incomplete and prev_clean_absent and
                p.len == 0 and pass.members.len == 0)
            {
                allocator.free(p);
                prev = null;
                return .{
                    .status = .stable,
                    .members = pass.members,
                    .root_missing = true,
                    .incomplete = false,
                };
            }
            allocator.free(p);
        }
        prev_clean_absent = pass.root_missing and !pass.incomplete and pass.members.len == 0;
        prev = pass.members;

        if (platform.monoNow() >= deadline) break;
        // Brief yield so the tree can settle; still bounded by the deadline.
        platform.sleep(5 * std.time.ns_per_ms);
    }

    // Deadline expired without two matching complete passes → explicit UNKNOWN.
    // (A changing-but-complete tree lands here: incomplete=false, status=unknown.)
    const members = prev orelse try allocator.alloc(ProcessIdentity, 0);
    prev = null;
    return .{
        .status = .unknown,
        .members = members,
        .root_missing = last_root_missing,
        .incomplete = last_incomplete,
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

const RevalidateOutcome = struct {
    fate: MemberFate,
    reason: []const u8,
};

/// Positive readback for one verified member (B1).
/// - waitpid reaped → terminated ("wait-or-absence")
/// - observe absent (ESRCH) → terminated ("wait-or-absence")
/// - observe unobservable (EPERM/…) → unknown (never terminated)
/// - present + token mismatch → unknown (PID reuse)
/// - present + matching token → survivor
fn revalidate(platform: Platform, expected: ProcessIdentity) RevalidateOutcome {
    // Real wait evidence for children we own (WNOHANG).
    if (platform.waitNoHang(expected.pid)) {
        return .{ .fate = .terminated, .reason = "wait-or-absence" };
    }
    return switch (platform.observe(expected.pid)) {
        .absent => .{ .fate = .terminated, .reason = "wait-or-absence" },
        .unobservable => .{ .fate = .unknown, .reason = "permission-or-unobservable" },
        .present => |obs| {
            if (!obs.start_token.eql(expected.start_token)) {
                // Original identity is gone; do not claim we terminated the new process.
                return .{ .fate = .unknown, .reason = "pid-reuse-or-unobservable" };
            }
            return .{ .fate = .survivor, .reason = "still-alive-after-stop-policy" };
        },
    };
}

/// Signal every known verified member deepest-first (per-pid, NOT process-group
/// kill — a pgid signal would reach escapees outside the verified tree; L4),
/// then positively read back with wait/absence evidence only.
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
            // Provider-side graceful action is the host's job; here we
            // TERM each verified member deepest-first, wait 2s, then KILL survivors.
            for (ordered) |m| {
                _ = platform.kill(m.pid, c.SIGTERM);
            }
            platform.sleep(graceful_term_wait_ns);
            for (ordered) |m| {
                if (revalidate(platform, m).fate == .survivor) {
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
    // N1: incomplete OR never-stabilized snapshot (status=.unknown) forces
    // overall unknown — a changing-but-complete tree must not report terminated.
    // M1 preserved: stable + root_missing + empty members → rootEvidence path
    // (absent root with real absence evidence → terminated).
    var any_unknown = snap.incomplete or snap.status == .unknown;

    for (ordered) |m| {
        const outcome = revalidate(platform, m);
        if (outcome.fate == .survivor) any_survivor = true;
        if (outcome.fate == .unknown) any_unknown = true;
        try results.append(allocator, .{
            .identity = m,
            .fate = outcome.fate,
            .reason = outcome.reason,
        });
    }

    const state: TerminationState = blk: {
        if (any_survivor) break :blk .survivors;
        if (any_unknown) break :blk .unknown;
        if (ordered.len == 0) {
            // No verified members: only terminated if root absence is evidenced.
            break :blk switch (rootEvidence(platform, root_pid, expected_root_token)) {
                .absent_evidenced => .terminated,
                .unobservable, .still_present => .unknown,
            };
        }
        break :blk .terminated;
    };

    return .{
        .state = state,
        .members = try results.toOwnedSlice(allocator),
        .snapshot_status = snap.status,
    };
}

const RootEvidence = enum { absent_evidenced, unobservable, still_present };

fn rootEvidence(
    platform: Platform,
    root_pid: i32,
    expected_root_token: ?StartToken,
) RootEvidence {
    if (platform.waitNoHang(root_pid)) return .absent_evidenced;
    return switch (platform.observe(root_pid)) {
        .absent => .absent_evidenced,
        .unobservable => .unobservable,
        .present => |obs| {
            if (expected_root_token) |tok| {
                if (!obs.start_token.eql(tok)) return .absent_evidenced; // reuse
            }
            return .still_present;
        },
    };
}

// ── Unit tests: real child process trees ────────────────────────────────────

const testing = std.testing;

// N3: do not add a realPlatform() helper that returns Platform with context
// pointing at a stack-local RealPlatform — that is use-after-return. Call sites
// must use `var rp = RealPlatform.init(); rp.platform()`.

/// Spawn `sleep 60` in a new session; returns pid. Caller must reap/kill.
fn spawnSleepChild() !i32 {
    const pid = try posix.fork();
    if (pid == 0) {
        _ = c.setsid();
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        const envp = [_:null]?[*:0]const u8{};
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
        posix.exit(127);
    }
    return pid;
}

/// Spawn a parent that itself spawns a child sleep (2-level tree).
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
        var buf: [32]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "{d}\n", .{child}) catch posix.exit(125);
        _ = posix.write(pipe_fds[1], msg) catch {};
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
    const grandchild = try std.fmt.parseInt(i32, line, 10);
    var attempts: usize = 0;
    while (attempts < 50) : (attempts += 1) {
        if (observeProcessPresent(grandchild) != null) break;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    return pid;
}

fn spawnTreeWithEscapee() !struct { root: i32, escapee: i32 } {
    const pipe_fds = try posix.pipe();
    errdefer {
        posix.close(pipe_fds[0]);
        posix.close(pipe_fds[1]);
    }

    const root = try posix.fork();
    if (root == 0) {
        posix.close(pipe_fds[0]);
        _ = c.setsid();

        const in_tree = posix.fork() catch posix.exit(126);
        if (in_tree == 0) {
            const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
            const envp = [_:null]?[*:0]const u8{};
            _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
            posix.exit(127);
        }

        const mid = posix.fork() catch posix.exit(126);
        if (mid == 0) {
            _ = c.setsid();
            const esc = posix.fork() catch posix.exit(126);
            if (esc == 0) {
                var buf: [32]u8 = undefined;
                const msg = std.fmt.bufPrint(&buf, "{d}\n", .{c.getpid()}) catch posix.exit(125);
                _ = posix.write(pipe_fds[1], msg) catch {};
                posix.close(pipe_fds[1]);
                const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
                const envp = [_:null]?[*:0]const u8{};
                _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
                posix.exit(127);
            }
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
    std.Thread.sleep(50 * std.time.ns_per_ms);
    return .{ .root = root, .escapee = escapee };
}

fn forceKill(pid: i32) void {
    _ = c.kill(pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
}

fn forceKillMaybeReparented(pid: i32) void {
    _ = c.kill(pid, c.SIGKILL);
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        if (!isAlive(pid)) return;
        std.Thread.sleep(10 * std.time.ns_per_ms);
        _ = c.kill(pid, c.SIGKILL);
    }
}

fn isAlive(pid: i32) bool {
    return switch (observeProcess(pid)) {
        .present => true,
        .absent, .unobservable => false,
    };
}

test "snapshotTree records identity tuple for a live root" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const pid = try spawnSleepChild();
    defer forceKill(pid);

    std.Thread.sleep(30 * std.time.ns_per_ms);
    const token = observeProcessPresent(pid).?.start_token;

    var rp = RealPlatform.init();
    var snap = try snapshotTree(rp.platform(), testing.allocator, pid, token);
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
        if (observeProcessPresent(root)) |_| {
            var rp = RealPlatform.init();
            var snap = snapshotTree(rp.platform(), testing.allocator, root, null) catch null;
            if (snap) |*s| {
                defer s.deinit(testing.allocator);
                deepestFirstOrder(s.members);
                for (s.members) |m| _ = c.kill(m.pid, c.SIGKILL);
            }
            _ = c.kill(root, c.SIGKILL);
            var st: c_int = 0;
            _ = c.waitpid(root, &st, 0);
        }
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    var rp = RealPlatform.init();
    var snap = try snapshotTree(rp.platform(), testing.allocator, root, null);
    defer snap.deinit(testing.allocator);

    try testing.expectEqual(SnapshotStatus.stable, snap.status);
    try testing.expect(snap.members.len >= 2);
}

fn reapIgnoreEchild(pid: i32) void {
    var st: c_int = 0;
    _ = c.waitpid(pid, &st, 0);
}

test "immediate stop terminates real tree with absence evidence" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const root = try spawnNestedTree();
    errdefer {
        _ = c.kill(root, c.SIGKILL);
        reapIgnoreEchild(root);
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    const token = observeProcessPresent(root).?.start_token;

    var rp = RealPlatform.init();
    var result = try terminateTree(rp.platform(), testing.allocator, root, token, .immediate);
    defer result.deinit(testing.allocator);

    // waitNoHang may already have reaped during terminateTree.
    reapIgnoreEchild(root);

    try testing.expectEqual(TerminationState.terminated, result.state);
    for (result.members) |m| {
        try testing.expectEqual(MemberFate.terminated, m.fate);
        try testing.expectEqualStrings("wait-or-absence", m.reason);
    }
}

test "graceful stop TERM-then-KILL terminates real tree" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const root = try spawnNestedTree();
    errdefer {
        _ = c.kill(root, c.SIGKILL);
        reapIgnoreEchild(root);
    }

    std.Thread.sleep(50 * std.time.ns_per_ms);
    const token = observeProcessPresent(root).?.start_token;

    var rp = RealPlatform.init();
    var result = try terminateTree(rp.platform(), testing.allocator, root, token, .graceful);
    defer result.deinit(testing.allocator);
    reapIgnoreEchild(root);

    try testing.expectEqual(TerminationState.terminated, result.state);
    for (result.members) |m| {
        try testing.expectEqual(MemberFate.terminated, m.fate);
        try testing.expectEqualStrings("wait-or-absence", m.reason);
    }
}

test "positive control: escapee is NOT reported terminated; unrelated process survives" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const unrelated = try spawnSleepChild();
    defer forceKill(unrelated);
    const unrelated_token = observeProcessPresent(unrelated).?.start_token;

    const tree = try spawnTreeWithEscapee();
    errdefer {
        _ = c.kill(tree.root, c.SIGKILL);
        reapIgnoreEchild(tree.root);
        _ = c.kill(tree.escapee, c.SIGKILL);
    }

    const root_token = observeProcessPresent(tree.root).?.start_token;
    try testing.expect(isAlive(tree.escapee));

    var rp = RealPlatform.init();
    var result = try terminateTree(rp.platform(), testing.allocator, tree.root, root_token, .immediate);
    defer result.deinit(testing.allocator);
    reapIgnoreEchild(tree.root);

    try testing.expectEqual(TerminationState.terminated, result.state);
    try testing.expect(isAlive(tree.escapee));
    for (result.members) |m| {
        try testing.expect(m.identity.pid != tree.escapee);
    }
    try testing.expect(isAlive(unrelated));
    try testing.expect(observeProcessPresent(unrelated).?.start_token.eql(unrelated_token));
    forceKillMaybeReparented(tree.escapee);
}

test "never report terminated without absence evidence — live root is survivor" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const FakeKill = struct {
        real_holder: RealPlatform,
        signals: std.ArrayList(i32) = .{},
        allocator: std.mem.Allocator,

        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .waitNoHangFn = waitNoHang,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real_holder.platform().monoNow();
        }
        fn sleep(ctx: *anyopaque, ns: u64) void {
            _ = ns;
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.real_holder.platform().sleep(10 * std.time.ns_per_ms);
        }
        fn kill(ctx: *anyopaque, pid: i32, sig: i32) bool {
            _ = sig;
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.signals.append(self.allocator, pid) catch {};
            return true; // pretend success — do NOT kill
        }
        fn observe(ctx: *anyopaque, pid: i32) ObserveResult {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real_holder.platform().observe(pid);
        }
        fn waitNoHang(ctx: *anyopaque, pid: i32) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real_holder.platform().waitNoHang(pid);
        }
        fn listChildren(ctx: *anyopaque, allocator: std.mem.Allocator, pid: i32) ![]i32 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.real_holder.platform().listChildren(allocator, pid);
        }
    };

    const pid = try spawnSleepChild();
    defer forceKill(pid);
    std.Thread.sleep(30 * std.time.ns_per_ms);
    const token = observeProcessPresent(pid).?.start_token;

    var fake = FakeKill{ .real_holder = RealPlatform.init(), .allocator = testing.allocator };
    defer fake.signals.deinit(testing.allocator);

    var result = try terminateTree(fake.platform(), testing.allocator, pid, token, .immediate);
    defer result.deinit(testing.allocator);

    try testing.expectEqual(TerminationState.survivors, result.state);
    try testing.expect(isAlive(pid));
    try testing.expect(result.members.len >= 1);
    try testing.expectEqual(MemberFate.survivor, result.members[0].fate);
}

test "PID reuse yields unknown not terminated for the new process" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

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
                .waitNoHangFn = waitNoHang,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.now += 100 * std.time.ns_per_ms;
            return self.now;
        }
        fn sleep(_: *anyopaque, _: u64) void {}
        fn kill(ctx: *anyopaque, pid: i32, _: i32) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid == self.original.pid) self.phase = .after;
            return true;
        }
        fn observe(ctx: *anyopaque, pid: i32) ObserveResult {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid != self.original.pid) return .absent;
            var id = self.original;
            if (self.phase == .after) id.start_token.seconds += 1000;
            return .{ .present = id };
        }
        fn waitNoHang(_: *anyopaque, _: i32) bool {
            return false;
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

    try testing.expect(result.members.len >= 1);
    try testing.expectEqual(MemberFate.unknown, result.members[0].fate);
    try testing.expect(result.state == .unknown or result.state == .survivors);
}

// B1 POSITIVE CONTROL: observe failure with EPERM-class unobservable MUST
// report .unknown, never .terminated. This test fails if revalidate maps
// unobservable → terminated (the pre-fix bug).
test "B1 positive control: EPERM unobservable is unknown not terminated" {
    const EpermPlatform = struct {
        original: ProcessIdentity,
        now: u64 = 0,
        /// After the stop policy signals, observation fails with EPERM-class
        /// unobservable while the process is still "alive" (no wait, no ESRCH).
        signaled: bool = false,

        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .waitNoHangFn = waitNoHang,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            // Stable snapshot quickly: stay under deadline with matching passes.
            if (!self.signaled) {
                self.now += 1;
            } else {
                self.now += 100 * std.time.ns_per_ms;
            }
            return self.now;
        }
        fn sleep(_: *anyopaque, _: u64) void {}
        fn kill(ctx: *anyopaque, _: i32, _: i32) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.signaled = true;
            return true;
        }
        fn observe(ctx: *anyopaque, pid: i32) ObserveResult {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid != self.original.pid) return .absent;
            if (!self.signaled) return .{ .present = self.original };
            // Post-signal: EPERM-class failure — never .absent.
            return .unobservable;
        }
        fn waitNoHang(_: *anyopaque, _: i32) bool {
            return false; // not our child / not reaped
        }
        fn listChildren(_: *anyopaque, allocator: std.mem.Allocator, _: i32) ![]i32 {
            return try allocator.alloc(i32, 0);
        }
    };

    var sim = EpermPlatform{
        .original = .{
            .pid = 7777,
            .start_token = .{ .seconds = 9, .microseconds = 8 },
            .parent = 1,
            .pgid = 7777,
            .session = 7777,
            .executable_len = 0,
            .depth = 0,
        },
    };

    var result = try terminateTree(
        sim.platform(),
        testing.allocator,
        7777,
        sim.original.start_token,
        .immediate,
    );
    defer result.deinit(testing.allocator);

    try testing.expect(result.members.len >= 1);
    // THE ASSERTION THAT FAILS AGAINST UNFIXED CODE:
    // unfixed revalidate: observe failure → .terminated
    // fixed: .unobservable → .unknown
    try testing.expectEqual(MemberFate.unknown, result.members[0].fate);
    try testing.expectEqualStrings("permission-or-unobservable", result.members[0].reason);
    try testing.expectEqual(TerminationState.unknown, result.state);
    // Must NOT claim wait-or-absence without wait/absence evidence.
    try testing.expect(!std.mem.eql(u8, result.members[0].reason, "wait-or-absence"));
}

test "M1: absent root with empty tree reports terminated not unknown" {
    const AbsentRoot = struct {
        now: u64 = 0,
        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .waitNoHangFn = waitNoHang,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.now += 100 * std.time.ns_per_ms;
            return self.now;
        }
        fn sleep(_: *anyopaque, _: u64) void {}
        fn kill(_: *anyopaque, _: i32, _: i32) bool {
            return true;
        }
        fn observe(_: *anyopaque, _: i32) ObserveResult {
            return .absent;
        }
        fn waitNoHang(_: *anyopaque, _: i32) bool {
            return false;
        }
        fn listChildren(_: *anyopaque, allocator: std.mem.Allocator, _: i32) ![]i32 {
            return try allocator.alloc(i32, 0);
        }
    };

    var sim = AbsentRoot{};
    var result = try terminateTree(sim.platform(), testing.allocator, 9999, null, .immediate);
    defer result.deinit(testing.allocator);
    try testing.expectEqual(TerminationState.terminated, result.state);
    try testing.expectEqual(@as(usize, 0), result.members.len);
}

// N1 POSITIVE CONTROL: a changing-but-complete tree (root live, every pass
// complete, membership differs between passes) MUST report .unknown — never
// .terminated. Against the regression (`any_unknown = snap.incomplete` only)
// this yields .terminated and FAIL.
test "N1 positive control: changing-but-complete tree is unknown not terminated" {
    const ChangingTree = struct {
        root: ProcessIdentity,
        child_a: ProcessIdentity,
        child_b: ProcessIdentity,
        now: u64 = 0,
        pass: u32 = 0,

        fn platform(self: *@This()) Platform {
            return .{
                .context = self,
                .monoNowFn = monoNow,
                .sleepFn = sleep,
                .killFn = kill,
                .observeFn = observe,
                .waitNoHangFn = waitNoHang,
                .listChildrenFn = listChildren,
            };
        }
        fn monoNow(ctx: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            // Advance past the 250ms deadline after a few snapshot iterations.
            self.now += 80 * std.time.ns_per_ms;
            return self.now;
        }
        fn sleep(_: *anyopaque, _: u64) void {}
        fn kill(_: *anyopaque, _: i32, _: i32) bool {
            return true;
        }
        fn observe(ctx: *anyopaque, pid: i32) ObserveResult {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid == self.root.pid) return .{ .present = self.root };
            if (pid == self.child_a.pid) return .{ .present = self.child_a };
            if (pid == self.child_b.pid) return .{ .present = self.child_b };
            return .absent;
        }
        fn waitNoHang(_: *anyopaque, _: i32) bool {
            // Pretend reaped after kill so members look terminated — the overall
            // state must STILL be unknown because the snapshot never stabilized.
            return true;
        }
        fn listChildren(ctx: *anyopaque, allocator: std.mem.Allocator, pid: i32) ![]i32 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (pid != self.root.pid) return try allocator.alloc(i32, 0);
            // Alternate membership each list call so consecutive full passes differ.
            self.pass += 1;
            const out = try allocator.alloc(i32, 1);
            out[0] = if (self.pass % 2 == 1) self.child_a.pid else self.child_b.pid;
            return out;
        }
    };

    var sim = ChangingTree{
        .root = .{
            .pid = 5000,
            .start_token = .{ .seconds = 1, .microseconds = 0 },
            .parent = 1,
            .pgid = 5000,
            .session = 5000,
            .depth = 0,
        },
        .child_a = .{
            .pid = 5001,
            .start_token = .{ .seconds = 2, .microseconds = 0 },
            .parent = 5000,
            .pgid = 5000,
            .session = 5000,
            .depth = 1,
        },
        .child_b = .{
            .pid = 5002,
            .start_token = .{ .seconds = 3, .microseconds = 0 },
            .parent = 5000,
            .pgid = 5000,
            .session = 5000,
            .depth = 1,
        },
    };

    var result = try terminateTree(
        sim.platform(),
        testing.allocator,
        5000,
        sim.root.start_token,
        .immediate,
    );
    defer result.deinit(testing.allocator);

    // Snapshot never stabilized → status unknown.
    try testing.expectEqual(SnapshotStatus.unknown, result.snapshot_status);
    // THE ASSERTION THAT FAILS AGAINST THE N1 REGRESSION:
    try testing.expectEqual(TerminationState.unknown, result.state);
    try testing.expect(result.state != .terminated);
}

// B1 real errno branch: launchd (pid 1) is not same-user readable → unobservable.
// Must assert .unobservable (not merely "not absent") so the EPERM/other leg is closed.
test "observeProcess pid 1 is unobservable not absent (real errno branch)" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const result = observeProcess(1);
    // Elevated root can sometimes read pid 1; skip rather than weaken the assert.
    if (result == .present) return error.SkipZigTest;
    try testing.expectEqual(ObserveResult.unobservable, result);
    try testing.expect(result != .absent);
}

test "inspection constants match §21" {
    try testing.expectEqual(@as(u64, 250 * std.time.ns_per_ms), inspection_deadline_ns);
    try testing.expectEqual(@as(u64, 2 * std.time.ns_per_s), graceful_term_wait_ns);
    try testing.expectEqual(@as(u64, 2 * std.time.ns_per_s), graceful_kill_wait_ns);
}
