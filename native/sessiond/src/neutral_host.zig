const std = @import("std");
const pty_host = @import("pty_host");
const process_inspector = @import("process_inspector");

const c = @cImport({
    @cInclude("signal.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

pub const schema_version: u8 = 1;
pub const socket_relative_path = "host.sock";
pub const record_relative_path = "record.json";
pub const control_relative_path = "control.cap";
pub const runtime_relative_path = "neutral";
pub const operation_payload_max_bytes: usize = 16 * 1024 * 1024;

pub const SessionRef = struct {
    key: []const u8,
    incarnation: []const u8,

    pub fn eql(self: SessionRef, other: SessionRef) bool {
        return std.mem.eql(u8, self.key, other.key) and
            std.mem.eql(u8, self.incarnation, other.incarnation);
    }
};

pub const ProcessIdentity = struct {
    processId: i32,
    startToken: []const u8,
};

pub const WindowSize = struct {
    columns: u32,
    rows: u32,
    widthPixels: u32,
    heightPixels: u32,

    fn ptyGeometry(self: WindowSize) pty_host.Geometry {
        return .{
            .columns = self.columns,
            .rows = self.rows,
            .width_px = self.widthPixels,
            .height_px = self.heightPixels,
        };
    }
};

pub const TerminalProfile = struct {
    inputMode: enum { canonical, literal },
    echo: bool,
    signalCharacters: bool,
    softwareFlowControl: bool,
    eofByte: u8,
    startByte: u8,
    stopByte: u8,
    hangupOnLastClose: bool,

    fn ptyProfile(self: TerminalProfile) pty_host.TerminalProfile {
        return .{
            .input_mode = switch (self.inputMode) {
                .canonical => .canonical,
                .literal => .literal,
            },
            .echo = self.echo,
            .signal_characters = self.signalCharacters,
            .software_flow_control = self.softwareFlowControl,
            .eof_byte = self.eofByte,
            .start_byte = self.startByte,
            .stop_byte = self.stopByte,
            .hangup_on_last_close = self.hangupOnLastClose,
        };
    }
};

pub const EnvironmentEntry = struct { name: []const u8, value: []const u8 };

pub const TransferableHandle = struct {
    token: []const u8,
    sourceDisposition: enum { retain, @"close-after-transfer" },
};

pub const DescriptorMapping = struct {
    handle: TransferableHandle,
    targetDescriptor: i32,
};

pub const Command = struct {
    executable: []const u8,
    arguments: []const []const u8,
    workingDirectory: []const u8,
    completeEnvironment: []const EnvironmentEntry,
    descriptorMap: []const DescriptorMapping,
};

pub const CreateRequest = struct {
    key: []const u8,
    idempotencyKey: []const u8,
    command: Command,
    terminalProfile: TerminalProfile,
    initialWindow: WindowSize,
};

pub const LaunchSpec = struct {
    argv: []const []const u8,
    cwd: []const u8,
    /// Complete replacement environment in `name=value` form.
    envp: []const []const u8,
    terminalProfile: TerminalProfile,
    initialWindow: WindowSize,
};

pub const HostLimits = struct {
    maxInputTransactionBytes: usize,
    maxInputQueueBytes: usize,
    maxOutputFrameBytes: usize,
    outputLowWaterBytes: usize,
    outputHighWaterBytes: usize,
    outputRetentionBytes: usize,
};

pub const JobControlEvidence = struct {
    sessionLeader: bool,
    controllingTerminal: bool,
    standardStreamsShareTerminal: bool,
    childSessionId: i32,
    childProcessGroupId: i32,
    foregroundProcessGroupId: i32,
    terminalIdentity: []const u8,
    initialProfileAppliedBeforeExec: bool,
    initialWindowAppliedBeforeExec: bool,
    completeness: enum { complete, partial, unavailable, unknown },
};

pub const ExitStatus = struct {
    code: ?i32,
    signal: ?i32,
    observedAt: []const u8,
};

pub const ReapEvidence = struct {
    authority: enum { @"direct-parent", @"durable-parent-record", unavailable },
    reaped: bool,
    status: ?ExitStatus,
    completeness: enum { complete, partial, unavailable, unknown },
};

pub const OsCode = union(enum) {
    string: []const u8,
    number: i32,
};

pub const LaunchOutcome = union(enum) {
    running: struct {
        child: ProcessIdentity,
        execProof: enum { @"replacement-observed" },
        jobControl: JobControlEvidence,
    },
    @"exec-failed": struct {
        layer: enum {
            command,
            @"working-directory",
            environment,
            @"descriptor-transfer",
            @"terminal-setup",
            @"exec-transition",
        },
        osCode: ?OsCode,
        diagnostic: []const u8,
    },
    exited: struct { exit: ExitStatus, reap: ReapEvidence },
    unknown: struct { diagnostic: []const u8 },
};

pub const CreateResult = struct {
    session: SessionRef,
    outcome: LaunchOutcome,
    limits: HostLimits,
};

/// Operation-facing host abstraction. The production implementation belongs
/// above the persistence/socket lifecycle in this module.
pub const Host = struct {
    context: *anyopaque,
    createFn: *const fn (*anyopaque, CreateRequest) anyerror!CreateResult,

    pub fn create(self: Host, request: CreateRequest) !CreateResult {
        return self.createFn(self.context, request);
    }
};

const ExecFailedPayload = std.meta.TagPayload(LaunchOutcome, .@"exec-failed");
const LaunchFailureLayer = @FieldType(ExecFailedPayload, "layer");
const ExecProof = @FieldType(std.meta.TagPayload(LaunchOutcome, .running), "execProof");

/// Limits advertised with every create. Derived from the terminal layer's own
/// queue and chunk bounds so the wire never promises more than the host holds.
const direct_host_limits: HostLimits = .{
    .maxInputTransactionBytes = pty_host.stream_chunk_max_bytes,
    .maxInputQueueBytes = pty_host.write_queue_cap_bytes,
    .maxOutputFrameBytes = pty_host.stream_chunk_max_bytes,
    .outputLowWaterBytes = pty_host.stream_chunk_max_bytes,
    .outputHighWaterBytes = pty_host.write_queue_cap_bytes,
    .outputRetentionBytes = pty_host.write_queue_cap_bytes,
};

/// Ledger encoding of `LaunchOutcome`. The stored bytes are exactly the frozen
/// flattened wire shape, and reading them back is the single path by which any
/// create result is returned. This struct is the permissive READ shape; writes
/// go through `stringify`, which emits one variant at a time.
const StoredOutcome = struct {
    state: enum { running, @"exec-failed", unknown },
    child: ?ProcessIdentity = null,
    execProof: ?ExecProof = null,
    jobControl: ?JobControlEvidence = null,
    layer: ?LaunchFailureLayer = null,
    osCode: ?i32 = null,
    diagnostic: ?[]const u8 = null,

    fn execFailed(layer: LaunchFailureLayer, os_code: ?i32, diagnostic: []const u8) StoredOutcome {
        return .{
            .state = .@"exec-failed",
            .layer = layer,
            .osCode = os_code,
            .diagnostic = diagnostic,
        };
    }

    fn unknown(diagnostic: []const u8) StoredOutcome {
        return .{ .state = .unknown, .diagnostic = diagnostic };
    }

    /// Written one variant at a time. The frozen create-result schema marks
    /// every field of a variant required — including `osCode`, which is
    /// nullable but must still be PRESENT on exec-failed. Emitting the flat
    /// struct with nulls dropped omits it; emitting it with nulls kept adds
    /// fields the schema forbids on the other variants (additionalProperties
    /// is false), so neither flat form validates.
    fn stringify(self: StoredOutcome, allocator: std.mem.Allocator) ![]u8 {
        return switch (self.state) {
            .running => std.json.Stringify.valueAlloc(allocator, .{
                .state = self.state,
                .child = self.child orelse return error.InvalidCreateResult,
                .execProof = self.execProof orelse return error.InvalidCreateResult,
                .jobControl = self.jobControl orelse return error.InvalidCreateResult,
            }, .{}),
            .@"exec-failed" => std.json.Stringify.valueAlloc(allocator, .{
                .state = self.state,
                .layer = self.layer orelse return error.InvalidCreateResult,
                .osCode = self.osCode,
                .diagnostic = self.diagnostic orelse return error.InvalidCreateResult,
            }, .{}),
            .unknown => std.json.Stringify.valueAlloc(allocator, .{
                .state = self.state,
                .diagnostic = self.diagnostic orelse return error.InvalidCreateResult,
            }, .{}),
        };
    }

    fn toOutcome(self: StoredOutcome) !LaunchOutcome {
        return switch (self.state) {
            .running => .{ .running = .{
                .child = self.child orelse return error.InvalidCreateResult,
                .execProof = self.execProof orelse return error.InvalidCreateResult,
                .jobControl = self.jobControl orelse return error.InvalidCreateResult,
            } },
            .@"exec-failed" => .{ .@"exec-failed" = .{
                .layer = self.layer orelse return error.InvalidCreateResult,
                .osCode = if (self.osCode) |code| .{ .number = code } else null,
                .diagnostic = self.diagnostic orelse return error.InvalidCreateResult,
            } },
            .unknown => .{ .unknown = .{
                .diagnostic = self.diagnostic orelse return error.InvalidCreateResult,
            } },
        };
    }
};

fn wireLaunchFailureLayer(layer: pty_host.LaunchFailureLayer) LaunchFailureLayer {
    return switch (layer) {
        .command => .command,
        .working_directory => .@"working-directory",
        .environment => .environment,
        .descriptor_transfer => .@"descriptor-transfer",
        .terminal_setup => .@"terminal-setup",
        .exec_transition => .@"exec-transition",
    };
}

fn putField(hasher: *std.crypto.hash.sha2.Sha256, value: []const u8) void {
    putLength(hasher, value.len);
    hasher.update(value);
}

fn putInt(hasher: *std.crypto.hash.sha2.Sha256, value: i64) void {
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(i64, &bytes, value, .big);
    hasher.update(&bytes);
}

/// Injective, length-prefixed digest over every frozen create field. The ledger
/// compares it so a replayed idempotency key carrying a different request is a
/// typed conflict rather than a silent second launch.
fn hashCreateRequest(request: CreateRequest, out: *[32]u8) void {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    putField(&hasher, request.key);
    putField(&hasher, request.idempotencyKey);
    putField(&hasher, request.command.executable);
    putLength(&hasher, request.command.arguments.len);
    for (request.command.arguments) |argument| putField(&hasher, argument);
    putField(&hasher, request.command.workingDirectory);
    putLength(&hasher, request.command.completeEnvironment.len);
    for (request.command.completeEnvironment) |entry| {
        putField(&hasher, entry.name);
        putField(&hasher, entry.value);
    }
    putLength(&hasher, request.command.descriptorMap.len);
    for (request.command.descriptorMap) |mapping| {
        putField(&hasher, mapping.handle.token);
        putInt(&hasher, @intFromEnum(mapping.handle.sourceDisposition));
        putInt(&hasher, mapping.targetDescriptor);
    }
    putInt(&hasher, @intFromEnum(request.terminalProfile.inputMode));
    putInt(&hasher, @intFromBool(request.terminalProfile.echo));
    putInt(&hasher, @intFromBool(request.terminalProfile.signalCharacters));
    putInt(&hasher, @intFromBool(request.terminalProfile.softwareFlowControl));
    putInt(&hasher, request.terminalProfile.eofByte);
    putInt(&hasher, request.terminalProfile.startByte);
    putInt(&hasher, request.terminalProfile.stopByte);
    putInt(&hasher, @intFromBool(request.terminalProfile.hangupOnLastClose));
    putInt(&hasher, request.initialWindow.columns);
    putInt(&hasher, request.initialWindow.rows);
    putInt(&hasher, request.initialWindow.widthPixels);
    putInt(&hasher, request.initialWindow.heightPixels);
    hasher.final(out);
}

pub const LaunchEvidence = struct {
    /// Image the child is actually running, as resolved after exec.
    executable: []const u8,
    rootSnapshotStatus: process_inspector.SnapshotStatus,
};

/// Production `Host`: opens its own terminal and launches the frozen command
/// directly. It owns the resulting PTY, so it must run in the process that will
/// go on to serve the session. Create is exactly-once by the registry ledger —
/// a replayed idempotency key returns the recorded result and never spawns.
pub const DirectHost = struct {
    allocator: std.mem.Allocator,
    registry: *Registry,
    pty: *pty_host.PtyHost,
    arena: std.heap.ArenaAllocator,
    /// Spawn attempts actually issued to the terminal layer. The ledger must
    /// hold this at one per created session; replays may never advance it.
    spawns: usize = 0,
    /// Launch evidence the frozen CreateResult does not carry. A product host
    /// above this module records the resolved image and the process-tree
    /// snapshot status on its own record, so keep them from the readback rather
    /// than making it re-derive what this create already measured.
    launch_evidence: ?LaunchEvidence = null,

    pub fn init(
        allocator: std.mem.Allocator,
        registry: *Registry,
        pty: *pty_host.PtyHost,
    ) DirectHost {
        return .{
            .allocator = allocator,
            .registry = registry,
            .pty = pty,
            .arena = std.heap.ArenaAllocator.init(allocator),
        };
    }

    pub fn deinit(self: *DirectHost) void {
        self.arena.deinit();
    }

    pub fn host(self: *DirectHost) Host {
        return .{ .context = self, .createFn = createCb };
    }

    fn createCb(context: *anyopaque, request: CreateRequest) anyerror!CreateResult {
        const self: *DirectHost = @ptrCast(@alignCast(context));
        return self.create(request);
    }

    pub fn create(self: *DirectHost, request: CreateRequest) !CreateResult {
        var digest: [32]u8 = undefined;
        hashCreateRequest(request, &digest);
        switch (try self.registry.reserve(
            request.key,
            request.idempotencyKey,
            digest,
            request.initialWindow,
        )) {
            .existing => |record| {
                const session = try self.ownSession(record.session);
                return self.replay(session);
            },
            .reserved => |record| {
                const session = try self.ownSession(record.session);
                return self.launch(session, request);
            },
        }
    }

    /// A `Record` borrows registry storage that the next mutation recycles, so
    /// the identity this host hands out — and keeps using across register and
    /// commit — must be copied out of the registry arena first.
    fn ownSession(self: *DirectHost, session: SessionRef) !SessionRef {
        const a = self.arena.allocator();
        return .{
            .key = try a.dupe(u8, session.key),
            .incarnation = try a.dupe(u8, session.incarnation),
        };
    }

    /// The one path that turns ledger state into a create result, so a first
    /// create and its replay cannot diverge.
    fn replay(self: *DirectHost, session: SessionRef) !CreateResult {
        const record = self.registry.get(session) orelse return error.SessionNotFound;
        // A reservation without a committed result means an earlier create died
        // mid-launch. Its child may well be running, so relaunching here would
        // double-spawn: report the launch as unproven instead of guessing.
        const stored = record.createResultJson orelse return .{
            .session = session,
            .outcome = .{ .unknown = .{
                .diagnostic = "create was reserved without a committed result; launch state is unproven",
            } },
            .limits = direct_host_limits,
        };
        const parsed = try std.json.parseFromSliceLeaky(
            StoredOutcome,
            self.arena.allocator(),
            stored,
            .{},
        );
        return .{
            .session = session,
            .outcome = try parsed.toOutcome(),
            .limits = direct_host_limits,
        };
    }

    fn commit(self: *DirectHost, session: SessionRef, outcome: StoredOutcome) !CreateResult {
        const json = try outcome.stringify(self.allocator);
        defer self.allocator.free(json);
        _ = try self.registry.commitCreate(session, json);
        return self.replay(session);
    }

    fn launch(self: *DirectHost, session: SessionRef, request: CreateRequest) !CreateResult {
        // M1: the wire carries opaque transfer tokens and this host has no
        // descriptor-passing channel that could resolve one into a descriptor.
        // Refuse in the ledger so the rejection replays like any other result.
        if (request.command.descriptorMap.len > 0) return self.commit(session, StoredOutcome.execFailed(
            .@"descriptor-transfer",
            null,
            "descriptor map is unsupported in M1; this host opens its own terminal",
        ));

        var scratch = std.heap.ArenaAllocator.init(self.allocator);
        defer scratch.deinit();
        const a = scratch.allocator();

        // argv[0] is the image execve resolves, so the frozen executable leads.
        const argv = try a.alloc([]const u8, request.command.arguments.len + 1);
        argv[0] = request.command.executable;
        @memcpy(argv[1..], request.command.arguments);
        const envp = try a.alloc([]const u8, request.command.completeEnvironment.len);
        for (request.command.completeEnvironment, envp) |entry, *slot|
            slot.* = try std.fmt.allocPrint(a, "{s}={s}", .{ entry.name, entry.value });

        self.spawns += 1;
        const outcome = self.pty.spawn(.{
            .argv = argv,
            .cwd = request.command.workingDirectory,
            .envp = envp,
            .terminal_profile = request.terminalProfile.ptyProfile(),
            .geometry = request.initialWindow.ptyGeometry(),
        }) catch |err| return self.commit(session, StoredOutcome.unknown(@errorName(err)));
        const spawned = switch (outcome) {
            .running => |value| value,
            .exec_failed => |evidence| return self.commit(session, StoredOutcome.execFailed(
                wireLaunchFailureLayer(evidence.layer),
                evidence.os_code,
                "terminal launch failed before the child reached exec",
            )),
        };
        self.launch_evidence = .{
            .executable = try self.arena.allocator().dupe(u8, spawned.executablePath()),
            .rootSnapshotStatus = spawned.root_snapshot_status,
        };

        const host_identity = process_inspector.observeProcessPresent(c.getpid()) orelse
            return self.commit(session, StoredOutcome.unknown("host process identity unavailable"));
        var host_token_storage: [64]u8 = undefined;
        const host_token = try host_identity.start_token.format(&host_token_storage);
        var child_token_storage: [64]u8 = undefined;
        const child_token = try spawned.start_token.format(&child_token_storage);

        // A running readback exists only after the child cleared the
        // setsid/TIOCSCTTY/dup2 barrier, so these bits are measured, not assumed.
        const session_leader = spawned.pid == spawned.session;
        const controlling_terminal = spawned.terminalIdentity().len > 0;
        const job_control: JobControlEvidence = .{
            .sessionLeader = session_leader,
            .controllingTerminal = controlling_terminal,
            // The exec barrier binds all three standard streams to the slave.
            .standardStreamsShareTerminal = true,
            .childSessionId = spawned.session,
            .childProcessGroupId = spawned.pgid,
            .foregroundProcessGroupId = spawned.foreground_pgid,
            .terminalIdentity = spawned.terminalIdentity(),
            .initialProfileAppliedBeforeExec = spawned.initial_profile_applied_before_exec,
            .initialWindowAppliedBeforeExec = spawned.initial_window_applied_before_exec,
            .completeness = if (session_leader and controlling_terminal and
                spawned.initial_profile_applied_before_exec and
                spawned.initial_window_applied_before_exec) .complete else .partial,
        };

        // The registered window is the geometry read back off the terminal, not
        // the one requested.
        _ = try self.registry.register(session, .{
            .host = .{ .processId = c.getpid(), .startToken = host_token },
            .child = .{ .processId = spawned.pid, .startToken = child_token },
            .childSessionId = spawned.session,
            .childProcessGroupId = spawned.pgid,
            .foregroundProcessGroupId = spawned.foreground_pgid,
            .terminalIdentity = spawned.terminalIdentity(),
            .sessionLeader = session_leader,
            .controllingTerminal = controlling_terminal,
            .standardStreamsShareTerminal = true,
            .initialProfileAppliedBeforeExec = spawned.initial_profile_applied_before_exec,
            .initialWindowAppliedBeforeExec = spawned.initial_window_applied_before_exec,
            .window = .{
                .columns = spawned.geometry.columns,
                .rows = spawned.geometry.rows,
                .widthPixels = spawned.geometry.width_px,
                .heightPixels = spawned.geometry.height_px,
            },
        });
        return self.commit(session, .{
            .state = .running,
            .child = .{ .processId = spawned.pid, .startToken = child_token },
            .execProof = .@"replacement-observed",
            .jobControl = job_control,
        });
    }
};

pub const Lifecycle = enum { reserved, create_failed, live, exited, reaped, unknown };

pub const OutputEvidence = struct {
    retainedStart: u64 = 0,
    retainedEndExclusive: u64 = 0,
    closed: bool = false,
};

pub const CheckpointEvidence = struct {
    retained: u32 = 0,
    newestThroughEventSequence: ?u64 = null,
    newestThroughOutputOffset: ?u64 = null,
};

pub const Record = struct {
    session: SessionRef,
    createIdempotencyKey: []const u8,
    requestSha256: [32]u8,
    createResultJson: ?[]const u8 = null,
    terminationIdempotencyKey: ?[]const u8 = null,
    terminationRequestSha256: ?[32]u8 = null,
    terminationResultJson: ?[]const u8 = null,
    lifecycle: Lifecycle = .reserved,
    host: ?ProcessIdentity = null,
    child: ?ProcessIdentity = null,
    childSessionId: ?i32 = null,
    childProcessGroupId: ?i32 = null,
    foregroundProcessGroupId: ?i32 = null,
    terminalIdentity: ?[]const u8 = null,
    sessionLeader: ?bool = null,
    controllingTerminal: ?bool = null,
    standardStreamsShareTerminal: ?bool = null,
    initialProfileAppliedBeforeExec: ?bool = null,
    initialWindowAppliedBeforeExec: ?bool = null,
    window: WindowSize,
    windowRevision: u64 = 0,
    eventSequenceHighWater: ?u64 = null,
    output: OutputEvidence = .{},
    checkpoints: CheckpointEvidence = .{},
    exit: ?ExitStatus = null,
    reap: ?ReapEvidence = null,
};

pub const HostRegistration = struct {
    host: ProcessIdentity,
    child: ProcessIdentity,
    childSessionId: i32,
    childProcessGroupId: i32,
    foregroundProcessGroupId: i32,
    terminalIdentity: []const u8,
    sessionLeader: bool,
    controllingTerminal: bool,
    standardStreamsShareTerminal: bool,
    initialProfileAppliedBeforeExec: bool,
    initialWindowAppliedBeforeExec: bool,
    window: WindowSize,
};

pub const RecordUpdate = struct {
    lifecycle: ?Lifecycle = null,
    window: ?WindowSize = null,
    windowRevision: ?u64 = null,
    eventSequenceHighWater: ?u64 = null,
    output: ?OutputEvidence = null,
    checkpoints: ?CheckpointEvidence = null,
    exit: ?ExitStatus = null,
    reap: ?ReapEvidence = null,
};

pub const ReserveResult = union(enum) {
    reserved: Record,
    existing: Record,
};

pub const TerminationReserveResult = union(enum) {
    reserved,
    pending,
    replay: []const u8,
};

fn putLength(hasher: *std.crypto.hash.sha2.Sha256, length: usize) void {
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(u64, &bytes, @intCast(length), .big);
    hasher.update(&bytes);
}

/// The opaque key is never interpreted as a path component. Length-prefixing
/// makes the tuple encoding injective before hashing.
pub fn sessionDirectoryName(session: SessionRef) [46]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    putLength(&hasher, session.key.len);
    hasher.update(session.key);
    putLength(&hasher, session.incarnation.len);
    hasher.update(session.incarnation);
    const digest = hasher.finalResult();
    var result: [46]u8 = undefined;
    @memcpy(result[0..3], "nh-");
    _ = std.base64.url_safe_no_pad.Encoder.encode(result[3..], &digest);
    return result;
}

fn requireOwnedDirectory(directory: std.fs.Dir) !void {
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
    try directory.chmod(0o700);
    const secured = try std.posix.fstat(directory.fd);
    if (secured.mode & 0o777 != 0o700) return error.DirectorySubstitution;
}

fn requireOwnedRoot(directory: std.fs.Dir) !void {
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
}

fn openPrivateDirectory(parent: std.fs.Dir, name: []const u8) !std.fs.Dir {
    parent.makeDir(name) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    var result = parent.openDir(name, .{ .no_follow = true, .iterate = true }) catch |err| switch (err) {
        error.SymLinkLoop, error.NotDir => return error.DirectorySubstitution,
        else => return err,
    };
    errdefer result.close();
    try requireOwnedDirectory(result);
    return result;
}

fn openRegistryLock(directory: std.fs.Dir) !std.fs.File {
    const fd = std.posix.openat(directory.fd, "registry.lock", .{
        .ACCMODE = .RDWR,
        .CREAT = true,
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0o600) catch |err| switch (err) {
        error.SymLinkLoop => return error.LockSubstitution,
        else => return err,
    };
    var file: std.fs.File = .{ .handle = fd };
    errdefer file.close();
    try file.chmod(0o600);
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return error.LockSubstitution;
    return file;
}

fn preflightSocketPath(allocator: std.mem.Allocator, canonical_root: []const u8) !void {
    const longest_component: [46]u8 = @splat('x');
    const socket_path = try std.fs.path.join(allocator, &.{
        canonical_root,
        runtime_relative_path,
        &longest_component,
        socket_relative_path,
    });
    defer allocator.free(socket_path);
    _ = std.net.Address.initUnix(socket_path) catch |err| switch (err) {
        error.NameTooLong => return error.SocketPathTooLong,
        else => return err,
    };
}

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    canonicalRoot: []u8,
    directory: std.fs.Dir,
    lockFile: std.fs.File,

    pub fn open(allocator: std.mem.Allocator, root: []const u8) !Runtime {
        const canonical = try std.fs.cwd().realpathAlloc(allocator, root);
        errdefer allocator.free(canonical);
        var root_directory = try std.fs.cwd().openDir(canonical, .{ .no_follow = true });
        defer root_directory.close();
        try requireOwnedRoot(root_directory);
        try preflightSocketPath(allocator, canonical);
        var directory = try openPrivateDirectory(root_directory, runtime_relative_path);
        errdefer directory.close();
        const lock_file = try openRegistryLock(directory);
        return .{
            .allocator = allocator,
            .canonicalRoot = canonical,
            .directory = directory,
            .lockFile = lock_file,
        };
    }

    pub fn deinit(self: *Runtime) void {
        self.lockFile.close();
        self.directory.close();
        self.allocator.free(self.canonicalRoot);
        self.* = undefined;
    }

    fn openSessionDirectory(self: *Runtime, session: SessionRef) !std.fs.Dir {
        const name = sessionDirectoryName(session);
        var result = self.directory.openDir(&name, .{ .no_follow = true, .iterate = true }) catch |err| switch (err) {
            error.SymLinkLoop, error.NotDir => return error.DirectorySubstitution,
            else => return err,
        };
        errdefer result.close();
        try requireOwnedDirectory(result);
        return result;
    }

    fn sessionPath(self: *Runtime, allocator: std.mem.Allocator, session: SessionRef, leaf: []const u8) ![]u8 {
        const name = sessionDirectoryName(session);
        return std.fs.path.join(allocator, &.{ self.canonicalRoot, runtime_relative_path, &name, leaf });
    }
};

const DiskProcessIdentity = struct { processId: i32, startToken: []const u8 };
const DiskWindowSize = struct { columns: u32, rows: u32, widthPixels: u32, heightPixels: u32 };
const DiskOutputEvidence = struct { retainedStart: u64, retainedEndExclusive: u64, closed: bool };
const DiskCheckpointEvidence = struct {
    retained: u32,
    newestThroughEventSequence: ?u64,
    newestThroughOutputOffset: ?u64,
};
const DiskExitStatus = struct { code: ?i32, signal: ?i32, observedAt: []const u8 };
const DiskReapEvidence = struct {
    authority: []const u8,
    reaped: bool,
    status: ?DiskExitStatus,
    completeness: []const u8,
};
const DiskRecord = struct {
    schemaVersion: u8,
    session: struct { key: []const u8, incarnation: []const u8 },
    createIdempotencyKey: []const u8,
    requestSha256: []const u8,
    createResultJson: ?[]const u8,
    terminationIdempotencyKey: ?[]const u8,
    terminationRequestSha256: ?[32]u8,
    terminationResultJson: ?[]const u8,
    lifecycle: []const u8,
    host: ?DiskProcessIdentity,
    child: ?DiskProcessIdentity,
    childSessionId: ?i32,
    childProcessGroupId: ?i32,
    foregroundProcessGroupId: ?i32,
    terminalIdentity: ?[]const u8,
    sessionLeader: ?bool,
    controllingTerminal: ?bool,
    standardStreamsShareTerminal: ?bool,
    initialProfileAppliedBeforeExec: ?bool,
    initialWindowAppliedBeforeExec: ?bool,
    window: DiskWindowSize,
    windowRevision: u64,
    eventSequenceHighWater: ?u64,
    output: DiskOutputEvidence,
    checkpoints: DiskCheckpointEvidence,
    exit: ?DiskExitStatus,
    reap: ?DiskReapEvidence,
    socketRelativePath: []const u8,
};

fn diskExit(exit: ExitStatus) DiskExitStatus {
    return .{ .code = exit.code, .signal = exit.signal, .observedAt = exit.observedAt };
}

fn diskReap(reap: ReapEvidence) DiskReapEvidence {
    return .{
        .authority = @tagName(reap.authority),
        .reaped = reap.reaped,
        .status = if (reap.status) |status| diskExit(status) else null,
        .completeness = @tagName(reap.completeness),
    };
}

fn diskRecord(record: Record, digest_hex: *const [64]u8) DiskRecord {
    return .{
        .schemaVersion = schema_version,
        .session = .{ .key = record.session.key, .incarnation = record.session.incarnation },
        .createIdempotencyKey = record.createIdempotencyKey,
        .requestSha256 = digest_hex,
        .createResultJson = record.createResultJson,
        .terminationIdempotencyKey = record.terminationIdempotencyKey,
        .terminationRequestSha256 = record.terminationRequestSha256,
        .terminationResultJson = record.terminationResultJson,
        .lifecycle = @tagName(record.lifecycle),
        .host = if (record.host) |identity| .{
            .processId = identity.processId,
            .startToken = identity.startToken,
        } else null,
        .child = if (record.child) |identity| .{
            .processId = identity.processId,
            .startToken = identity.startToken,
        } else null,
        .childSessionId = record.childSessionId,
        .childProcessGroupId = record.childProcessGroupId,
        .foregroundProcessGroupId = record.foregroundProcessGroupId,
        .terminalIdentity = record.terminalIdentity,
        .sessionLeader = record.sessionLeader,
        .controllingTerminal = record.controllingTerminal,
        .standardStreamsShareTerminal = record.standardStreamsShareTerminal,
        .initialProfileAppliedBeforeExec = record.initialProfileAppliedBeforeExec,
        .initialWindowAppliedBeforeExec = record.initialWindowAppliedBeforeExec,
        .window = .{
            .columns = record.window.columns,
            .rows = record.window.rows,
            .widthPixels = record.window.widthPixels,
            .heightPixels = record.window.heightPixels,
        },
        .windowRevision = record.windowRevision,
        .eventSequenceHighWater = record.eventSequenceHighWater,
        .output = .{
            .retainedStart = record.output.retainedStart,
            .retainedEndExclusive = record.output.retainedEndExclusive,
            .closed = record.output.closed,
        },
        .checkpoints = .{
            .retained = record.checkpoints.retained,
            .newestThroughEventSequence = record.checkpoints.newestThroughEventSequence,
            .newestThroughOutputOffset = record.checkpoints.newestThroughOutputOffset,
        },
        .exit = if (record.exit) |exit| diskExit(exit) else null,
        .reap = if (record.reap) |reap| diskReap(reap) else null,
        .socketRelativePath = socket_relative_path,
    };
}

fn writeRecordAtomic(allocator: std.mem.Allocator, directory: std.fs.Dir, record: Record) !void {
    const digest_hex = std.fmt.bytesToHex(record.requestSha256, .lower);
    const json = try std.json.Stringify.valueAlloc(allocator, diskRecord(record, &digest_hex), .{});
    defer allocator.free(json);
    var temporary_storage: [48]u8 = undefined;
    const temporary = try std.fmt.bufPrint(&temporary_storage, "record.json.new.{x}", .{
        std.crypto.random.int(u64),
    });
    var file = try directory.createFile(temporary, .{
        .mode = 0o600,
        .truncate = true,
        .exclusive = true,
    });
    errdefer directory.deleteFile(temporary) catch {};
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(json);
    try file.sync();
    try directory.rename(temporary, record_relative_path);
    try std.posix.fsync(directory.fd);
}

fn createControlSecret(directory: std.fs.Dir) !void {
    var secret: [32]u8 = undefined;
    defer std.crypto.secureZero(u8, &secret);
    std.crypto.random.bytes(&secret);
    var file = try directory.createFile(control_relative_path, .{
        .mode = 0o600,
        .exclusive = true,
    });
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(&secret);
    try file.sync();
    try std.posix.fsync(directory.fd);
}

fn readOwnedFileAt(allocator: std.mem.Allocator, directory: std.fs.Dir, name: []const u8, max: usize) ![]u8 {
    const fd = try std.posix.openat(directory.fd, name, .{ .NOFOLLOW = true, .CLOEXEC = true }, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return error.FileSubstitution;
    return file.readToEndAlloc(allocator, max);
}

fn copyString(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    return allocator.dupe(u8, value);
}

const OwnedSessionRef = struct {
    allocator: std.mem.Allocator,
    value: SessionRef,

    fn init(allocator: std.mem.Allocator, source: SessionRef) !OwnedSessionRef {
        const key = try allocator.dupe(u8, source.key);
        errdefer allocator.free(key);
        return .{
            .allocator = allocator,
            .value = .{
                .key = key,
                .incarnation = try allocator.dupe(u8, source.incarnation),
            },
        };
    }

    fn deinit(self: *OwnedSessionRef) void {
        self.allocator.free(self.value.incarnation);
        self.allocator.free(self.value.key);
        self.* = undefined;
    }
};

const OwnedHostRegistration = struct {
    allocator: std.mem.Allocator,
    value: HostRegistration,

    fn init(allocator: std.mem.Allocator, source: HostRegistration) !OwnedHostRegistration {
        const host_token = try allocator.dupe(u8, source.host.startToken);
        errdefer allocator.free(host_token);
        const child_token = try allocator.dupe(u8, source.child.startToken);
        errdefer allocator.free(child_token);
        const terminal_identity = try allocator.dupe(u8, source.terminalIdentity);
        return .{
            .allocator = allocator,
            .value = .{
                .host = .{ .processId = source.host.processId, .startToken = host_token },
                .child = .{ .processId = source.child.processId, .startToken = child_token },
                .childSessionId = source.childSessionId,
                .childProcessGroupId = source.childProcessGroupId,
                .foregroundProcessGroupId = source.foregroundProcessGroupId,
                .terminalIdentity = terminal_identity,
                .sessionLeader = source.sessionLeader,
                .controllingTerminal = source.controllingTerminal,
                .standardStreamsShareTerminal = source.standardStreamsShareTerminal,
                .initialProfileAppliedBeforeExec = source.initialProfileAppliedBeforeExec,
                .initialWindowAppliedBeforeExec = source.initialWindowAppliedBeforeExec,
                .window = source.window,
            },
        };
    }

    fn deinit(self: *OwnedHostRegistration) void {
        self.allocator.free(self.value.terminalIdentity);
        self.allocator.free(self.value.child.startToken);
        self.allocator.free(self.value.host.startToken);
        self.* = undefined;
    }
};

const OwnedRecordUpdate = struct {
    allocator: std.mem.Allocator,
    value: RecordUpdate,
    exitObservedAt: ?[]const u8 = null,
    reapObservedAt: ?[]const u8 = null,

    fn init(allocator: std.mem.Allocator, source: RecordUpdate) !OwnedRecordUpdate {
        var result: OwnedRecordUpdate = .{ .allocator = allocator, .value = source };
        errdefer result.deinit();
        if (source.exit) |source_exit| {
            result.exitObservedAt = try allocator.dupe(u8, source_exit.observedAt);
            var owned_exit = source_exit;
            owned_exit.observedAt = result.exitObservedAt.?;
            result.value.exit = owned_exit;
        }
        if (source.reap) |source_reap| {
            var owned_reap = source_reap;
            if (source_reap.status) |source_status| {
                result.reapObservedAt = try allocator.dupe(u8, source_status.observedAt);
                var owned_status = source_status;
                owned_status.observedAt = result.reapObservedAt.?;
                owned_reap.status = owned_status;
            }
            result.value.reap = owned_reap;
        }
        return result;
    }

    fn deinit(self: *OwnedRecordUpdate) void {
        if (self.reapObservedAt) |value| self.allocator.free(value);
        if (self.exitObservedAt) |value| self.allocator.free(value);
        self.* = undefined;
    }
};

fn parseCompleteness(value: []const u8) !@FieldType(ReapEvidence, "completeness") {
    return std.meta.stringToEnum(@FieldType(ReapEvidence, "completeness"), value) orelse
        error.InvalidRecord;
}

fn copyExit(allocator: std.mem.Allocator, value: DiskExitStatus) !ExitStatus {
    return .{
        .code = value.code,
        .signal = value.signal,
        .observedAt = try copyString(allocator, value.observedAt),
    };
}

fn recordFromDisk(allocator: std.mem.Allocator, value: DiskRecord) !Record {
    if (value.schemaVersion != schema_version or
        !std.mem.eql(u8, value.socketRelativePath, socket_relative_path) or
        value.session.key.len == 0 or value.session.incarnation.len == 0 or
        value.createIdempotencyKey.len == 0 or value.requestSha256.len != 64)
        return error.InvalidRecord;
    var digest: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&digest, value.requestSha256) catch return error.InvalidRecord;
    const lifecycle = std.meta.stringToEnum(Lifecycle, value.lifecycle) orelse
        return error.InvalidRecord;
    const session: SessionRef = .{
        .key = try copyString(allocator, value.session.key),
        .incarnation = try copyString(allocator, value.session.incarnation),
    };
    const record: Record = .{
        .session = session,
        .createIdempotencyKey = try copyString(allocator, value.createIdempotencyKey),
        .requestSha256 = digest,
        .createResultJson = if (value.createResultJson) |bytes| try copyString(allocator, bytes) else null,
        .terminationIdempotencyKey = if (value.terminationIdempotencyKey) |key| try copyString(allocator, key) else null,
        .terminationRequestSha256 = value.terminationRequestSha256,
        .terminationResultJson = if (value.terminationResultJson) |bytes| try copyString(allocator, bytes) else null,
        .lifecycle = lifecycle,
        .host = if (value.host) |identity| .{
            .processId = identity.processId,
            .startToken = try copyString(allocator, identity.startToken),
        } else null,
        .child = if (value.child) |identity| .{
            .processId = identity.processId,
            .startToken = try copyString(allocator, identity.startToken),
        } else null,
        .childSessionId = value.childSessionId,
        .childProcessGroupId = value.childProcessGroupId,
        .foregroundProcessGroupId = value.foregroundProcessGroupId,
        .terminalIdentity = if (value.terminalIdentity) |identity| try copyString(allocator, identity) else null,
        .sessionLeader = value.sessionLeader,
        .controllingTerminal = value.controllingTerminal,
        .standardStreamsShareTerminal = value.standardStreamsShareTerminal,
        .initialProfileAppliedBeforeExec = value.initialProfileAppliedBeforeExec,
        .initialWindowAppliedBeforeExec = value.initialWindowAppliedBeforeExec,
        .window = .{
            .columns = value.window.columns,
            .rows = value.window.rows,
            .widthPixels = value.window.widthPixels,
            .heightPixels = value.window.heightPixels,
        },
        .windowRevision = value.windowRevision,
        .eventSequenceHighWater = value.eventSequenceHighWater,
        .output = .{
            .retainedStart = value.output.retainedStart,
            .retainedEndExclusive = value.output.retainedEndExclusive,
            .closed = value.output.closed,
        },
        .checkpoints = .{
            .retained = value.checkpoints.retained,
            .newestThroughEventSequence = value.checkpoints.newestThroughEventSequence,
            .newestThroughOutputOffset = value.checkpoints.newestThroughOutputOffset,
        },
        .exit = if (value.exit) |exit| try copyExit(allocator, exit) else null,
        .reap = if (value.reap) |reap| .{
            .authority = std.meta.stringToEnum(@FieldType(ReapEvidence, "authority"), reap.authority) orelse
                return error.InvalidRecord,
            .reaped = reap.reaped,
            .status = if (reap.status) |status| try copyExit(allocator, status) else null,
            .completeness = try parseCompleteness(reap.completeness),
        } else null,
    };
    if (record.lifecycle == .reserved and (record.host != null or record.child != null))
        return error.InvalidRecord;
    if ((record.terminationIdempotencyKey == null) !=
        (record.terminationRequestSha256 == null) or
        (record.terminationResultJson != null and record.terminationIdempotencyKey == null))
        return error.InvalidRecord;
    return record;
}

pub const Registry = struct {
    allocator: std.mem.Allocator,
    runtime: *Runtime,
    arena: std.heap.ArenaAllocator,
    entries: std.ArrayList(Record) = .{},
    recoveryComplete: bool = true,

    pub fn open(allocator: std.mem.Allocator, runtime: *Runtime) !Registry {
        var result: Registry = .{
            .allocator = allocator,
            .runtime = runtime,
            .arena = std.heap.ArenaAllocator.init(allocator),
        };
        errdefer result.deinit();
        try result.recover();
        return result;
    }

    pub fn deinit(self: *Registry) void {
        self.entries.deinit(self.allocator);
        self.arena.deinit();
        self.* = undefined;
    }

    pub fn recover(self: *Registry) !void {
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
    }

    fn recoverUnlocked(self: *Registry) !void {
        var next_arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer next_arena.deinit();
        var next_entries: std.ArrayList(Record) = .{};
        errdefer next_entries.deinit(self.allocator);
        var next_recovery_complete = true;
        var iterator = self.runtime.directory.iterate();
        while (try iterator.next()) |entry| {
            if (entry.kind == .file and std.mem.eql(u8, entry.name, "registry.lock"))
                continue;
            if (entry.kind != .directory or entry.name.len != 46 or
                !std.mem.startsWith(u8, entry.name, "nh-"))
            {
                next_recovery_complete = false;
                continue;
            }
            var directory = self.runtime.directory.openDir(entry.name, .{
                .no_follow = true,
                .iterate = true,
            }) catch {
                next_recovery_complete = false;
                continue;
            };
            defer directory.close();
            requireOwnedDirectory(directory) catch {
                next_recovery_complete = false;
                continue;
            };
            const json = readOwnedFileAt(
                next_arena.allocator(),
                directory,
                record_relative_path,
                operation_payload_max_bytes,
            ) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => {
                    next_recovery_complete = false;
                    continue;
                },
            };
            const disk = std.json.parseFromSliceLeaky(
                DiskRecord,
                next_arena.allocator(),
                json,
                .{ .ignore_unknown_fields = false },
            ) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => {
                    next_recovery_complete = false;
                    continue;
                },
            };
            const record = recordFromDisk(next_arena.allocator(), disk) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => {
                    next_recovery_complete = false;
                    continue;
                },
            };
            const expected = sessionDirectoryName(record.session);
            var duplicate = false;
            for (next_entries.items) |existing| {
                if (existing.session.eql(record.session)) {
                    duplicate = true;
                    break;
                }
            }
            if (!std.mem.eql(u8, &expected, entry.name) or duplicate) {
                next_recovery_complete = false;
                continue;
            }
            try next_entries.append(self.allocator, record);
        }

        var old_arena = self.arena;
        var old_entries = self.entries;
        self.arena = next_arena;
        self.entries = next_entries;
        self.recoveryComplete = next_recovery_complete;
        old_entries.deinit(self.allocator);
        old_arena.deinit();
    }

    /// The returned record borrows registry storage until the next mutation
    /// or explicit recovery.
    pub fn get(self: *Registry, session: SessionRef) ?Record {
        for (self.entries.items) |record| if (record.session.eql(session)) return record;
        return null;
    }

    /// The returned slice and records borrow registry storage until the next
    /// mutation or explicit recovery.
    pub fn list(self: *const Registry) []const Record {
        return self.entries.items;
    }

    fn indexOf(self: *Registry, session: SessionRef) ?usize {
        for (self.entries.items, 0..) |record, index| {
            if (record.session.eql(session)) return index;
        }
        return null;
    }

    fn persist(self: *Registry, record: Record) !void {
        var directory = try self.runtime.openSessionDirectory(record.session);
        defer directory.close();
        try writeRecordAtomic(self.allocator, directory, record);
    }

    pub fn reserve(
        self: *Registry,
        key: []const u8,
        idempotency_key: []const u8,
        request_sha256: [32]u8,
        initial_window: WindowSize,
    ) !ReserveResult {
        if (key.len == 0 or idempotency_key.len == 0) return error.InvalidCreateRequest;
        const owned_key = try self.allocator.dupe(u8, key);
        defer self.allocator.free(owned_key);
        const owned_idempotency_key = try self.allocator.dupe(u8, idempotency_key);
        defer self.allocator.free(owned_idempotency_key);
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        for (self.entries.items) |record| {
            if (!std.mem.eql(u8, record.session.key, owned_key)) continue;
            if (!std.mem.eql(u8, record.createIdempotencyKey, owned_idempotency_key)) continue;
            if (!std.mem.eql(u8, &record.requestSha256, &request_sha256))
                return error.CreateConflict;
            return .{ .existing = record };
        }
        for (self.entries.items) |record| {
            if (!std.mem.eql(u8, record.session.key, owned_key)) continue;
            switch (record.lifecycle) {
                .reserved, .live, .unknown => return error.CreateConflict,
                .create_failed, .exited, .reaped => {},
            }
        }

        var incarnation_bytes: [16]u8 = undefined;
        std.crypto.random.bytes(&incarnation_bytes);
        const incarnation_hex = std.fmt.bytesToHex(incarnation_bytes, .lower);
        const a = self.arena.allocator();
        const session: SessionRef = .{
            .key = try copyString(a, owned_key),
            .incarnation = try copyString(a, &incarnation_hex),
        };
        const record: Record = .{
            .session = session,
            .createIdempotencyKey = try copyString(a, owned_idempotency_key),
            .requestSha256 = request_sha256,
            .window = initial_window,
        };
        const directory_name = sessionDirectoryName(session);
        self.runtime.directory.makeDir(&directory_name) catch |err| switch (err) {
            error.PathAlreadyExists => return error.IncarnationCollision,
            else => return err,
        };
        var directory = try self.runtime.openSessionDirectory(session);
        var keep_directory = false;
        defer directory.close();
        errdefer if (!keep_directory) self.runtime.directory.deleteTree(&directory_name) catch {};
        try createControlSecret(directory);
        try writeRecordAtomic(self.allocator, directory, record);
        try self.entries.append(self.allocator, record);
        keep_directory = true;
        return .{ .reserved = record };
    }

    pub fn register(self: *Registry, session: SessionRef, registration: HostRegistration) !Record {
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        var owned_registration = try OwnedHostRegistration.init(self.allocator, registration);
        defer owned_registration.deinit();
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        var record = self.entries.items[index];
        if (record.lifecycle != .reserved and record.lifecycle != .unknown)
            return error.InvalidLifecycleTransition;
        const a = self.arena.allocator();
        record.lifecycle = .live;
        record.host = .{
            .processId = owned_registration.value.host.processId,
            .startToken = try copyString(a, owned_registration.value.host.startToken),
        };
        record.child = .{
            .processId = owned_registration.value.child.processId,
            .startToken = try copyString(a, owned_registration.value.child.startToken),
        };
        record.childSessionId = owned_registration.value.childSessionId;
        record.childProcessGroupId = owned_registration.value.childProcessGroupId;
        record.foregroundProcessGroupId = owned_registration.value.foregroundProcessGroupId;
        record.terminalIdentity = try copyString(a, owned_registration.value.terminalIdentity);
        record.sessionLeader = owned_registration.value.sessionLeader;
        record.controllingTerminal = owned_registration.value.controllingTerminal;
        record.standardStreamsShareTerminal = owned_registration.value.standardStreamsShareTerminal;
        record.initialProfileAppliedBeforeExec = owned_registration.value.initialProfileAppliedBeforeExec;
        record.initialWindowAppliedBeforeExec = owned_registration.value.initialWindowAppliedBeforeExec;
        record.window = owned_registration.value.window;
        try self.persist(record);
        self.entries.items[index] = record;
        return record;
    }

    pub fn commitCreate(self: *Registry, session: SessionRef, result_json: []const u8) !Record {
        if (result_json.len == 0 or result_json.len > operation_payload_max_bytes)
            return error.InvalidCreateResult;
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        const owned_result = try self.allocator.dupe(u8, result_json);
        defer self.allocator.free(owned_result);
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        var record = self.entries.items[index];
        if (record.createResultJson) |existing| {
            if (!std.mem.eql(u8, existing, owned_result)) return error.CreateResultConflict;
            return record;
        }
        record.createResultJson = try copyString(self.arena.allocator(), owned_result);
        if (record.lifecycle == .reserved) record.lifecycle = .create_failed;
        try self.persist(record);
        self.entries.items[index] = record;
        return record;
    }

    pub fn update(self: *Registry, session: SessionRef, patch: RecordUpdate) !Record {
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        var owned_patch = try OwnedRecordUpdate.init(self.allocator, patch);
        defer owned_patch.deinit();
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        var record = self.entries.items[index];
        if (owned_patch.value.lifecycle) |value| record.lifecycle = value;
        if (owned_patch.value.window) |value| record.window = value;
        if (owned_patch.value.windowRevision) |value| {
            if (value < record.windowRevision) return error.StaleRevision;
            record.windowRevision = value;
        }
        if (owned_patch.value.eventSequenceHighWater) |value| {
            if (record.eventSequenceHighWater) |current| {
                if (value < current) return error.StaleEventSequence;
            }
            record.eventSequenceHighWater = value;
        }
        if (owned_patch.value.output) |value| {
            if (value.retainedStart > value.retainedEndExclusive or
                value.retainedEndExclusive < record.output.retainedEndExclusive)
                return error.StaleOutputEvidence;
            record.output = value;
        }
        if (owned_patch.value.checkpoints) |value| {
            if ((value.newestThroughEventSequence == null) !=
                (value.newestThroughOutputOffset == null))
                return error.InvalidCheckpointEvidence;
            if (value.newestThroughEventSequence) |sequence| {
                const high_water = record.eventSequenceHighWater orelse
                    return error.InvalidCheckpointEvidence;
                if (sequence > high_water) return error.InvalidCheckpointEvidence;
            }
            if (value.newestThroughOutputOffset) |offset| {
                if (offset > record.output.retainedEndExclusive)
                    return error.InvalidCheckpointEvidence;
            }
            record.checkpoints = value;
        }
        const a = self.arena.allocator();
        if (owned_patch.value.exit) |value| record.exit = try copyExit(a, diskExit(value));
        if (owned_patch.value.reap) |value| {
            record.reap = .{
                .authority = value.authority,
                .reaped = value.reaped,
                .status = if (value.status) |status| try copyExit(a, diskExit(status)) else null,
                .completeness = value.completeness,
            };
        }
        try self.persist(record);
        self.entries.items[index] = record;
        return record;
    }

    pub fn remove(self: *Registry, session: SessionRef) !void {
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        switch (self.entries.items[index].lifecycle) {
            .create_failed, .exited, .reaped => {},
            .reserved, .live, .unknown => return error.SessionStillActive,
        }
        const name = sessionDirectoryName(owned_session.value);
        try self.runtime.directory.deleteTree(&name);
        _ = self.entries.orderedRemove(index);
    }

    pub fn connect(self: *Registry, session: SessionRef) !Client {
        const record = self.get(session) orelse return error.SessionNotFound;
        if (record.host == null) return error.HostNotRegistered;
        return Client.open(self.allocator, self.runtime, record);
    }

    pub fn reserveTermination(
        self: *Registry,
        session: SessionRef,
        idempotency_key: []const u8,
        request_sha256: [32]u8,
    ) !TerminationReserveResult {
        if (idempotency_key.len == 0) return error.InvalidTerminationRequest;
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        const owned_idempotency_key = try self.allocator.dupe(u8, idempotency_key);
        defer self.allocator.free(owned_idempotency_key);
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        var record = self.entries.items[index];
        if (record.terminationIdempotencyKey) |existing_key| {
            const existing_digest = record.terminationRequestSha256 orelse
                return error.InvalidRecord;
            if (!std.mem.eql(u8, existing_key, owned_idempotency_key) or
                !std.mem.eql(u8, &existing_digest, &request_sha256))
                return error.TerminationConflict;
            if (record.terminationResultJson) |result| return .{ .replay = result };
            return .pending;
        }
        record.terminationIdempotencyKey = try copyString(
            self.arena.allocator(),
            owned_idempotency_key,
        );
        record.terminationRequestSha256 = request_sha256;
        try self.persist(record);
        self.entries.items[index] = record;
        return .reserved;
    }

    pub fn commitTermination(
        self: *Registry,
        session: SessionRef,
        idempotency_key: []const u8,
        request_sha256: [32]u8,
        result_json: []const u8,
    ) ![]const u8 {
        if (result_json.len == 0 or result_json.len > operation_payload_max_bytes)
            return error.InvalidTerminationResult;
        var owned_session = try OwnedSessionRef.init(self.allocator, session);
        defer owned_session.deinit();
        const owned_idempotency_key = try self.allocator.dupe(u8, idempotency_key);
        defer self.allocator.free(owned_idempotency_key);
        const owned_result = try self.allocator.dupe(u8, result_json);
        defer self.allocator.free(owned_result);
        try self.runtime.lockFile.lock(.exclusive);
        defer self.runtime.lockFile.unlock();
        try self.recoverUnlocked();
        const index = self.indexOf(owned_session.value) orelse return error.SessionNotFound;
        var record = self.entries.items[index];
        const existing_key = record.terminationIdempotencyKey orelse
            return error.TerminationNotReserved;
        const existing_digest = record.terminationRequestSha256 orelse
            return error.InvalidRecord;
        if (!std.mem.eql(u8, existing_key, owned_idempotency_key) or
            !std.mem.eql(u8, &existing_digest, &request_sha256))
            return error.TerminationConflict;
        if (record.terminationResultJson) |existing| {
            if (!std.mem.eql(u8, existing, owned_result))
                return error.TerminationResultConflict;
            return existing;
        }
        const stored = try copyString(self.arena.allocator(), owned_result);
        record.terminationResultJson = stored;
        try self.persist(record);
        self.entries.items[index] = record;
        return stored;
    }
};

