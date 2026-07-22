//! §21 PTY host leaf — openpty/fork/execve, process group, geometry, start-token
//! at spawn, ordered write-queue drain, raw read loop.
//!
//! Does NOT own VT parse, checkpoint, attach protocol, or broker grants.
//! Integrates process_inspector for spawn-time root identity snapshot.
//!
//! Authority: docs/design/terminal-stack-transition.html §18/§19/§21.
//! Child path after fork is async-signal-safe only (descriptor setup + execve).

const std = @import("std");
const posix = std.posix;
const builtin = @import("builtin");
const process_inspector = @import("process_inspector");

const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("sys/proc_info.h");
    @cInclude("termios.h");
    @cInclude("poll.h");
    @cInclude("errno.h");
    @cInclude("stdlib.h");
});

/// Bound on parent wait for the exec-barrier (R5). Wedged pre-exec children
/// fail at this bound rather than hanging the daemon spawn path forever.
pub const exec_barrier_timeout_ms: c_int = 5_000;

/// Bound on the reap wait after SIGKILL (R5-class, matching §21's 2 s KILL
/// settle bound). A child wedged in uninterruptible I/O fails at this bound
/// instead of hanging the spawn/deinit path on a blocking waitpid forever.
pub const force_kill_reap_timeout_ms: u32 = 2_000;
/// Poll slice for the bounded reap wait.
pub const force_kill_reap_poll_ms: u32 = 10;

// openpty lives in libSystem on macOS; the util.h header is absent from the
// Zig Xcode overlay, so declare it explicitly (same ABI as util.h).
extern "c" fn openpty(
    amaster: *c_int,
    aslave: *c_int,
    name: ?[*:0]u8,
    termp: ?*anyopaque,
    winp: ?*const c.struct_winsize,
) c_int;

/// §18 geometry bounds.
pub const cells_per_dimension_min: u32 = 1;
pub const cells_per_dimension_max: u32 = 1_000;
pub const active_cells_max: u32 = 250_000;
/// §18 stream chunk bound (maximum bytes in one PTY drain write).
pub const stream_chunk_max_bytes: usize = 64 * 1024;
/// Write-queue capacity: the §22 maximum encoded automation transaction
/// (1 MiB body * 4 worst-case expansion + 256 bytes framing).
pub const write_queue_cap_bytes: usize = (1024 * 1024) * 4 + 256;

pub const Error = error{
    GeometryOutOfRange,
    PayloadTooLarge,
    QueueFull,
    NotSpawned,
    Closed,
    SpawnFailed,
    StaleResizeRevision,
    IdentityUnavailable,
    IoFailed,
    NotCanonical,
    DrainStalled,
    Internal,
};

pub const LaunchFailureLayer = enum(c_int) {
    command,
    working_directory,
    environment,
    descriptor_transfer,
    terminal_setup,
    exec_transition,
};

pub const LaunchFailureEvidence = extern struct {
    layer: LaunchFailureLayer,
    os_code: c_int,
};

pub const Geometry = struct {
    columns: u32,
    rows: u32,
    width_px: u32 = 0,
    height_px: u32 = 0,

    pub fn validate(self: Geometry) Error!void {
        if (self.columns < cells_per_dimension_min or self.columns > cells_per_dimension_max)
            return error.GeometryOutOfRange;
        if (self.rows < cells_per_dimension_min or self.rows > cells_per_dimension_max)
            return error.GeometryOutOfRange;
        // Active-cell product; use u64 to avoid overflow before the check.
        const active: u64 = @as(u64, self.columns) * @as(u64, self.rows);
        if (active > active_cells_max) return error.GeometryOutOfRange;
        // §19 positive pixel sizes when set; zero is legitimate (§18: no viewer
        // has established pixels yet). Upper bound is winsize u16 capacity (M2).
        if (self.width_px > std.math.maxInt(u16) or self.height_px > std.math.maxInt(u16))
            return error.GeometryOutOfRange;
    }

    pub fn eql(self: Geometry, other: Geometry) bool {
        return self.columns == other.columns and self.rows == other.rows and
            self.width_px == other.width_px and self.height_px == other.height_px;
    }
};

pub const DescriptorMapping = struct {
    /// The caller retains ownership. The child receives a duplicate only.
    source_fd: posix.fd_t,
    /// Standard streams remain bound to the PTY and cannot be remapped.
    target_fd: posix.fd_t,
};

pub const TerminalProfile = struct {
    input_mode: enum { canonical, literal } = .literal,
    echo: bool = false,
    signal_characters: bool = false,
    software_flow_control: bool = false,
    eof_byte: u8 = 4,
    start_byte: u8 = 17,
    stop_byte: u8 = 19,
    hangup_on_last_close: bool = true,
};

pub const SpawnSpec = struct {
    /// Absolute or PATH-resolved argv[0] identity expected after exec.
    argv: []const []const u8,
    cwd: ?[]const u8 = null,
    /// If null, child inherits the parent environment.
    envp: ?[]const []const u8 = null,
    /// Only these explicitly transferred descriptors survive exec.
    descriptor_map: []const DescriptorMapping = &.{},
    terminal_profile: TerminalProfile = .{},
    geometry: Geometry,
};

/// Positive spawn evidence returned only after live identity observation.
pub const SpawnReadback = struct {
    pid: i32,
    pgid: i32,
    session: i32,
    foreground_pgid: i32,
    start_token: process_inspector.StartToken,
    executable: [c.PROC_PIDPATHINFO_MAXSIZE]u8 = undefined,
    executable_len: usize = 0,
    geometry: Geometry,
    terminal_identity: [c.PROC_PIDPATHINFO_MAXSIZE]u8 = undefined,
    terminal_identity_len: usize = 0,
    initial_profile_applied_before_exec: bool,
    initial_window_applied_before_exec: bool,
    /// process_inspector spawn-time root snapshot status.
    root_snapshot_status: process_inspector.SnapshotStatus,

    pub fn executablePath(self: *const SpawnReadback) []const u8 {
        return self.executable[0..self.executable_len];
    }

    pub fn terminalIdentity(self: *const SpawnReadback) []const u8 {
        return self.terminal_identity[0..self.terminal_identity_len];
    }
};

pub const SpawnOutcome = union(enum) {
    running: SpawnReadback,
    exec_failed: LaunchFailureEvidence,
};

pub const ByteRange = struct {
    start: u64,
    end_exclusive: u64,
};

pub const ReadChunk = struct {
    /// Exclusive-end output sequence after this chunk is applied.
    through_seq: u64,
    /// Bytes owned by the caller until the next read overwrites the internal buf.
    bytes: []const u8,
};

pub const ReapAuthority = enum {
    direct_parent,
    unavailable,
};

pub const ExitState = enum {
    running,
    exited,
    unknown,
};

pub const ExitEvidence = struct {
    authority: ReapAuthority = .unavailable,
    state: ExitState = .unknown,
    /// waitpid reaped this host-owned child.
    reaped: bool,
    exit_code: ?u8 = null,
    term_signal: ?i32 = null,
};

pub const ResizeReceipt = struct {
    revision: u64,
    ordered_at: u64,
    readback: Geometry,
};

pub const PtyHost = struct {
    allocator: std.mem.Allocator,
    master_fd: posix.fd_t = -1,
    pid: i32 = -1,
    pgid: i32 = -1,
    session: i32 = -1,
    start_token: process_inspector.StartToken = .{ .seconds = 0, .microseconds = 0 },
    geometry: Geometry = .{ .columns = 80, .rows = 24 },
    /// Exclusive next PTY-output byte offset (§18 exclusive sequences).
    output_seq: u64 = 0,
    /// Exclusive next PTY-input byte offset owned by the write queue / written.
    input_seq: u64 = 0,
    operation_sequence: u64 = 0,
    resize_revision: u64 = 0,
    resize_ordered_at: u64 = 0,
    write_queue: std.ArrayList(u8) = .{},
    read_buf: []u8 = &[_]u8{},
    closed: bool = false,
    spawned: bool = false,

    pub fn init(allocator: std.mem.Allocator) !PtyHost {
        const read_buf = try allocator.alloc(u8, stream_chunk_max_bytes);
        return .{
            .allocator = allocator,
            .read_buf = read_buf,
        };
    }

    pub fn deinit(self: *PtyHost) void {
        self.closeMaster();
        self.forceKillChild();
        self.write_queue.deinit(self.allocator);
        if (self.read_buf.len > 0) self.allocator.free(self.read_buf);
        self.* = undefined;
    }

    /// Create PTY, fork/exec child (async-signal-safe child path), capture
    /// start-token + process group with process_inspector observation.
    pub fn spawn(self: *PtyHost, spec: SpawnSpec) Error!SpawnOutcome {
        if (self.spawned) return error.Internal;
        try spec.geometry.validate();
        if (spec.argv.len == 0) return .{ .exec_failed = .{
            .layer = .command,
            .os_code = c.EINVAL,
        } };

        const descriptor_limit = c.getdtablesize();
        if (descriptor_limit <= 3) return error.SpawnFailed;
        var max_target: c_int = 2;
        for (spec.descriptor_map, 0..) |mapping, i| {
            if (mapping.target_fd < 3 or mapping.target_fd >= descriptor_limit)
                return .{ .exec_failed = .{
                    .layer = .descriptor_transfer,
                    .os_code = c.EINVAL,
                } };
            for (spec.descriptor_map[0..i]) |prior| {
                if (prior.target_fd == mapping.target_fd)
                    return .{ .exec_failed = .{
                        .layer = .descriptor_transfer,
                        .os_code = c.EINVAL,
                    } };
            }
            max_target = @max(max_target, mapping.target_fd);
        }
        const private_fd_min = max_target + 1;
        const prepared = self.allocator.alloc(PreparedDescriptorMapping, spec.descriptor_map.len) catch
            return error.Internal;
        defer self.allocator.free(prepared);
        var prepared_count: usize = 0;
        defer {
            for (prepared[0..prepared_count]) |mapping| _ = c.close(mapping.source_fd);
        }
        for (spec.descriptor_map) |mapping| {
            const duplicate = c.fcntl(mapping.source_fd, c.F_DUPFD_CLOEXEC, private_fd_min);
            if (duplicate < 0) return .{ .exec_failed = .{
                .layer = .descriptor_transfer,
                .os_code = std.c._errno().*,
            } };
            prepared[prepared_count] = .{
                .source_fd = duplicate,
                .target_fd = mapping.target_fd,
            };
            prepared_count += 1;
        }

        var master: c_int = -1;
        var slave: c_int = -1;
        // openpty allocates the pair; winsize applied after.
        if (openpty(&master, &slave, null, null, null) != 0)
            return error.SpawnFailed;
        // B1: errdefer skips fds set to -1 so manual close + errdefer never double-close
        // a recycled descriptor number in multithreaded sessiond.
        errdefer {
            if (master >= 0) _ = c.close(master);
            if (slave >= 0) _ = c.close(slave);
        }

        const ws = winsizeFromGeometry(spec.geometry);
        if (c.ioctl(slave, c.TIOCSWINSZ, &ws) != 0)
            return error.SpawnFailed;
        var applied_ws: c.struct_winsize = undefined;
        if (c.ioctl(slave, c.TIOCGWINSZ, &applied_ws) != 0)
            return .{ .exec_failed = .{
                .layer = .terminal_setup,
                .os_code = std.c._errno().*,
            } };
        if (!geometryFromWinsize(applied_ws).eql(spec.geometry))
            return .{ .exec_failed = .{
                .layer = .terminal_setup,
                .os_code = c.EIO,
            } };
        if (applyTerminalProfile(slave, spec.terminal_profile)) |os_code|
            return .{ .exec_failed = .{
                .layer = .terminal_setup,
                .os_code = os_code,
            } };
        var terminal_identity: [c.PROC_PIDPATHINFO_MAXSIZE]u8 = @splat(0);
        const terminal_identity_error = c.ttyname_r(
            slave,
            &terminal_identity,
            terminal_identity.len,
        );
        if (terminal_identity_error != 0) return .{ .exec_failed = .{
            .layer = .terminal_setup,
            .os_code = terminal_identity_error,
        } };
        const terminal_identity_len = std.mem.indexOfScalar(
            u8,
            &terminal_identity,
            0,
        ) orelse return .{ .exec_failed = .{
            .layer = .terminal_setup,
            .os_code = c.EIO,
        } };

        // Build C argv before fork (heap is forbidden in the child after fork).
        const argv_owned = try dupeArgv(self.allocator, spec.argv);
        defer freeArgv(self.allocator, argv_owned);

        // Build a complete C envp before fork for the same reason. A null spec
        // inherits environ; a non-null (including empty) spec is passed exactly.
        const envp_owned: ?ArgvOwned = if (spec.envp) |envp|
            try dupeArgv(self.allocator, envp)
        else
            null;
        defer if (envp_owned) |owned| freeArgv(self.allocator, owned);

        const cwd_z: ?[:0]u8 = if (spec.cwd) |cwd|
            self.allocator.dupeZ(u8, cwd) catch return error.Internal
        else
            null;
        defer if (cwd_z) |z| self.allocator.free(z);

        // R1: CLOEXEC exec-barrier pipe — real evidence of the exec transition.
        // Write end is FD_CLOEXEC: successful execve auto-closes it → parent reads EOF;
        // ANY pre-exec / execve failure → child write()s errno then _exit (R2).
        var exec_pipe: [2]c_int = .{ -1, -1 };
        if (c.pipe(&exec_pipe) != 0) return error.SpawnFailed;
        errdefer {
            if (exec_pipe[0] >= 0) _ = c.close(exec_pipe[0]);
            if (exec_pipe[1] >= 0) _ = c.close(exec_pipe[1]);
        }
        // Keep the barrier above every declared target so descriptor transfer
        // cannot overwrite it in the child.
        const barrier_write = c.fcntl(exec_pipe[1], c.F_DUPFD_CLOEXEC, private_fd_min);
        if (barrier_write < 0) return error.SpawnFailed;
        _ = c.close(exec_pipe[1]);
        exec_pipe[1] = barrier_write;
        // R4: CLOEXEC setup must not silently no-op — the barrier depends on it.
        const wfd_flags = c.fcntl(exec_pipe[1], c.F_GETFD);
        if (wfd_flags < 0) return error.SpawnFailed;
        if (c.fcntl(exec_pipe[1], c.F_SETFD, wfd_flags | c.FD_CLOEXEC) < 0)
            return error.SpawnFailed;

        const pid = c.fork();
        if (pid < 0) return error.SpawnFailed;

        if (pid == 0) {
            // ── child: async-signal-safe only ──────────────────────────────
            _ = c.close(master);
            _ = c.close(exec_pipe[0]); // close read end; keep write end for barrier
            // New session; slave becomes controlling terminal.
            if (c.setsid() < 0) childBarrierFail(exec_pipe[1], .terminal_setup, 126);
            if (c.ioctl(slave, c.TIOCSCTTY, @as(c_int, 0)) != 0)
                childBarrierFail(exec_pipe[1], .terminal_setup, 126);
            if (c.ioctl(slave, c.TIOCSWINSZ, &ws) != 0)
                childBarrierFail(exec_pipe[1], .terminal_setup, 126);
            // R2: every pre-exec failure reports through the barrier — never bare
            // _exit, which looks like EOF/success to the parent.
            if (c.dup2(slave, posix.STDIN_FILENO) < 0)
                childBarrierFail(exec_pipe[1], .descriptor_transfer, 126);
            if (c.dup2(slave, posix.STDOUT_FILENO) < 0)
                childBarrierFail(exec_pipe[1], .descriptor_transfer, 126);
            if (c.dup2(slave, posix.STDERR_FILENO) < 0)
                childBarrierFail(exec_pipe[1], .descriptor_transfer, 126);
            if (slave > 2) _ = c.close(slave);
            for (prepared) |mapping| {
                if (c.dup2(mapping.source_fd, mapping.target_fd) < 0)
                    childBarrierFail(exec_pipe[1], .descriptor_transfer, 126);
            }
            closeUndeclaredDescriptors(
                descriptor_limit,
                exec_pipe[1],
                spec.descriptor_map,
            );
            if (cwd_z) |dir| {
                if (c.chdir(dir.ptr) != 0)
                    childBarrierFail(exec_pipe[1], .working_directory, 125);
            }
            const file: [*:0]const u8 = argv_owned.storage[0].ptr;
            const argv_c: [*c]const [*c]u8 = @ptrCast(argv_owned.ptrs);
            const env_c: [*c]const [*c]u8 = if (envp_owned) |owned|
                @ptrCast(owned.ptrs)
            else
                @ptrCast(std.c.environ);
            _ = c.execve(file, argv_c, env_c);
            // execve failed — write errno to the barrier pipe, then exit.
            childBarrierFail(
                exec_pipe[1],
                if (std.c._errno().* == c.E2BIG) .environment else .exec_transition,
                127,
            );
        }

        // ── parent ─────────────────────────────────────────────────────────
        _ = c.close(slave);
        slave = -1; // disarm errdefer for slave (B1)
        _ = c.close(exec_pipe[1]);
        exec_pipe[1] = -1; // only the read end remains for the barrier

        // CLOEXEC on master so later execs in the host don't leak it.
        const flags = c.fcntl(master, c.F_GETFD);
        if (flags < 0) {
            _ = self.forceKillChildWithPid(@intCast(pid), null);
            return error.SpawnFailed;
        }
        if (c.fcntl(master, c.F_SETFD, flags | c.FD_CLOEXEC) < 0) {
            _ = self.forceKillChildWithPid(@intCast(pid), null);
            return error.SpawnFailed;
        }
        // L2: O_NONBLOCK is required for readAvailable's would-block contract
        // (same hard-fail pattern as R4 CLOEXEC).
        const fl = c.fcntl(master, c.F_GETFL);
        if (fl < 0) {
            _ = self.forceKillChildWithPid(@intCast(pid), null);
            return error.SpawnFailed;
        }
        if (c.fcntl(master, c.F_SETFL, fl | c.O_NONBLOCK) < 0) {
            _ = self.forceKillChildWithPid(@intCast(pid), null);
            return error.SpawnFailed;
        }

        self.master_fd = master;
        master = -1; // ownership transferred to self; disarm errdefer (B1)
        self.pid = @intCast(pid);
        self.geometry = spec.geometry;
        self.spawned = true;
        self.closed = false;
        self.output_seq = 0;
        self.input_seq = 0;
        self.operation_sequence = 0;
        self.resize_revision = 0;
        self.write_queue.clearRetainingCapacity();

        // R1/R3/R5: barrier wait — poll with timeout; read retries EINTR.
        // EOF (0) ⇒ exec succeeded; sizeof(c_int) ⇒ child reported failure.
        const barrier = readExecBarrier(exec_pipe[0], exec_barrier_timeout_ms);
        _ = c.close(exec_pipe[0]);
        exec_pipe[0] = -1;
        switch (barrier) {
            .success => {},
            .exec_failed => |failure| {
                self.forceKillChild();
                self.closeMaster();
                self.spawned = false;
                return .{ .exec_failed = failure };
            },
            .spawn_failed, .timeout => {
                self.forceKillChild();
                self.closeMaster();
                self.spawned = false;
                return error.SpawnFailed;
            },
        }

        // Identity tuple from process_inspector — record whatever proc_pidpath
        // returns WITHOUT gating liveness on a basename match (shebang shims
        // resolve to node/sh/etc.).
        var identity: process_inspector.ProcessIdentity = undefined;
        var observed = false;
        var attempts: usize = 0;
        while (attempts < 100) : (attempts += 1) {
            switch (process_inspector.observeProcess(self.pid)) {
                .present => |id| {
                    identity = id;
                    observed = true;
                    break;
                },
                .absent, .unobservable => {},
            }
            std.Thread.sleep(2 * std.time.ns_per_ms);
        }
        if (!observed) {
            // Exec succeeded per pipe but identity unreadable — fail closed.
            self.forceKillChild();
            self.closeMaster();
            self.spawned = false;
            return error.IdentityUnavailable;
        }

        self.start_token = identity.start_token;
        self.pgid = identity.pgid;
        self.session = identity.session;
        const foreground_pgid = c.tcgetpgrp(self.master_fd);
        if (foreground_pgid < 0) {
            self.forceKillChild();
            self.closeMaster();
            self.spawned = false;
            return error.IdentityUnavailable;
        }

        // Spawn-time root snapshot via process_inspector (stable preferred).
        var real_plat = process_inspector.RealPlatform.init();
        var snap = process_inspector.snapshotTree(
            real_plat.platform(),
            self.allocator,
            self.pid,
            self.start_token,
        ) catch {
            // Snapshot failure does not undo a live spawn with identity evidence,
            // but readback reports unknown completeness.
            return .{ .running = makeReadback(
                self,
                identity,
                .unknown,
                foreground_pgid,
                terminal_identity[0..terminal_identity_len],
            ) };
        };
        defer snap.deinit(self.allocator);

        return .{ .running = makeReadback(
            self,
            identity,
            snap.status,
            foreground_pgid,
            terminal_identity[0..terminal_identity_len],
        ) };
    }

    pub fn resize(self: *PtyHost, geometry: Geometry, revision: u64) Error!ResizeReceipt {
        try self.requireOpen();
        try geometry.validate();
        if (revision == 0 or revision <= self.resize_revision)
            return error.StaleResizeRevision;
        const ordered_at = std.math.add(u64, self.operation_sequence, 1) catch
            return error.Internal;
        // Input accepted before this call reaches the PTY before the resize.
        try self.writeDrainAll();
        const ws = winsizeFromGeometry(geometry);
        if (c.ioctl(self.master_fd, c.TIOCSWINSZ, &ws) != 0)
            return error.IoFailed;
        var applied: c.struct_winsize = undefined;
        if (c.ioctl(self.master_fd, c.TIOCGWINSZ, &applied) != 0)
            return error.IoFailed;
        const readback = geometryFromWinsize(applied);
        self.geometry = readback;
        self.resize_revision = revision;
        self.resize_ordered_at = ordered_at;
        self.operation_sequence = ordered_at;
        return .{
            .revision = revision,
            .ordered_at = ordered_at,
            .readback = readback,
        };
    }

    pub fn operationSequence(self: *const PtyHost) u64 {
        return self.operation_sequence;
    }

    pub fn resizeRevision(self: *const PtyHost) u64 {
        return self.resize_revision;
    }

    /// The ordered position the CURRENT revision was applied at. Retained
    /// separately from `operation_sequence`, which later input advances: a
    /// receipt reconstructed from the live sequence would report a position the
    /// resize never occupied.
    pub fn resizeOrderedAt(self: *const PtyHost) u64 {
        return self.resize_ordered_at;
    }

    pub fn availableWriteCredit(self: *const PtyHost) usize {
        return write_queue_cap_bytes - self.write_queue.items.len;
    }

    pub fn canonicalEofByte(self: *PtyHost) Error!u8 {
        try self.requireOpen();
        var term: c.struct_termios = undefined;
        if (c.tcgetattr(self.master_fd, &term) != 0) return error.IoFailed;
        if (term.c_lflag & c.ICANON == 0) return error.NotCanonical;
        return term.c_cc[c.VEOF];
    }

    pub fn hangup(self: *PtyHost) Error!u64 {
        try self.requireOpen();
        try self.writeDrainAll();
        const ordered_at = std.math.add(u64, self.operation_sequence, 1) catch
            return error.Internal;
        self.operation_sequence = ordered_at;
        self.closeMaster();
        return ordered_at;
    }

    /// Atomically accept one contiguous write range into the ordered queue.
    /// Either the whole range is queued or nothing is (no partial acceptance).
    pub fn writeAccept(self: *PtyHost, bytes: []const u8) Error!ByteRange {
        try self.requireOpen();
        if (bytes.len > write_queue_cap_bytes) return error.PayloadTooLarge;
        if (bytes.len > write_queue_cap_bytes - self.write_queue.items.len)
            return error.QueueFull;
        const ordered_at = std.math.add(u64, self.operation_sequence, 1) catch
            return error.Internal;
        const start = self.input_seq + self.write_queue.items.len;
        self.write_queue.appendSlice(self.allocator, bytes) catch return error.Internal;
        self.operation_sequence = ordered_at;
        return .{ .start = start, .end_exclusive = start + bytes.len };
    }

    /// Drain the ordered write queue to the PTY master. Short writes resume
    /// in order; never reorders. Returns bytes written this call.
    pub fn writeDrain(self: *PtyHost) Error!usize {
        try self.requireOpen();
        if (self.write_queue.items.len == 0) return 0;
        const chunk = self.write_queue.items[0..@min(self.write_queue.items.len, stream_chunk_max_bytes)];
        const n = posix.write(self.master_fd, chunk) catch |err| switch (err) {
            error.WouldBlock => return 0,
            error.BrokenPipe, error.ConnectionResetByPeer => return error.Closed,
            else => return error.IoFailed,
        };
        if (n == 0) return 0;
        // Drop drained prefix.
        const remaining = self.write_queue.items[n..];
        std.mem.copyForwards(u8, self.write_queue.items[0..remaining.len], remaining);
        self.write_queue.shrinkRetainingCapacity(remaining.len);
        self.input_seq += n;
        return n;
    }

    /// Consecutive would-block retries before writeDrainAll gives up (~1.5 s
    /// at 100 µs per retry). Progress resets the count, so only a child that
    /// stops reading entirely hits the bound; the old flat 1M-iteration guard
    /// could spin ~100 s on the host's single loop.
    pub const write_drain_stall_budget: usize = 15_000;

    /// Drain until the queue is empty or a would-block/error stops progress.
    /// A continuously stalled consumer yields error.DrainStalled after
    /// write_drain_stall_budget retries — the queued bytes are NOT dropped and
    /// the host loop's writeDrain keeps making progress afterwards.
    pub fn writeDrainAll(self: *PtyHost) Error!void {
        var guard: usize = 0;
        var stalls: usize = 0;
        while (self.write_queue.items.len > 0) : (guard += 1) {
            if (guard > 1_000_000) return error.IoFailed;
            const n = try self.writeDrain();
            if (n == 0) {
                stalls += 1;
                if (stalls > write_drain_stall_budget) return error.DrainStalled;
                // Briefly yield for the PTY consumer.
                std.Thread.sleep(100 * std.time.ns_per_us);
            } else {
                stalls = 0;
            }
        }
    }

    /// Read available PTY output (non-blocking). Empty slice if would-block.
    /// Advances output_seq by the number of bytes returned.
    pub fn readAvailable(self: *PtyHost) Error!ReadChunk {
        try self.requireOpen();
        const n = posix.read(self.master_fd, self.read_buf) catch |err| switch (err) {
            error.WouldBlock => return .{ .through_seq = self.output_seq, .bytes = &[_]u8{} },
            error.BrokenPipe, error.ConnectionResetByPeer => return error.Closed,
            // Darwin hangup: a master read after the last slave close returns
            // EIO (xnu pts master). That is peer-gone, not an I/O fault —
            // report the dead session cleanly as Closed.
            error.InputOutput => return error.Closed,
            else => return error.IoFailed,
        };
        if (n == 0) {
            // EOF from master — peer closed slave side.
            return error.Closed;
        }
        self.output_seq += n;
        return .{
            .through_seq = self.output_seq,
            .bytes = self.read_buf[0..n],
        };
    }

    pub fn foregroundProcessGroupId(self: *const PtyHost) Error!i32 {
        try self.requireOpen();
        const process_group_id = c.tcgetpgrp(self.master_fd);
        if (process_group_id <= 0) return error.IdentityUnavailable;
        return process_group_id;
    }

    /// A sibling authority performed the direct-parent waitpid for this exact
    /// child. Forget the pid before deinit so it can never target a reused pid.
    pub fn recordExternalReap(self: *PtyHost, child_pid: i32) Error!void {
        if (child_pid <= 0 or self.pid != child_pid) return error.IdentityUnavailable;
        self.pid = -1;
    }

    /// Close the PTY master (does not wait the child). Positive exit uses waitExit.
    pub fn closeMaster(self: *PtyHost) void {
        if (self.master_fd >= 0) {
            _ = c.close(self.master_fd);
            self.master_fd = -1;
        }
        self.closed = true;
    }

    /// waitpid readback — never invent exit without reaping evidence.
    pub fn waitExit(self: *PtyHost, hang: bool) Error!ExitEvidence {
        if (self.pid <= 0) return error.NotSpawned;
        var status: c_int = 0;
        const flags: c_int = if (hang) 0 else c.WNOHANG;
        const rc = while (true) {
            const waited = c.waitpid(self.pid, &status, flags);
            if (waited < 0 and std.posix.errno(waited) == .INTR) continue;
            break waited;
        };
        if (rc == 0) return .{
            .authority = .direct_parent,
            .state = .running,
            .reaped = false,
        };
        if (rc < 0) {
            // Raw-int compare: @enumFromInt on an errno not declared in
            // std.posix.E is illegal behavior in ReleaseFast.
            if (std.c._errno().* == @intFromEnum(std.posix.E.CHILD)) {
                // Already reaped elsewhere or no longer our child: authority lost.
                return .{
                    .authority = .unavailable,
                    .state = .unknown,
                    .reaped = false,
                };
            }
            return error.IoFailed;
        }
        self.pid = -1;
        const st: u32 = @bitCast(status);
        if (posix.W.IFEXITED(st)) {
            return .{
                .authority = .direct_parent,
                .state = .exited,
                .reaped = true,
                .exit_code = @intCast(posix.W.EXITSTATUS(st)),
            };
        }
        if (posix.W.IFSIGNALED(st)) {
            return .{
                .authority = .direct_parent,
                .state = .exited,
                .reaped = true,
                .term_signal = @intCast(posix.W.TERMSIG(st)),
            };
        }
        return .{
            .authority = .direct_parent,
            .state = .exited,
            .reaped = true,
        };
    }

    fn requireOpen(self: *const PtyHost) Error!void {
        if (!self.spawned) return error.NotSpawned;
        if (self.closed or self.master_fd < 0) return error.Closed;
    }

    fn forceKillChild(self: *PtyHost) void {
        if (self.pid > 0) {
            // The start token exists only after post-exec identity observation;
            // earlier spawn-failure paths have no token to verify against (the
            // just-forked child is still ours and unreaped, so its pid cannot
            // have been reused).
            const token: ?process_inspector.StartToken = if (self.start_token.seconds != 0 or
                self.start_token.microseconds != 0) self.start_token else null;
            _ = self.forceKillChildWithPid(self.pid, token);
            self.pid = -1;
        }
    }

    /// SIGKILL our own child, then reap with a bounded wait.
    ///
    /// When a start token is on record, re-observe and verify it first (§21
    /// TOCTOU): if the recorded identity is gone — reaped by a sibling
    /// authority and the pid since reused — the pid now belongs to an
    /// unrelated process and must NOT be signalled. Unobservable fails closed
    /// (skip) because reuse cannot be ruled out.
    ///
    /// Returns true when the child was reaped or positively absent; false when
    /// the signal was skipped or the reap deadline expired — the caller must
    /// forget the pid rather than hang on a child wedged in uninterruptible
    /// I/O.
    fn forceKillChildWithPid(
        _: *PtyHost,
        child_pid: i32,
        expected_token: ?process_inspector.StartToken,
    ) bool {
        if (child_pid <= 0) return true;
        if (expected_token) |token| {
            switch (process_inspector.observeProcess(child_pid)) {
                .present => |obs| {
                    // PID reuse: the recorded identity is gone — not our child.
                    if (!obs.start_token.eql(token)) return false;
                },
                // Positive absence: already gone.
                .absent => return true,
                // Cannot rule out reuse — fail closed, do not signal.
                .unobservable => return false,
            }
        }
        _ = c.kill(child_pid, c.SIGKILL);
        // Bounded reap: a blocking waitpid hangs forever on a child wedged in
        // uninterruptible I/O and would stall the spawn/deinit path (R5-class).
        var st: c_int = 0;
        var waited_ms: u32 = 0;
        while (waited_ms < force_kill_reap_timeout_ms) {
            const rc = c.waitpid(child_pid, &st, c.WNOHANG);
            if (rc == child_pid) return true; // positive wait evidence
            if (rc < 0) {
                // ECHILD: a sibling authority already reaped it — child is gone.
                // (Raw-int compare: @enumFromInt on an errno not declared in
                // std.posix.E is illegal behavior in ReleaseFast.)
                if (std.c._errno().* == @intFromEnum(std.posix.E.CHILD)) return true;
                return false;
            }
            std.Thread.sleep(force_kill_reap_poll_ms * std.time.ns_per_ms);
            waited_ms += force_kill_reap_poll_ms;
        }
        return false;
    }
};