pub const Operation = enum(u8) {
    submitInput = 1,
    resize = 2,
    attach = 3,
    inspect = 4,
    pollExit = 5,
    reap = 6,
    terminate = 7,
};

pub const OperationRequest = struct {
    session: SessionRef,
    operation: Operation,
    idempotencyKey: []const u8,
    payload: []const u8,
};

pub const OperationResponse = struct {
    accepted: bool = true,
    payload: []const u8,
};

pub const OperationHandler = struct {
    context: *anyopaque,
    callFn: *const fn (*anyopaque, OperationRequest) anyerror!OperationResponse,

    pub fn call(self: OperationHandler, request: OperationRequest) !OperationResponse {
        return self.callFn(self.context, request);
    }
};

const SocketEvidence = struct {
    device: u64,
    inode: u64,
    ownerUid: u32,
    mode: u16,
};

fn socketEvidenceAt(directory: std.fs.Dir) !SocketEvidence {
    const stat = try std.posix.fstatat(
        directory.fd,
        socket_relative_path,
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
        stat.mode & 0o777 != 0o600)
        return error.SocketSubstitution;
    return .{
        .device = @intCast(stat.dev),
        .inode = @intCast(stat.ino),
        .ownerUid = @intCast(stat.uid),
        .mode = @intCast(stat.mode & 0o777),
    };
}