const PreparedDescriptorMapping = struct {
    source_fd: c_int,
    target_fd: c_int,
};

const BarrierResult = union(enum) {
    success,
    exec_failed: LaunchFailureEvidence,
    spawn_failed,
    timeout,
};

/// Parent-side barrier: poll with bound (R5), read with EINTR retry (R3).
/// EOF ⇒ success; a complete typed evidence frame ⇒ exec_failed.
/// M1: deadline is monotonic — EINTR must not reset the full timeout budget
/// (SIGCHLD from other children is common in sessiond).
fn readExecBarrier(read_fd: c_int, timeout_ms: c_int) BarrierResult {
    const started = std.time.Instant.now() catch {
        // No monotonic clock: fall back to a single non-retrying poll.
        return readExecBarrierOnce(read_fd, timeout_ms);
    };
    const budget_ns: u64 = @as(u64, @intCast(timeout_ms)) * std.time.ns_per_ms;

    // Wait until readable/HUP or deadline.
    while (true) {
        const now = std.time.Instant.now() catch return .spawn_failed;
        const elapsed = now.since(started);
        if (elapsed >= budget_ns) return .timeout;
        const remaining_ns = budget_ns - elapsed;
        const remaining_ms: c_int = @intCast(@min(remaining_ns / std.time.ns_per_ms, std.math.maxInt(c_int)));
        // poll(0) is a non-blocking poll; use at least 1ms if any budget remains.
        const slice_ms: c_int = if (remaining_ms == 0) 1 else remaining_ms;

        var pfd: c.struct_pollfd = .{
            .fd = read_fd,
            .events = c.POLLIN,
            .revents = 0,
        };
        const pr = c.poll(&pfd, 1, slice_ms);
        if (pr < 0) {
            if (std.c._errno().* == c.EINTR) continue; // M1: retry with remaining budget
            return .spawn_failed;
        }
        if (pr == 0) {
            // Timed out this slice — check deadline (may be true timeout).
            const now2 = std.time.Instant.now() catch return .timeout;
            if (now2.since(started) >= budget_ns) return .timeout;
            continue;
        }
        break;
    }

    var buf: [@sizeOf(LaunchFailureEvidence)]u8 = undefined;
    var filled: usize = 0;
    while (filled < buf.len) {
        const n = c.read(read_fd, buf[filled..].ptr, buf.len - filled);
        if (n == 0) {
            // EOF: write end closed.
            if (filled == 0) return .success;
            return .spawn_failed; // partial errno frame
        }
        if (n < 0) {
            if (std.c._errno().* == c.EINTR) continue; // R3
            return .spawn_failed;
        }
        filled += @intCast(n);
    }
    var failure: LaunchFailureEvidence = undefined;
    @memcpy(std.mem.asBytes(&failure), &buf);
    return .{ .exec_failed = failure };
}

fn readExecBarrierOnce(read_fd: c_int, timeout_ms: c_int) BarrierResult {
    var pfd: c.struct_pollfd = .{
        .fd = read_fd,
        .events = c.POLLIN,
        .revents = 0,
    };
    const pr = c.poll(&pfd, 1, timeout_ms);
    if (pr < 0) return .spawn_failed;
    if (pr == 0) return .timeout;
    var buf: [@sizeOf(LaunchFailureEvidence)]u8 = undefined;
    const n = c.read(read_fd, &buf, buf.len);
    if (n == 0) return .success;
    if (n == @sizeOf(LaunchFailureEvidence)) {
        var failure: LaunchFailureEvidence = undefined;
        @memcpy(std.mem.asBytes(&failure), &buf);
        return .{ .exec_failed = failure };
    }
    return .spawn_failed;
}

/// Child-side: report errno on the barrier (EINTR-retried), then _exit.
/// write() and _exit are async-signal-safe. The evidence frame is ≤ PIPE_BUF.
fn childBarrierFail(
    write_fd: c_int,
    layer: LaunchFailureLayer,
    exit_code: u8,
) noreturn {
    var failure: LaunchFailureEvidence = .{
        .layer = layer,
        .os_code = std.c._errno().*,
    };
    var sent: usize = 0;
    const bytes = std.mem.asBytes(&failure);
    while (sent < bytes.len) {
        const n = c.write(write_fd, bytes[sent..].ptr, bytes.len - sent);
        if (n < 0) {
            if (std.c._errno().* == c.EINTR) continue;
            // L1: a blocking write with the parent still holding the read end can
            // only fail with EINTR in practice (which we retry). EPIPE needs the
            // parent's read end closed; EAGAIN needs O_NONBLOCK. This break is
            // defensive/unreachable under our fd setup — then _exit closes the
            // write end and the parent would see EOF/.success. We still _exit
            // (must not hang the child); do not claim the parent times out.
            break;
        }
        if (n == 0) break;
        sent += @intCast(n);
    }
    c._exit(exit_code);
}