fn readControlSecret(directory: std.fs.Dir) ![32]u8 {
    const fd = try std.posix.openat(directory.fd, control_relative_path, .{
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return error.ControlSubstitution;
    var result: [32]u8 = undefined;
    if (try file.readAll(&result) != result.len) return error.InvalidControlSecret;
    var extra: [1]u8 = undefined;
    if (try file.read(&extra) != 0) return error.InvalidControlSecret;
    return result;
}

fn readExact(file: std.fs.File, bytes: []u8) !void {
    if (try file.readAll(bytes) != bytes.len) return error.TruncatedOperationFrame;
}

fn putU32(output: *[4]u8, value: usize) !void {
    if (value > std.math.maxInt(u32)) return error.OperationFrameTooLarge;
    std.mem.writeInt(u32, output, @intCast(value), .big);
}

fn readU32(input: *const [4]u8) usize {
    return std.mem.readInt(u32, input, .big);
}

const request_magic = "NHOP";
const response_magic = "NHRS";
const request_header_bytes = 54;
const response_header_bytes = 9;

pub const ClientResponse = struct {
    allocator: std.mem.Allocator,
    accepted: bool,
    payload: []u8,

    pub fn deinit(self: *ClientResponse) void {
        self.allocator.free(self.payload);
        self.* = undefined;
    }
};

pub const Client = struct {
    allocator: std.mem.Allocator,
    session: SessionRef,
    socketPath: []u8,
    secret: [32]u8,
    directory: std.fs.Dir,

    fn open(allocator: std.mem.Allocator, runtime: *Runtime, record: Record) !Client {
        var owned_session = try OwnedSessionRef.init(allocator, record.session);
        errdefer owned_session.deinit();
        var directory = try runtime.openSessionDirectory(record.session);
        errdefer directory.close();
        const secret = try readControlSecret(directory);
        const socket_path = try runtime.sessionPath(allocator, record.session, socket_relative_path);
        errdefer allocator.free(socket_path);
        return .{
            .allocator = allocator,
            .session = owned_session.value,
            .socketPath = socket_path,
            .secret = secret,
            .directory = directory,
        };
    }

    pub fn deinit(self: *Client) void {
        self.directory.close();
        self.allocator.free(self.socketPath);
        self.allocator.free(self.session.incarnation);
        self.allocator.free(self.session.key);
        std.crypto.secureZero(u8, &self.secret);
        self.* = undefined;
    }

    pub fn call(
        self: *Client,
        allocator: std.mem.Allocator,
        operation: Operation,
        idempotency_key: []const u8,
        payload: []const u8,
    ) !ClientResponse {
        if (self.session.key.len > operation_payload_max_bytes or
            self.session.incarnation.len > operation_payload_max_bytes or
            idempotency_key.len > operation_payload_max_bytes or
            payload.len > operation_payload_max_bytes)
            return error.OperationFrameTooLarge;
        const before = try socketEvidenceAt(self.directory);
        const stream = try std.net.connectUnixSocket(self.socketPath);
        defer stream.close();
        const after = try socketEvidenceAt(self.directory);
        if (!std.meta.eql(before, after)) return error.SocketSubstitution;
        const file: std.fs.File = .{ .handle = stream.handle };
        var header: [request_header_bytes]u8 = @splat(0);
        @memcpy(header[0..4], request_magic);
        header[4] = schema_version;
        header[5] = @intFromEnum(operation);
        @memcpy(header[6..38], &self.secret);
        try putU32(header[38..42], self.session.key.len);
        try putU32(header[42..46], self.session.incarnation.len);
        try putU32(header[46..50], idempotency_key.len);
        try putU32(header[50..54], payload.len);
        try file.writeAll(&header);
        try file.writeAll(self.session.key);
        try file.writeAll(self.session.incarnation);
        try file.writeAll(idempotency_key);
        try file.writeAll(payload);

        var response_header: [response_header_bytes]u8 = undefined;
        try readExact(file, &response_header);
        if (!std.mem.eql(u8, response_header[0..4], response_magic) or
            response_header[4] > 1)
            return error.InvalidOperationResponse;
        const response_length = readU32(response_header[5..9]);
        if (response_length > operation_payload_max_bytes)
            return error.OperationFrameTooLarge;
        const response = try allocator.alloc(u8, response_length);
        errdefer allocator.free(response);
        try readExact(file, response);
        return .{
            .allocator = allocator,
            .accepted = response_header[4] == 0,
            .payload = response,
        };
    }
};

pub const HostEndpoint = struct {
    allocator: std.mem.Allocator,
    session: SessionRef,
    directory: std.fs.Dir,
    socketPath: []u8,
    server: std.net.Server,
    socketEvidence: SocketEvidence,
    secret: [32]u8,

    pub fn open(allocator: std.mem.Allocator, runtime: *Runtime, session: SessionRef) !HostEndpoint {
        var owned_session = try OwnedSessionRef.init(allocator, session);
        errdefer owned_session.deinit();
        var directory = try runtime.openSessionDirectory(session);
        errdefer directory.close();
        const secret = try readControlSecret(directory);
        if (socketEvidenceAt(directory)) |_| {
            return error.HostEndpointExists;
        } else |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        }
        const socket_path = try runtime.sessionPath(allocator, session, socket_relative_path);
        errdefer allocator.free(socket_path);
        const address = try std.net.Address.initUnix(socket_path);
        var server = try address.listen(.{});
        errdefer server.deinit();
        const socket_path_z = try allocator.dupeZ(u8, socket_path);
        defer allocator.free(socket_path_z);
        if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;
        return .{
            .allocator = allocator,
            .session = owned_session.value,
            .directory = directory,
            .socketPath = socket_path,
            .server = server,
            .socketEvidence = try socketEvidenceAt(directory),
            .secret = secret,
        };
    }

    pub fn deinit(self: *HostEndpoint) void {
        self.server.deinit();
        if (socketEvidenceAt(self.directory)) |observed| {
            if (std.meta.eql(observed, self.socketEvidence))
                self.directory.deleteFile(socket_relative_path) catch {};
        } else |_| {}
        self.directory.close();
        self.allocator.free(self.socketPath);
        self.allocator.free(self.session.incarnation);
        self.allocator.free(self.session.key);
        std.crypto.secureZero(u8, &self.secret);
        self.* = undefined;
    }

    pub fn serveOne(self: *HostEndpoint, handler: OperationHandler) !void {
        if (!std.meta.eql(self.socketEvidence, try socketEvidenceAt(self.directory)))
            return error.SocketSubstitution;
        const connection = try self.server.accept();
        defer connection.stream.close();
        if (!std.meta.eql(self.socketEvidence, try socketEvidenceAt(self.directory)))
            return error.SocketSubstitution;
        const file: std.fs.File = .{ .handle = connection.stream.handle };
        var header: [request_header_bytes]u8 = undefined;
        try readExact(file, &header);
        if (!std.mem.eql(u8, header[0..4], request_magic) or header[4] != schema_version)
            return error.InvalidOperationRequest;
        const operation = std.meta.intToEnum(Operation, header[5]) catch
            return error.InvalidOperationRequest;
        if (!std.crypto.timing_safe.eql([32]u8, self.secret, header[6..38].*))
            return error.InvalidControlSecret;
        const key_length = readU32(header[38..42]);
        const incarnation_length = readU32(header[42..46]);
        const idempotency_length = readU32(header[46..50]);
        const payload_length = readU32(header[50..54]);
        if (key_length > operation_payload_max_bytes or
            incarnation_length > operation_payload_max_bytes or
            idempotency_length > operation_payload_max_bytes or
            payload_length > operation_payload_max_bytes)
            return error.OperationFrameTooLarge;
        const total = std.math.add(
            usize,
            try std.math.add(usize, key_length, incarnation_length),
            try std.math.add(usize, idempotency_length, payload_length),
        ) catch return error.OperationFrameTooLarge;
        if (total > operation_payload_max_bytes) return error.OperationFrameTooLarge;
        const storage = try self.allocator.alloc(u8, total);
        defer self.allocator.free(storage);
        try readExact(file, storage);
        const key = storage[0..key_length];
        const incarnation = storage[key_length .. key_length + incarnation_length];
        const idempotency_start = key_length + incarnation_length;
        const payload_start = idempotency_start + idempotency_length;
        const session: SessionRef = .{ .key = key, .incarnation = incarnation };
        if (!session.eql(self.session)) return error.StaleSessionRef;
        const response = try handler.call(.{
            .session = session,
            .operation = operation,
            .idempotencyKey = storage[idempotency_start..payload_start],
            .payload = storage[payload_start..],
        });
        if (response.payload.len > operation_payload_max_bytes)
            return error.OperationFrameTooLarge;
        var response_header: [response_header_bytes]u8 = @splat(0);
        @memcpy(response_header[0..4], response_magic);
        response_header[4] = if (response.accepted) 0 else 1;
        try putU32(response_header[5..9], response.payload.len);
        try file.writeAll(&response_header);
        try file.writeAll(response.payload);
    }
};

const LiveProofHandler = struct {
    pty: *pty_host.PtyHost,
    registry: *Registry,
    session: SessionRef,
    terminated: bool = false,

    fn operation(context: *anyopaque, request: OperationRequest) !OperationResponse {
        const self: *LiveProofHandler = @ptrCast(@alignCast(context));
        return switch (request.operation) {
            .inspect => .{ .payload = "live" },
            .submitInput => blk: {
                _ = try self.pty.writeAccept(request.payload);
                try self.pty.writeDrainAll();
                break :blk .{ .payload = "submitted" };
            },
            .attach => blk: {
                var attempts: usize = 0;
                while (attempts < 200) : (attempts += 1) {
                    const output = try self.pty.readAvailable();
                    if (output.bytes.len == 0) {
                        std.Thread.sleep(std.time.ns_per_ms);
                        continue;
                    }
                    _ = try self.registry.update(self.session, .{
                        .eventSequenceHighWater = 2,
                        .output = .{
                            .retainedStart = 0,
                            .retainedEndExclusive = output.through_seq,
                            .closed = false,
                        },
                        .checkpoints = .{
                            .retained = 1,
                            .newestThroughEventSequence = 1,
                            .newestThroughOutputOffset = output.through_seq,
                        },
                    });
                    break :blk .{ .payload = output.bytes };
                }
                return error.OutputUnavailable;
            },
            .resize => .{ .accepted = false, .payload = "not implemented by lifecycle proof" },
            .pollExit => .{ .payload = "running" },
            .reap => .{ .accepted = false, .payload = "process still running" },
            .terminate => blk: {
                var request_digest: [32]u8 = undefined;
                std.crypto.hash.sha2.Sha256.hash(request.payload, &request_digest, .{});
                switch (try self.registry.reserveTermination(
                    self.session,
                    request.idempotencyKey,
                    request_digest,
                )) {
                    .reserved => {},
                    .pending => return error.TerminationPending,
                    .replay => |result| break :blk .{ .payload = result },
                }
                if ((self.registry.get(self.session) orelse return error.SessionNotFound)
                    .terminationResultJson != null)
                    return error.PrematureTerminationResult;
                if (self.pty.pgid <= 0 or c.kill(-self.pty.pgid, c.SIGKILL) != 0)
                    return error.TerminateFailed;
                self.pty.closeMaster();
                const evidence = try self.pty.waitExit(true);
                if (!evidence.reaped or evidence.state != .exited)
                    return error.ReapFailed;
                const status: ExitStatus = .{
                    .code = if (evidence.exit_code) |code| @intCast(code) else null,
                    .signal = evidence.term_signal,
                    .observedAt = "2026-07-18T00:00:00.000Z",
                };
                _ = try self.registry.update(self.session, .{
                    .lifecycle = .reaped,
                    .exit = status,
                    .reap = .{
                        .authority = .@"direct-parent",
                        .reaped = true,
                        .status = status,
                        .completeness = .complete,
                    },
                    .output = .{
                        .retainedStart = 0,
                        .retainedEndExclusive = self.pty.output_seq,
                        .closed = true,
                    },
                });
                const result = try self.registry.commitTermination(
                    self.session,
                    request.idempotencyKey,
                    request_digest,
                    "terminated-and-reaped",
                );
                self.terminated = true;
                break :blk .{ .payload = result };
            },
        };
    }

    fn handler(self: *LiveProofHandler) OperationHandler {
        return .{ .context = self, .callFn = operation };
    }
};

fn runLiveProofHost(root: []const u8, request: CreateRequest, ready_fd: std.posix.fd_t) !void {
    const allocator = std.heap.page_allocator;
    var runtime = try Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try Registry.open(allocator, &runtime);
    defer registry.deinit();

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();
    var direct = DirectHost.init(allocator, &registry, &pty);
    defer direct.deinit();

    // The create path under proof: one frozen request in, one committed
    // CreateResult out, with the terminal opened and owned by this host.
    const created = try direct.host().create(request);
    const running = switch (created.outcome) {
        .running => |value| value,
        else => return error.LiveProofCreateFailed,
    };
    if (!running.jobControl.sessionLeader or
        !running.jobControl.controllingTerminal or
        running.jobControl.completeness != .complete or
        !std.mem.startsWith(u8, running.jobControl.terminalIdentity, "/dev/"))
        return error.JobControlEvidenceUnavailable;
    if (direct.spawns != 1) return error.UnexpectedSpawnCount;
    const session = created.session;

    var endpoint = try HostEndpoint.open(allocator, &runtime, session);
    defer endpoint.deinit();

    const ready: std.fs.File = .{ .handle = ready_fd };
    try ready.writeAll(session.incarnation);
    ready.close();
    var handler: LiveProofHandler = .{
        .pty = &pty,
        .registry = &registry,
        .session = session,
    };
    while (!handler.terminated) try endpoint.serveOne(handler.handler());
}

fn proveSocketPathPreflight(allocator: std.mem.Allocator) !void {
    var base_storage: [64]u8 = undefined;
    const base = try std.fmt.bufPrint(&base_storage, "/tmp/nhl-path-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(base);
    defer std.fs.deleteTreeAbsolute(base) catch {};
    const long_component: [90]u8 = @splat('x');
    const root = try std.fs.path.join(allocator, &.{ base, &long_component });
    defer allocator.free(root);
    try std.fs.makeDirAbsolute(root);

    if (Runtime.open(allocator, root)) |runtime_value| {
        var runtime = runtime_value;
        runtime.deinit();
        return error.OverlongSocketPathAccepted;
    } else |err| if (err != error.SocketPathTooLong) return err;

    var directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    defer directory.close();
    if (directory.access(runtime_relative_path, .{})) {
        return error.OverlongRuntimeMutated;
    } else |err| if (err != error.FileNotFound) return err;
}

fn proveCreateFailureAdmission(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nf-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try Registry.open(allocator, &runtime);
    defer registry.deinit();
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("failed create request", &digest, .{});
    const failed = switch (try registry.reserve(
        "foreign://opaque/pre-spawn-failure",
        "failed-create-1",
        digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 0, .heightPixels = 0 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedReplay,
    };
    const committed = try registry.commitCreate(
        failed.session,
        "{\"state\":\"exec-failed\",\"layer\":\"command\"}",
    );
    if (committed.lifecycle != .create_failed) return error.CreateFailureNotTerminal;
    var failed_session = try OwnedSessionRef.init(allocator, committed.session);
    defer failed_session.deinit();
    const next = switch (try registry.reserve(
        committed.session.key,
        "failed-create-2",
        digest,
        committed.window,
    )) {
        .reserved => |record| record,
        .existing => return error.NewIncarnationMissing,
    };
    if (next.session.eql(failed_session.value)) return error.NewIncarnationMissing;
    const replay = switch (try registry.reserve(
        next.session.key,
        "failed-create-1",
        digest,
        next.window,
    )) {
        .existing => |record| record,
        .reserved => return error.HistoricalReplayLost,
    };
    if (!replay.session.eql(failed_session.value)) return error.HistoricalReplayLost;
}

/// Direct create is exactly-once against a real terminal. A replayed
/// idempotency key returns the recorded result without issuing a second spawn,
/// a changed request under that key is a typed conflict, and a descriptor map
/// is refused with typed evidence rather than silently ignored.
fn proveDirectCreateIdempotency(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nd-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try Registry.open(allocator, &runtime);
    defer registry.deinit();

    const request: CreateRequest = .{
        .key = "foreign://opaque/direct-create",
        .idempotencyKey = "direct-create-1",
        .command = .{
            .executable = "/bin/cat",
            .arguments = &.{},
            .workingDirectory = "/tmp",
            .completeEnvironment = &.{.{ .name = "TERM", .value = "xterm-256color" }},
            .descriptorMap = &.{},
        },
        .terminalProfile = .{
            .inputMode = .canonical,
            .echo = false,
            .signalCharacters = true,
            .softwareFlowControl = false,
            .eofByte = 4,
            .startByte = 17,
            .stopByte = 19,
            .hangupOnLastClose = true,
        },
        .initialWindow = .{ .columns = 80, .rows = 24, .widthPixels = 0, .heightPixels = 0 },
    };

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();
    var direct = DirectHost.init(allocator, &registry, &pty);
    defer direct.deinit();

    const created = try direct.host().create(request);
    const running = switch (created.outcome) {
        .running => |value| value,
        else => return error.DirectCreateFailed,
    };
    defer {
        _ = c.kill(running.child.processId, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(running.child.processId, &status, 0);
    }
    if (direct.spawns != 1) return error.UnexpectedSpawnCount;

    // The sharpest double-spawn risk is a fresh host process retrying the same
    // create after a crash. Its terminal is untouched, so nothing but the ledger
    // stands between the retry and a second child: assert on that host's own
    // spawn counter, which only the replay path can hold at zero. This runs
    // before the same-host replay so no earlier guard can mask it.
    var retry_pty = try pty_host.PtyHost.init(allocator);
    defer retry_pty.deinit();
    var retry_direct = DirectHost.init(allocator, &registry, &retry_pty);
    defer retry_direct.deinit();
    // However the retry ends, it must not have started a second child. The
    // ledger's own register/commit guards reject a duplicate *record*, but they
    // fire after the spawn — only the replay branch prevents the process.
    const retried = retry_direct.host().create(request) catch |err| {
        if (retry_direct.spawns != 0) return error.DoubleSpawn;
        return err;
    };
    const retried_running = switch (retried.outcome) {
        .running => |value| value,
        else => return error.DirectCreateReplayChanged,
    };
    if (retry_direct.spawns != 0) return error.DoubleSpawn;
    if (registry.list().len != 1) return error.DoubleSpawn;
    if (!retried.session.eql(created.session) or
        retried_running.child.processId != running.child.processId)
        return error.DirectCreateReplayChanged;

    // Replay control: the identical frozen request returns the recorded result
    // and this host's own terminal is never asked for a second child.
    const replayed = try direct.host().create(request);
    const replayed_running = switch (replayed.outcome) {
        .running => |value| value,
        else => return error.DirectCreateReplayChanged,
    };
    if (direct.spawns != 1) return error.DoubleSpawn;
    if (registry.list().len != 1) return error.DoubleSpawn;
    if (!replayed.session.eql(created.session) or
        replayed_running.child.processId != running.child.processId or
        !std.mem.eql(u8, replayed_running.child.startToken, running.child.startToken))
        return error.DirectCreateReplayChanged;

    // A changed request under the same idempotency key is a typed conflict,
    // never a second launch.
    var conflicting = request;
    conflicting.initialWindow = .{
        .columns = 81,
        .rows = 24,
        .widthPixels = 0,
        .heightPixels = 0,
    };
    if (direct.create(conflicting)) |_| {
        return error.ChangedRequestAccepted;
    } else |err| if (err != error.CreateConflict) return err;
    if (direct.spawns != 1) return error.DoubleSpawn;

    // Descriptor maps are explicitly unsupported in M1: the wire carries opaque
    // transfer tokens this host cannot resolve, so the create is refused with
    // typed evidence, committed to the ledger, and never spawned.
    var descriptor_pty = try pty_host.PtyHost.init(allocator);
    defer descriptor_pty.deinit();
    var descriptor_direct = DirectHost.init(allocator, &registry, &descriptor_pty);
    defer descriptor_direct.deinit();
    var descriptor_request = request;
    descriptor_request.key = "foreign://opaque/descriptor-map";
    descriptor_request.idempotencyKey = "descriptor-create-1";
    descriptor_request.command.descriptorMap = &.{.{
        .handle = .{ .token = "opaque-transfer-token", .sourceDisposition = .retain },
        .targetDescriptor = 3,
    }};
    const refused = try descriptor_direct.host().create(descriptor_request);
    switch (refused.outcome) {
        .@"exec-failed" => |evidence| {
            if (evidence.layer != .@"descriptor-transfer") return error.DescriptorMapNotRefused;
        },
        else => return error.DescriptorMapNotRefused,
    }
    if (descriptor_direct.spawns != 0) return error.DescriptorMapSpawned;
    const refused_record = registry.get(refused.session) orelse
        return error.DescriptorMapNotRefused;
    if (refused_record.lifecycle != .create_failed) return error.DescriptorMapNotRefused;

    // The committed refusal is validated against the generated wire schema by
    // proveCreateResultDocuments in the golden layer, which catches a missing
    // required-but-nullable field (osCode) without this module hand-listing the
    // frozen shape.
}

pub const CreateResultProof = struct {
    running: []const u8,
    refused: []const u8,

    pub fn deinit(self: CreateResultProof, allocator: std.mem.Allocator) void {
        allocator.free(self.refused);
        allocator.free(self.running);
    }
};

/// Assemble the frozen create-result document for one committed session.
///
/// The outcome is embedded from the COMMITTED LEDGER BYTES, parsed as an opaque
/// value, rather than re-serialized from typed values: a field the ledger
/// omitted must stay omitted here, or a schema check above would be validating
/// a document this host never actually wrote.
fn createResultDocument(
    allocator: std.mem.Allocator,
    scratch: std.mem.Allocator,
    session: SessionRef,
    committed_outcome: []const u8,
    limits: HostLimits,
) ![]u8 {
    const outcome = try std.json.parseFromSliceLeaky(std.json.Value, scratch, committed_outcome, .{});

    var session_object: std.json.ObjectMap = .init(scratch);
    try session_object.put("key", .{ .string = session.key });
    try session_object.put("incarnation", .{ .string = session.incarnation });

    var limits_object: std.json.ObjectMap = .init(scratch);
    try limits_object.put("maxInputTransactionBytes", .{ .integer = @intCast(limits.maxInputTransactionBytes) });
    try limits_object.put("maxInputQueueBytes", .{ .integer = @intCast(limits.maxInputQueueBytes) });
    try limits_object.put("maxOutputFrameBytes", .{ .integer = @intCast(limits.maxOutputFrameBytes) });
    try limits_object.put("outputLowWaterBytes", .{ .integer = @intCast(limits.outputLowWaterBytes) });
    try limits_object.put("outputHighWaterBytes", .{ .integer = @intCast(limits.outputHighWaterBytes) });
    try limits_object.put("outputRetentionBytes", .{ .integer = @intCast(limits.outputRetentionBytes) });

    var document: std.json.ObjectMap = .init(scratch);
    try document.put("session", .{ .object = session_object });
    try document.put("outcome", outcome);
    try document.put("limits", .{ .object = limits_object });
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = document }, .{});
}

/// Real committed create results — one running, one descriptor-map refusal —
/// assembled as frozen create-result documents.
///
/// This module must stay project-neutral, so it cannot validate them against
/// the Hive wire schema itself. The golden layer above imports both and does
/// the validation; producing the documents here is what lets it.
pub fn proveCreateResultDocuments(allocator: std.mem.Allocator) !CreateResultProof {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/ncr-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try Registry.open(allocator, &runtime);
    defer registry.deinit();
    var scratch = std.heap.ArenaAllocator.init(allocator);
    defer scratch.deinit();

    const request: CreateRequest = .{
        .key = "foreign://opaque/create-result-document",
        .idempotencyKey = "create-result-1",
        .command = .{
            .executable = "/bin/cat",
            .arguments = &.{},
            .workingDirectory = "/tmp",
            .completeEnvironment = &.{.{ .name = "TERM", .value = "xterm-256color" }},
            .descriptorMap = &.{},
        },
        .terminalProfile = .{
            .inputMode = .canonical,
            .echo = false,
            .signalCharacters = true,
            .softwareFlowControl = false,
            .eofByte = 4,
            .startByte = 17,
            .stopByte = 19,
            .hangupOnLastClose = true,
        },
        .initialWindow = .{ .columns = 80, .rows = 24, .widthPixels = 0, .heightPixels = 0 },
    };

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();
    var direct = DirectHost.init(allocator, &registry, &pty);
    defer direct.deinit();
    const created = try direct.host().create(request);
    switch (created.outcome) {
        .running => |value| {
            _ = c.kill(value.child.processId, c.SIGKILL);
            var status: c_int = 0;
            _ = c.waitpid(value.child.processId, &status, 0);
        },
        else => return error.DirectCreateFailed,
    }
    // Read the running record BEFORE the next create: a Record borrows registry
    // storage that the following reservation recycles.
    const running_record = registry.get(created.session) orelse return error.SessionNotFound;
    const running = try createResultDocument(
        allocator,
        scratch.allocator(),
        created.session,
        running_record.createResultJson orelse return error.MissingCreateReplay,
        created.limits,
    );
    errdefer allocator.free(running);

    var descriptor_pty = try pty_host.PtyHost.init(allocator);
    defer descriptor_pty.deinit();
    var descriptor_direct = DirectHost.init(allocator, &registry, &descriptor_pty);
    defer descriptor_direct.deinit();
    var descriptor_request = request;
    descriptor_request.key = "foreign://opaque/create-result-refusal";
    descriptor_request.idempotencyKey = "create-result-refusal-1";
    descriptor_request.command.descriptorMap = &.{.{
        .handle = .{ .token = "opaque-transfer-token", .sourceDisposition = .retain },
        .targetDescriptor = 3,
    }};
    const refused = try descriptor_direct.host().create(descriptor_request);
    const refused_record = registry.get(refused.session) orelse return error.SessionNotFound;
    const refusal = try createResultDocument(
        allocator,
        scratch.allocator(),
        refused.session,
        refused_record.createResultJson orelse return error.MissingCreateReplay,
        refused.limits,
    );
    return .{ .running = running, .refused = refusal };
}

fn proveBoundedRecovery(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nb-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var budget: std.heap.DebugAllocator(.{ .enable_memory_limit = true }) = .init;
    budget.requested_memory_limit = 128 * 1024;
    var budget_active = true;
    defer if (budget_active) {
        _ = budget.deinit();
    };
    const bounded_allocator = budget.allocator();
    var runtime = try Runtime.open(bounded_allocator, root);
    var runtime_active = true;
    defer if (runtime_active) runtime.deinit();
    var registry = try Registry.open(bounded_allocator, &runtime);
    var registry_active = true;
    defer if (registry_active) registry.deinit();
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("bounded create request", &digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://opaque/bounded-recovery",
        "bounded-create-1",
        digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 0, .heightPixels = 0 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedReplay,
    };
    const registered = try registry.register(reserved.session, .{
        .host = .{ .processId = 11, .startToken = "host-start" },
        .child = .{ .processId = 12, .startToken = "child-start" },
        .childSessionId = 12,
        .childProcessGroupId = 12,
        .foregroundProcessGroupId = 12,
        .terminalIdentity = "/dev/ttys001",
        .sessionLeader = true,
        .controllingTerminal = true,
        .standardStreamsShareTerminal = true,
        .initialProfileAppliedBeforeExec = true,
        .initialWindowAppliedBeforeExec = true,
        .window = reserved.window,
    });
    const replay = switch (try registry.reserve(
        registered.session.key,
        "bounded-create-1",
        digest,
        registered.window,
    )) {
        .existing => |record| record,
        .reserved => return error.HistoricalReplayLost,
    };
    var stable_session = try OwnedSessionRef.init(allocator, replay.session);
    defer stable_session.deinit();

    var revision: u64 = 1;
    while (revision <= 512) : (revision += 1) {
        try registry.recover();
        _ = try registry.update(stable_session.value, .{ .windowRevision = revision });
        if (!registry.recoveryComplete or registry.list().len != 1)
            return error.BoundedRecoveryIncomplete;
    }

    registry.deinit();
    registry_active = false;
    runtime.deinit();
    runtime_active = false;
    const budget_status = budget.deinit();
    budget_active = false;
    if (budget_status != .ok) return error.BoundedRecoveryLeak;
}

pub fn proveLiveLifecycle(allocator: std.mem.Allocator) !void {
    try proveSocketPathPreflight(allocator);
    try proveCreateFailureAdmission(allocator);
    try proveDirectCreateIdempotency(allocator);
    try proveBoundedRecovery(allocator);
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nhl-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try Runtime.open(allocator, root);
    var registry = Registry.open(allocator, &runtime) catch |err| {
        runtime.deinit();
        return err;
    };
    var original_owned = true;
    defer if (original_owned) {
        registry.deinit();
        runtime.deinit();
    };
    const key = "tenant://foreign-project/../../opaque session ✓";
    const request: CreateRequest = .{
        .key = key,
        .idempotencyKey = "create-idempotency-1",
        .command = .{
            .executable = "/bin/cat",
            .arguments = &.{},
            .workingDirectory = "/tmp",
            .completeEnvironment = &.{
                .{ .name = "PATH", .value = "/usr/bin:/bin" },
                .{ .name = "TERM", .value = "xterm-256color" },
            },
            .descriptorMap = &.{},
        },
        // Every field is deliberately off the terminal layer's default, so a
        // profile observed on the slave was applied by this create and not
        // inherited from the host.
        .terminalProfile = .{
            .inputMode = .canonical,
            .echo = false,
            .signalCharacters = true,
            .softwareFlowControl = true,
            .eofByte = 5,
            .startByte = 18,
            .stopByte = 20,
            .hangupOnLastClose = false,
        },
        .initialWindow = .{ .columns = 91, .rows = 37, .widthPixels = 1092, .heightPixels = 740 },
    };
    var request_digest: [32]u8 = undefined;
    hashCreateRequest(request, &request_digest);

    const ready_pipe = try std.posix.pipe();
    const host_pid = try std.posix.fork();
    if (host_pid == 0) {
        std.posix.close(ready_pipe[0]);
        runLiveProofHost(root, request, ready_pipe[1]) catch |err| {
            std.debug.print("neutral live proof host failed: {s}\n", .{@errorName(err)});
            std.posix.exit(125);
        };
        std.posix.exit(0);
    }
    var host_owned = true;
    defer if (host_owned) {
        _ = c.kill(host_pid, c.SIGKILL);
        var cleanup_status: c_int = 0;
        _ = c.waitpid(host_pid, &cleanup_status, 0);
    };
    std.posix.close(ready_pipe[1]);
    const ready: std.fs.File = .{ .handle = ready_pipe[0] };
    // The host mints the incarnation inside create, so the controller learns
    // the session identity only after the create was committed.
    var incarnation: [32]u8 = undefined;
    try readExact(ready, &incarnation);
    ready.close();
    const session: SessionRef = .{ .key = key, .incarnation = &incarnation };
    const directory_name = sessionDirectoryName(session);
    if (directory_name.len != 46 or std.mem.indexOf(u8, &directory_name, key) != null)
        return error.OpaqueDirectoryDerivationFailed;

    // Discard the original controller state. Recovery must use only the
    // durable record, private capability, and live host.sock.
    registry.deinit();
    runtime.deinit();
    original_owned = false;
    var recovered_runtime = try Runtime.open(allocator, root);
    defer recovered_runtime.deinit();
    var recovered = try Registry.open(allocator, &recovered_runtime);
    defer recovered.deinit();
    if (!recovered.recoveryComplete or recovered.list().len != 1)
        return error.RegistryRecoveryIncomplete;
    const live = recovered.get(session) orelse return error.RecoveredRecordMissing;
    if (live.lifecycle != .live or live.host == null or live.child == null)
        return error.RecoveredRecordIncomplete;
    if (live.sessionLeader != true or
        live.controllingTerminal != true or
        live.standardStreamsShareTerminal != true or
        live.initialProfileAppliedBeforeExec != true or
        live.initialWindowAppliedBeforeExec != true or
        live.childSessionId != live.child.?.processId or
        live.childProcessGroupId != live.child.?.processId or
        live.foregroundProcessGroupId != live.child.?.processId or
        live.terminalIdentity == null or
        !std.mem.startsWith(u8, live.terminalIdentity.?, "/dev/"))
        return error.RecoveredJobControlEvidenceIncomplete;
    // The committed create result is the frozen flattened wire shape, and it
    // agrees with the job-control evidence recovered from the record.
    var replay_arena = std.heap.ArenaAllocator.init(allocator);
    defer replay_arena.deinit();
    const replayed = std.json.parseFromSliceLeaky(
        StoredOutcome,
        replay_arena.allocator(),
        live.createResultJson orelse return error.MissingCreateReplay,
        .{ .ignore_unknown_fields = false },
    ) catch return error.CreateReplayChanged;
    const replayed_child = replayed.child orelse return error.CreateReplayChanged;
    const replayed_job_control = replayed.jobControl orelse return error.CreateReplayChanged;
    if (replayed.state != .running or
        replayed.execProof != .@"replacement-observed" or
        replayed_child.processId != live.child.?.processId or
        replayed_job_control.completeness != .complete or
        replayed_job_control.childSessionId != live.childSessionId.? or
        !replayed_job_control.initialProfileAppliedBeforeExec or
        !replayed_job_control.initialWindowAppliedBeforeExec)
        return error.CreateReplayChanged;
    if (recovered.remove(session))
        return error.ActiveSessionRemoved
    else |err| if (err != error.SessionStillActive) return err;

    if (HostEndpoint.open(allocator, &recovered_runtime, session)) |endpoint_value| {
        var endpoint = endpoint_value;
        endpoint.deinit();
        return error.LiveEndpointTakeoverAccepted;
    } else |err| if (err != error.HostEndpointExists) return err;

    // Positive replay control: the identical semantic digest returns the
    // original incarnation and cannot reserve or spawn another session.
    const replay = switch (try recovered.reserve(
        key,
        "create-idempotency-1",
        request_digest,
        live.window,
    )) {
        .existing => |record| record,
        .reserved => return error.DuplicateReservation,
    };
    if (!replay.session.eql(session) or recovered.list().len != 1)
        return error.DuplicateReservation;
    var changed_digest = request_digest;
    changed_digest[0] ^= 0xff;
    if (recovered.reserve(key, "create-idempotency-1", changed_digest, live.window)) |_|
        return error.ChangedRequestAccepted
    else |err| if (err != error.CreateConflict) return err;

    var client = try recovered.connect(session);
    defer client.deinit();
    var inspected = try client.call(allocator, .inspect, "", "");
    defer inspected.deinit();
    if (!inspected.accepted or !std.mem.eql(u8, inspected.payload, "live"))
        return error.LiveInspectionFailed;
    var submitted = try client.call(
        allocator,
        .submitInput,
        "input-1",
        "opaque neutral byte proof\n",
    );
    defer submitted.deinit();
    if (!submitted.accepted) return error.InputSubmissionFailed;
    var attached = try client.call(allocator, .attach, "", "0");
    defer attached.deinit();
    if (!attached.accepted or std.mem.indexOf(
        u8,
        attached.payload,
        "opaque neutral byte proof\n",
    ) == null) return error.AttachOutputMissing;
    var terminated = try client.call(
        allocator,
        .terminate,
        "terminate-1",
        "immediate",
    );
    defer terminated.deinit();
    if (!terminated.accepted or
        !std.mem.eql(u8, terminated.payload, "terminated-and-reaped"))
        return error.TerminationEvidenceMissing;

    var status: c_int = 0;
    if (c.waitpid(host_pid, &status, 0) != host_pid) return error.HostWaitFailed;
    host_owned = false;
    const status_bits: u32 = @bitCast(status);
    if (!std.posix.W.IFEXITED(status_bits) or std.posix.W.EXITSTATUS(status_bits) != 0)
        return error.HostExitedUncleanly;
    try recovered.recover();
    const final = recovered.get(session) orelse return error.FinalRecordMissing;
    if (final.lifecycle != .reaped or final.reap == null or !final.reap.?.reaped or
        final.eventSequenceHighWater == null or final.eventSequenceHighWater.? != 2 or
        final.checkpoints.retained != 1 or
        final.checkpoints.newestThroughEventSequence == null or
        final.checkpoints.newestThroughEventSequence.? != 1 or
        final.checkpoints.newestThroughOutputOffset == null or
        final.checkpoints.newestThroughOutputOffset.? <= 1)
        return error.FinalRecordIncomplete;

    var termination_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("immediate", &termination_digest, .{});
    const termination_replay = switch (try recovered.reserveTermination(
        session,
        "terminate-1",
        termination_digest,
    )) {
        .replay => |result| result,
        .reserved, .pending => return error.TerminationReplayMissing,
    };
    if (!std.mem.eql(u8, termination_replay, "terminated-and-reaped"))
        return error.TerminationReplayChanged;
    var changed_termination_digest = termination_digest;
    changed_termination_digest[0] ^= 0xff;
    if (recovered.reserveTermination(
        session,
        "terminate-1",
        changed_termination_digest,
    )) |_|
        return error.ChangedTerminationAccepted
    else |err| if (err != error.TerminationConflict) return err;

    const next = switch (try recovered.reserve(
        key,
        "create-idempotency-2",
        request_digest,
        final.window,
    )) {
        .reserved => |record| record,
        .existing => return error.NewIncarnationMissing,
    };
    if (next.session.eql(session)) return error.NewIncarnationMissing;
    var next_session = try OwnedSessionRef.init(allocator, next.session);
    defer next_session.deinit();
    const historical_replay = switch (try recovered.reserve(
        key,
        "create-idempotency-1",
        request_digest,
        final.window,
    )) {
        .existing => |record| record,
        .reserved => return error.HistoricalReplayLost,
    };
    if (!historical_replay.session.eql(session) or
        historical_replay.session.eql(next_session.value) or
        recovered.list().len != 2)
        return error.HistoricalReplayLost;
}