fn closeUndeclaredDescriptors(
    descriptor_limit: c_int,
    barrier_fd: c_int,
    descriptor_map: []const DescriptorMapping,
) void {
    var fd: c_int = 3;
    while (fd < descriptor_limit) : (fd += 1) {
        if (fd == barrier_fd) continue;
        var declared = false;
        for (descriptor_map) |mapping| {
            if (fd == mapping.target_fd) {
                declared = true;
                break;
            }
        }
        if (!declared) _ = c.close(fd);
    }
}

fn winsizeFromGeometry(g: Geometry) c.struct_winsize {
    return .{
        .ws_row = @intCast(g.rows),
        .ws_col = @intCast(g.columns),
        .ws_xpixel = @intCast(g.width_px),
        .ws_ypixel = @intCast(g.height_px),
    };
}

fn geometryFromWinsize(ws: c.struct_winsize) Geometry {
    return .{
        .columns = ws.ws_col,
        .rows = ws.ws_row,
        .width_px = ws.ws_xpixel,
        .height_px = ws.ws_ypixel,
    };
}

fn profileMatches(term: c.struct_termios, profile: TerminalProfile) bool {
    // OPOST|ONLCR are not profile knobs: cfmakeraw clears them, but session
    // PTYs must keep NL→CRNL output processing so bare '\n' (ls, printf,
    // shells) does not staircase in a VT renderer. Always required.
    return (term.c_lflag & c.ICANON != 0) == (profile.input_mode == .canonical) and
        (term.c_lflag & c.ECHO != 0) == profile.echo and
        (term.c_lflag & c.ISIG != 0) == profile.signal_characters and
        (term.c_iflag & c.IXON != 0) == profile.software_flow_control and
        (term.c_iflag & c.IXOFF != 0) == profile.software_flow_control and
        (term.c_cflag & c.HUPCL != 0) == profile.hangup_on_last_close and
        (term.c_oflag & c.OPOST != 0) and
        (term.c_oflag & c.ONLCR != 0) and
        term.c_cc[c.VEOF] == profile.eof_byte and
        term.c_cc[c.VSTART] == profile.start_byte and
        term.c_cc[c.VSTOP] == profile.stop_byte;
}

fn applyTerminalProfile(fd: c_int, profile: TerminalProfile) ?c_int {
    var term: c.struct_termios = undefined;
    if (c.tcgetattr(fd, &term) != 0) return std.c._errno().*;
    c.cfmakeraw(&term);
    // cfmakeraw clears OPOST (and thus ONLCR). Restore output processing so
    // bare '\n' becomes '\r\n' on the master; keep the raw-mode input flags
    // that cfmakeraw established (re-enabled selectively below from profile).
    term.c_oflag |= c.OPOST | c.ONLCR;
    if (profile.input_mode == .canonical) term.c_lflag |= c.ICANON;
    if (profile.echo) term.c_lflag |= c.ECHO;
    if (profile.signal_characters) term.c_lflag |= c.ISIG;
    if (profile.software_flow_control) term.c_iflag |= c.IXON | c.IXOFF;
    if (profile.hangup_on_last_close)
        term.c_cflag |= c.HUPCL
    else
        term.c_cflag &= ~@as(@TypeOf(term.c_cflag), c.HUPCL);
    term.c_cc[c.VEOF] = profile.eof_byte;
    term.c_cc[c.VSTART] = profile.start_byte;
    term.c_cc[c.VSTOP] = profile.stop_byte;
    if (c.tcsetattr(fd, c.TCSANOW, &term) != 0) return std.c._errno().*;
    var applied: c.struct_termios = undefined;
    if (c.tcgetattr(fd, &applied) != 0) return std.c._errno().*;
    return if (profileMatches(applied, profile)) null else c.EIO;
}

fn makeReadback(
    host: *const PtyHost,
    identity: process_inspector.ProcessIdentity,
    snap_status: process_inspector.SnapshotStatus,
    foreground_pgid: i32,
    terminal_identity: []const u8,
) SpawnReadback {
    var rb: SpawnReadback = .{
        .pid = host.pid,
        .pgid = host.pgid,
        .session = host.session,
        .foreground_pgid = foreground_pgid,
        .start_token = host.start_token,
        .geometry = host.geometry,
        .terminal_identity_len = terminal_identity.len,
        .initial_profile_applied_before_exec = true,
        .initial_window_applied_before_exec = true,
        .root_snapshot_status = snap_status,
        .executable_len = identity.executable_len,
    };
    @memcpy(rb.executable[0..identity.executable_len], identity.executablePath());
    @memcpy(rb.terminal_identity[0..terminal_identity.len], terminal_identity);
    return rb;
}

const ArgvOwned = struct {
    /// Null-terminated pointer vector for execve.
    ptrs: [*:null]?[*:0]const u8,
    /// Backing z-strings (owned).
    storage: [][:0]u8,
};

fn dupeArgv(allocator: std.mem.Allocator, items: []const []const u8) Error!ArgvOwned {
    const storage = allocator.alloc([:0]u8, items.len) catch return error.Internal;
    // M1: free only the initialized prefix — storage is uninit until each dupeZ.
    var initialized: usize = 0;
    errdefer {
        for (storage[0..initialized]) |s| allocator.free(s);
        allocator.free(storage);
    }
    for (items, 0..) |item, i| {
        storage[i] = allocator.dupeZ(u8, item) catch return error.Internal;
        initialized += 1;
    }
    const ptrs = allocator.allocSentinel(?[*:0]const u8, items.len, null) catch return error.Internal;
    for (storage, 0..) |s, i| ptrs[i] = s.ptr;
    return .{ .ptrs = ptrs.ptr, .storage = storage };
}

fn freeArgv(allocator: std.mem.Allocator, argv: ArgvOwned) void {
    for (argv.storage) |s| allocator.free(s);
    allocator.free(argv.storage);
    // Reconstruct the sentinel slice from the pointer for free.
    var n: usize = 0;
    while (argv.ptrs[n] != null) : (n += 1) {}
    const slice: [:null]?[*:0]const u8 = argv.ptrs[0..n :null];
    allocator.free(slice);
}

// ── Unit tests ──────────────────────────────────────────────────────────────

const testing = std.testing;

fn defaultGeometry() Geometry {
    return .{ .columns = 80, .rows = 24 };
}

fn expectRunning(outcome: SpawnOutcome) !SpawnReadback {
    return switch (outcome) {
        .running => |readback| readback,
        .exec_failed => error.TestUnexpectedResult,
    };
}

fn expectExecFailed(outcome: SpawnOutcome) !LaunchFailureEvidence {
    return switch (outcome) {
        .running => error.TestUnexpectedResult,
        .exec_failed => |failure| failure,
    };
}

test "geometry bounds: valid accepted, out-of-range rejected" {
    try defaultGeometry().validate();
    try testing.expectError(error.GeometryOutOfRange, (Geometry{ .columns = 0, .rows = 24 }).validate());
    try testing.expectError(error.GeometryOutOfRange, (Geometry{ .columns = 1001, .rows = 24 }).validate());
    try testing.expectError(error.GeometryOutOfRange, (Geometry{ .columns = 500, .rows = 501 }).validate()); // 250500 > 250000
    try (Geometry{ .columns = 500, .rows = 500 }).validate(); // exactly 250000
    // M2: zero pixels ok; above u16 panics/truncates in winsizeFromGeometry.
    try (Geometry{ .columns = 80, .rows = 24, .width_px = 0, .height_px = 0 }).validate();
    try testing.expectError(error.GeometryOutOfRange, (Geometry{
        .columns = 80,
        .rows = 24,
        .width_px = @as(u32, std.math.maxInt(u16)) + 1,
        .height_px = 0,
    }).validate());
}

test "spawn cat: readback proves pid/pgid/start-token/executable" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();

    const rb = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = defaultGeometry(),
    }));

    try testing.expect(rb.pid > 1);
    try testing.expect(rb.pgid != 0);
    try testing.expect(rb.start_token.seconds > 0 or rb.start_token.microseconds > 0);
    try testing.expect(rb.executable_len > 0);
    // Executable is whatever proc_pidpath reports (not basename-matched).
    try testing.expect(rb.executable_len > 0);
    try testing.expect(rb.geometry.eql(defaultGeometry()));
    // Live observation — not invented.
    switch (process_inspector.observeProcess(rb.pid)) {
        .present => |id| {
            try testing.expect(id.start_token.eql(rb.start_token));
            try testing.expectEqual(rb.pid, id.pid);
        },
        .absent, .unobservable => return error.TestUnexpectedResult,
    }

    // Positive control: tear down must reap.
    host.closeMaster();
    // cat exits on EOF of slave after master close — wait.
    var attempts: usize = 0;
    var evidence: ExitEvidence = .{ .reaped = false };
    while (attempts < 100) : (attempts += 1) {
        evidence = try host.waitExit(false);
        if (evidence.reaped) break;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    // If still alive, force path still needs wait evidence on deinit.
    if (!evidence.reaped) {
        // deinit will SIGKILL+wait — that is still positive reaping.
    }
}

test "spawn applies the exact terminal profile and reports real job-control evidence" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const profile: TerminalProfile = .{
        .input_mode = .canonical,
        .echo = true,
        .signal_characters = true,
        .software_flow_control = true,
        .eof_byte = 5,
        .start_byte = 18,
        .stop_byte = 20,
        .hangup_on_last_close = false,
    };
    const geometry: Geometry = .{
        .columns = 93,
        .rows = 31,
        .width_px = 930,
        .height_px = 620,
    };
    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    const rb = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "sleep 5" },
        .terminal_profile = profile,
        .geometry = geometry,
    }));

    try testing.expectEqual(rb.pid, rb.session);
    try testing.expectEqual(rb.pid, rb.pgid);
    try testing.expectEqual(rb.pid, rb.foreground_pgid);
    try testing.expect(rb.terminalIdentity().len > 0);
    try testing.expect(std.mem.startsWith(u8, rb.terminalIdentity(), "/dev/"));
    try testing.expect(rb.initial_profile_applied_before_exec);
    try testing.expect(rb.initial_window_applied_before_exec);

    var applied_profile: c.struct_termios = undefined;
    try testing.expectEqual(@as(c_int, 0), c.tcgetattr(host.master_fd, &applied_profile));
    try testing.expect(profileMatches(applied_profile, profile));
    var applied_window: c.struct_winsize = undefined;
    try testing.expectEqual(
        @as(c_int, 0),
        c.ioctl(host.master_fd, c.TIOCGWINSZ, &applied_window),
    );
    try testing.expect(geometryFromWinsize(applied_window).eql(geometry));
}

// Catches the live-terminal staircase: cfmakeraw clears OPOST, so programs
// that write bare '\n' (ls, printf) reach the VT renderer without CR and each
// line continues at the previous column. Geometry-only live-shell tests pass
// while the pane stairs — this asserts the kernel NL→CRNL expansion on the
// production default (literal/raw input) profile.
test "spawn default profile translates bare newlines via OPOST ONLCR" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    // Default TerminalProfile is literal input / no echo — same shape as the
    // production session_host create path. Child writes bare '\n' only.
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "printf 'a\\nb\\n'" },
        .geometry = defaultGeometry(),
    }));

    var got: std.ArrayList(u8) = .{};
    defer got.deinit(testing.allocator);
    var attempts: usize = 0;
    while (attempts < 200) : (attempts += 1) {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        if (chunk.bytes.len > 0)
            try got.appendSlice(testing.allocator, chunk.bytes)
        else
            std.Thread.sleep(2 * std.time.ns_per_ms);
        if (std.mem.indexOfScalar(u8, got.items, 'b') != null and got.items.len >= 4) break;
    }
    // Without OPOST|ONLCR the master sees "a\nb\n" (stairs in a VT pane).
    // With output processing the kernel expands to CRLF.
    try testing.expectEqualStrings("a\r\nb\r\n", got.items);
}

test "spawn passes the spec environment to the child" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    const env_name = "HIVE_PTY_HOST_SPEC_ENV_7F3C91";
    const env_value = "spec-environment-positive-control";
    try testing.expect(std.posix.getenv(env_name) == null);

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "printf %s \"$HIVE_PTY_HOST_SPEC_ENV_7F3C91\"",
        },
        .envp = &[_][]const u8{
            "HIVE_PTY_HOST_SPEC_ENV_7F3C91=spec-environment-positive-control",
        },
        .geometry = defaultGeometry(),
    }));

    var got: std.ArrayList(u8) = .{};
    defer got.deinit(testing.allocator);
    var attempts: usize = 0;
    while (attempts < 200 and got.items.len < env_value.len) : (attempts += 1) {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        if (chunk.bytes.len > 0)
            try got.appendSlice(testing.allocator, chunk.bytes)
        else
            std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try testing.expectEqualStrings(env_value, got.items);
    try testing.expect(std.posix.getenv(env_name) == null);
}

test "spawn rejects invalid geometry before opening PTY" {
    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    try testing.expectError(error.GeometryOutOfRange, host.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 0, .rows = 24 },
    }));
    try testing.expect(!host.spawned);
}

test "write-queue atomic acceptance: whole range or nothing" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = defaultGeometry(),
    }));

    const a = try host.writeAccept("hello");
    try testing.expectEqual(@as(u64, 0), a.start);
    try testing.expectEqual(@as(u64, 5), a.end_exclusive);
    const b = try host.writeAccept(" world");
    try testing.expectEqual(@as(u64, 5), b.start);

    // A transaction larger than the queue is rejected without partial accept.
    const big = try testing.allocator.alloc(u8, write_queue_cap_bytes + 1);
    defer testing.allocator.free(big);
    @memset(big, 'x');
    const before_len = host.write_queue.items.len;
    try testing.expectError(error.PayloadTooLarge, host.writeAccept(big));
    try testing.expectEqual(before_len, host.write_queue.items.len);

    try host.writeDrainAll();
    // cat echoes — read back.
    var got: std.ArrayList(u8) = .{};
    defer got.deinit(testing.allocator);
    var attempts: usize = 0;
    while (attempts < 200 and got.items.len < 11) : (attempts += 1) {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        if (chunk.bytes.len > 0)
            try got.appendSlice(testing.allocator, chunk.bytes)
        else
            std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try testing.expectEqualStrings("hello world", got.items);
}

test "writeDrainAll bounds a stalled consumer with DrainStalled and keeps the queue" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    // sleep never reads stdin: once the kernel tty buffer fills, every drain
    // would-blocks.
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sleep", "30" },
        .geometry = defaultGeometry(),
    }));

    const chunk = try testing.allocator.alloc(u8, 256 * 1024);
    defer testing.allocator.free(chunk);
    @memset(chunk, 'x');
    _ = try host.writeAccept(chunk);

    const started = std.time.milliTimestamp();
    try testing.expectError(error.DrainStalled, host.writeDrainAll());
    const elapsed = std.time.milliTimestamp() - started;
    // Bounded to the ~1.5 s stall budget, far under the old ~100 s worst case.
    try testing.expect(elapsed < 10_000);
    // Bytes are not dropped: the undrained tail stays queued and the host
    // loop's writeDrain keeps working after the stall.
    try testing.expect(host.write_queue.items.len > 0);
    _ = try host.writeDrain();
}

test "resize enforces geometry bounds" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = defaultGeometry(),
    }));
    const receipt = try host.resize(.{ .columns = 120, .rows = 40 }, 1);
    try testing.expectEqual(@as(u32, 120), host.geometry.columns);
    try testing.expect(receipt.readback.eql(host.geometry));
    try testing.expectError(error.GeometryOutOfRange, host.resize(.{ .columns = 2000, .rows = 40 }, 2));
}

/// Read all PTY output until quiet, optionally dropping one chunk (canary).
fn readAllDigest(
    host: *PtyHost,
    drop_chunk_index: ?usize,
) !struct { digest: [32]u8, total: u64 } {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var total: u64 = 0;
    var chunk_i: usize = 0;
    var idle: usize = 0;
    while (idle < 50) {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        if (chunk.bytes.len == 0) {
            idle += 1;
            std.Thread.sleep(2 * std.time.ns_per_ms);
            continue;
        }
        idle = 0;
        if (drop_chunk_index == null or drop_chunk_index.? != chunk_i) {
            hasher.update(chunk.bytes);
            total += chunk.bytes.len;
        }
        // else: DROP — canary path deliberately omits this chunk from the digest.
        chunk_i += 1;
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return .{ .digest = digest, .total = total };
}

test "ordered read digest: 1 MiB fixture round-trip" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    // Build a patterned temp file and cat it through the PTY.
    var tmp_dir = testing.tmpDir(.{});
    defer tmp_dir.cleanup();
    const file_name = "pattern.bin";
    {
        const f = try tmp_dir.dir.createFile(file_name, .{});
        defer f.close();
        var block: [4096]u8 = undefined;
        // Avoid 0x0A: session PTYs keep OPOST|ONLCR, so bare NL would expand
        // to CRLF and break byte-exact digest round-trip through the slave.
        for (&block, 0..) |*b, i| {
            b.* = @truncate(i);
            if (b.* == '\n') b.* = 0x80;
        }
        var written: usize = 0;
        const target: usize = 1024 * 1024;
        while (written < target) {
            const n = @min(block.len, target - written);
            try f.writeAll(block[0..n]);
            written += n;
        }
    }
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const abs = try tmp_dir.dir.realpath(file_name, &path_buf);

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/cat", abs },
        .geometry = defaultGeometry(),
    }));

    // Expected digest of the file content.
    var expected_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    {
        const f = try tmp_dir.dir.openFile(file_name, .{});
        defer f.close();
        var buf: [8192]u8 = undefined;
        while (true) {
            const n = try f.read(&buf);
            if (n == 0) break;
            expected_hasher.update(buf[0..n]);
        }
    }
    var expected: [32]u8 = undefined;
    expected_hasher.final(&expected);

    const got = try readAllDigest(&host, null);
    try testing.expectEqual(@as(u64, 1024 * 1024), got.total);
    try testing.expectEqualSlices(u8, &expected, &got.digest);
}

test "DROP-A-CHUNK canary: harness FAILS when a chunk is dropped" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    // Positive control for the digest harness: if production dropped a chunk,
    // the comparison must fail. This test deliberately drops chunk 0 and
    // asserts digests differ — proving the canary can see a bug.
    var tmp_dir = testing.tmpDir(.{});
    defer tmp_dir.cleanup();
    const file_name = "canary.bin";
    {
        const f = try tmp_dir.dir.createFile(file_name, .{});
        defer f.close();
        // Enough data to span multiple read chunks.
        var block: [8192]u8 = undefined;
        for (&block, 0..) |*b, i| b.* = @truncate(i * 3);
        var i: usize = 0;
        while (i < 32) : (i += 1) try f.writeAll(&block); // 256 KiB
    }
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const abs = try tmp_dir.dir.realpath(file_name, &path_buf);

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/cat", abs },
        .geometry = defaultGeometry(),
    }));

    const full = try readAllDigest(&host, null);

    // Re-spawn for the drop path.
    var host2 = try PtyHost.init(testing.allocator);
    defer host2.deinit();
    _ = try expectRunning(try host2.spawn(.{
        .argv = &[_][]const u8{ "/bin/cat", abs },
        .geometry = defaultGeometry(),
    }));
    const dropped = try readAllDigest(&host2, 0);

    // Canary: digests MUST differ when a chunk is dropped.
    try testing.expect(!std.mem.eql(u8, &full.digest, &dropped.digest));
    try testing.expect(dropped.total < full.total);
}

test "100 MiB ordered read digest (SLO-04 seed)" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var tmp_dir = testing.tmpDir(.{});
    defer tmp_dir.cleanup();
    const file_name = "hundred.bin";
    const target: usize = 100 * 1024 * 1024;
    {
        const f = try tmp_dir.dir.createFile(file_name, .{});
        defer f.close();
        var block: [64 * 1024]u8 = undefined;
        var seq: u64 = 0;
        var written: usize = 0;
        while (written < target) {
            for (&block) |*b| {
                b.* = @truncate(seq);
                // Same NL avoidance as the 1 MiB digest fixture (OPOST|ONLCR).
                if (b.* == '\n') b.* = 0x80;
                seq +%= 1;
            }
            const n = @min(block.len, target - written);
            try f.writeAll(block[0..n]);
            written += n;
        }
    }
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const abs = try tmp_dir.dir.realpath(file_name, &path_buf);

    var expected_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    {
        const f = try tmp_dir.dir.openFile(file_name, .{});
        defer f.close();
        var buf: [64 * 1024]u8 = undefined;
        while (true) {
            const n = try f.read(&buf);
            if (n == 0) break;
            expected_hasher.update(buf[0..n]);
        }
    }
    var expected: [32]u8 = undefined;
    expected_hasher.final(&expected);

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/cat", abs },
        .geometry = defaultGeometry(),
    }));

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var total: u64 = 0;
    var idle: usize = 0;
    while (total < target and idle < 200) {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        if (chunk.bytes.len == 0) {
            idle += 1;
            std.Thread.sleep(1 * std.time.ns_per_ms);
            continue;
        }
        idle = 0;
        hasher.update(chunk.bytes);
        total += chunk.bytes.len;
    }
    var got: [32]u8 = undefined;
    hasher.final(&got);
    try testing.expectEqual(@as(u64, target), total);
    try testing.expectEqualSlices(u8, &expected, &got);
}

// Exec-barrier: nonexistent binary → child write()s typed errno evidence.
// Must NOT return a SpawnReadback claiming a live child (acting≠being).
test "negative spawn: nonexistent binary returns typed exec evidence" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    const missing = "/tmp/hive-pty-host-no-such-binary-9f3c2e1a";
    const failure = try expectExecFailed(try host.spawn(.{
        .argv = &[_][]const u8{missing},
        .geometry = defaultGeometry(),
    }));
    try testing.expectEqual(LaunchFailureLayer.exec_transition, failure.layer);
    try testing.expectEqual(@as(c_int, c.ENOENT), failure.os_code);
    try testing.expect(!host.spawned);
    try testing.expect(host.master_fd < 0);
    try testing.expect(host.pid <= 0);
}

// R2 positive control: bad cwd → chdir fails → barrier reports failure.
// Old bare _exit(125) looked like EOF/success and returned a live zombie readback.
test "R2: bad cwd returns typed failure not live-child readback" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    const failure = try expectExecFailed(try host.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .cwd = "/nonexistent-dir-hive-pty-host-r2-9f3c",
        .geometry = defaultGeometry(),
    }));
    try testing.expectEqual(LaunchFailureLayer.working_directory, failure.layer);
    try testing.expectEqual(@as(c_int, c.ENOENT), failure.os_code);
    try testing.expect(!host.spawned);
    try testing.expect(host.master_fd < 0);
    try testing.expect(host.pid <= 0);
}

// R1 positive control: shebang/shim whose RESOLVED image ≠ argv[0] basename
// must still SUCCEED. Old basename-match code wrongly SIGKILLed these.
test "R1: shebang shim spawn succeeds when resolved image != argv basename" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    // Wrapper named "provider-shim" that execs /bin/cat — resolved image is cat.
    const shim_name = "provider-shim";
    {
        const f = try tmp.dir.createFile(shim_name, .{ .mode = 0o755 });
        defer f.close();
        try f.writeAll("#!/bin/sh\nexec /bin/cat \"$@\"\n");
    }
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const abs = try tmp.dir.realpath(shim_name, &path_buf);

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    const rb = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{abs},
        .geometry = defaultGeometry(),
    }));
    // THE ASSERTION THAT FAILS AGAINST BASENAME-MATCH CODE:
    // want_name would be "provider-shim" but proc_pidpath is ".../sh" or ".../cat".
    try testing.expect(host.spawned);
    try testing.expect(rb.pid > 1);
    try testing.expect(rb.start_token.seconds > 0 or rb.start_token.microseconds > 0);
    // Live child — not IdentityUnavailable / SIGKILL.
    switch (process_inspector.observeProcess(rb.pid)) {
        .present => {},
        .absent, .unobservable => return error.TestUnexpectedResult,
    }
}

test "successful spawn still has post-exec identity evidence" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    const rb = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/echo", "ping" },
        .geometry = defaultGeometry(),
    }));
    try testing.expect(rb.start_token.seconds != 0 or rb.start_token.microseconds != 0);
    try testing.expect(rb.executable_len > 0);
    _ = host.waitExit(true) catch {};
}

// PID-reuse guard positive control: the force-kill path must NOT signal a pid
// whose recorded start token no longer matches (reaped by a sibling authority
// and the pid since reused). Unfixed code SIGKILLs the bare pid — this test
// FAILS if the real child is killed after its recorded token is replaced.
// (forceKillChild is exercised directly: deinit's closeMaster would SIGHUP the
// session on its own and drown the signal this test isolates.)
test "forceKillChild skips SIGKILL when the recorded start token no longer matches" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sleep", "30" },
        .geometry = defaultGeometry(),
    }));
    const child_pid = host.pid;
    const real_token = host.start_token;
    // Simulate a reused pid: the recorded token no longer matches the process.
    host.start_token = .{
        .seconds = real_token.seconds +% 1000,
        .microseconds = real_token.microseconds,
    };
    host.forceKillChild();

    // The child must NOT have been signalled — still alive with its real token.
    switch (process_inspector.observeProcess(child_pid)) {
        .present => |id| try testing.expect(id.start_token.eql(real_token)),
        .absent, .unobservable => return error.TestUnexpectedResult,
    }
    // Restore ownership so the deferred deinit reaps the real child.
    host.pid = child_pid;
    host.start_token = real_token;
}

// Matching-token path: deinit SIGKILLs our own child and the bounded reap
// produces positive absence evidence (the reap bound must not break the
// ordinary force-kill path).
test "deinit with matching start token SIGKILLs and reaps the child" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sleep", "30" },
        .geometry = defaultGeometry(),
    }));
    const child_pid = host.pid;
    host.deinit();

    try testing.expectEqual(
        process_inspector.ObserveResult.absent,
        process_inspector.observeProcess(child_pid),
    );
}

// Darwin hangup: after the child exits (last slave close), a master read
// returns EIO — must surface as Closed, not IoFailed, so dead sessions are
// reported cleanly.
test "readAvailable reports Closed (not IoFailed) after child hangup" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;

    var host = try PtyHost.init(testing.allocator);
    defer host.deinit();
    _ = try expectRunning(try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "exit 0" },
        .geometry = defaultGeometry(),
    }));
    // Reap the child so the slave side is fully closed.
    const evidence = try host.waitExit(true);
    try testing.expect(evidence.reaped);

    var closed = false;
    var attempts: usize = 0;
    while (attempts < 200) : (attempts += 1) {
        _ = host.readAvailable() catch |err| switch (err) {
            error.Closed => {
                closed = true;
                break;
            },
            // THE ASSERTION THAT FAILS AGAINST UNFIXED CODE: EIO → IoFailed.
            else => return err,
        };
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try testing.expect(closed);
}
