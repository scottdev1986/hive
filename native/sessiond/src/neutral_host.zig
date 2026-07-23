const std = @import("std");
const pty_host = @import("pty_host");
const process_inspector = @import("process_inspector");
const contract = @import("neutral_contract");

pub const schema_version = contract.schema_version;
pub const socket_relative_path = contract.socket_relative_path;
pub const record_relative_path = contract.record_relative_path;
pub const control_relative_path = contract.control_relative_path;
pub const runtime_relative_path = contract.runtime_relative_path;
pub const operation_payload_max_bytes = contract.operation_payload_max_bytes;
pub const SessionRef = contract.SessionRef;
pub const ProcessIdentity = contract.ProcessIdentity;
pub const WindowSize = contract.WindowSize;
pub const TerminalProfile = contract.TerminalProfile;
pub const EnvironmentEntry = contract.EnvironmentEntry;
pub const TransferableHandle = contract.TransferableHandle;
pub const DescriptorMapping = contract.DescriptorMapping;
pub const Command = contract.Command;
pub const CreateRequest = contract.CreateRequest;
pub const LaunchSpec = contract.LaunchSpec;
pub const HostLimits = contract.HostLimits;
pub const JobControlEvidence = contract.JobControlEvidence;
pub const ExitStatus = contract.ExitStatus;
pub const ReapEvidence = contract.ReapEvidence;
pub const OsCode = contract.OsCode;
pub const LaunchOutcome = contract.LaunchOutcome;
pub const CreateResult = contract.CreateResult;
pub const Host = contract.Host;
const putLength = contract.putLength;

const neutral_runtime = @import("neutral_runtime");
pub const Lifecycle = neutral_runtime.Lifecycle;
pub const OutputEvidence = neutral_runtime.OutputEvidence;
pub const CheckpointEvidence = neutral_runtime.CheckpointEvidence;
pub const Record = neutral_runtime.Record;
pub const HostRegistration = neutral_runtime.HostRegistration;
pub const RecordUpdate = neutral_runtime.RecordUpdate;
pub const ReserveResult = neutral_runtime.ReserveResult;
pub const TerminationReserveResult = neutral_runtime.TerminationReserveResult;
pub const sessionDirectoryName = neutral_runtime.sessionDirectoryName;
pub const Runtime = neutral_runtime.Runtime;
const OwnedSessionRef = neutral_runtime.OwnedSessionRef;
pub const Registry = neutral_runtime.Registry;
pub const Operation = neutral_runtime.Operation;
pub const OperationRequest = neutral_runtime.OperationRequest;
pub const OperationResponse = neutral_runtime.OperationResponse;
pub const OperationHandler = neutral_runtime.OperationHandler;
const readExact = neutral_runtime.readExact;
const connection_io_timeout_ms = neutral_runtime.connection_io_timeout_ms;
const setConnectionTimeoutMs = neutral_runtime.setConnectionTimeoutMs;
pub const ClientResponse = neutral_runtime.ClientResponse;
pub const Client = neutral_runtime.Client;
pub const HostEndpoint = neutral_runtime.HostEndpoint;

const c = @cImport({
    @cInclude("signal.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});
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

fn parseStoredOutcomeOwned(allocator: std.mem.Allocator, stored: []const u8) !StoredOutcome {
    return std.json.parseFromSliceLeaky(StoredOutcome, allocator, stored, .{
        .allocate = .alloc_always,
    });
}

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
        const parsed = try parseStoredOutcomeOwned(self.arena.allocator(), stored);
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

/// Create through `host` and return the frozen create-result document for the
/// outcome the ledger committed.
///
/// The record is read here rather than by the caller because a `Record` borrows
/// registry storage that the next reservation recycles; keeping the borrow
/// inside this call is what stops a caller from holding it across another
/// create.
pub fn createDocument(
    allocator: std.mem.Allocator,
    scratch: std.mem.Allocator,
    registry: *Registry,
    host: Host,
    request: CreateRequest,
) ![]u8 {
    const created = try host.create(request);
    const record = registry.get(created.session) orelse return error.SessionNotFound;
    return createResultDocument(
        allocator,
        scratch,
        created.session,
        record.createResultJson orelse return error.MissingCreateReplay,
        created.limits,
    );
}

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

test "stored create outcome owns strings beyond registry source lifetime" {
    const running_json =
        \\{"state":"running","child":{"processId":42,"startToken":"child-start"},"execProof":"replacement-observed","jobControl":{"sessionLeader":true,"controllingTerminal":true,"standardStreamsShareTerminal":true,"childSessionId":42,"childProcessGroupId":42,"foregroundProcessGroupId":42,"terminalIdentity":"/dev/ttys001","initialProfileAppliedBeforeExec":true,"initialWindowAppliedBeforeExec":true,"completeness":"complete"}}
    ;
    var running_source: [running_json.len]u8 = undefined;
    @memcpy(running_source[0..], running_json);
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const running = try parseStoredOutcomeOwned(arena.allocator(), running_source[0..]);
    @memset(running_source[0..], 0xaa);
    const running_outcome = try running.toOutcome();
    switch (running_outcome) {
        .running => |value| {
            try std.testing.expectEqualStrings("child-start", value.child.startToken);
            try std.testing.expectEqualStrings("/dev/ttys001", value.jobControl.terminalIdentity);
        },
        else => return error.TestUnexpectedResult,
    }

    const failed_json =
        \\{"state":"exec-failed","layer":"command","osCode":null,"diagnostic":"launch-failed"}
    ;
    var failed_source: [failed_json.len]u8 = undefined;
    @memcpy(failed_source[0..], failed_json);
    const failed = try parseStoredOutcomeOwned(arena.allocator(), failed_source[0..]);
    @memset(failed_source[0..], 0xaa);
    const failed_outcome = try failed.toOutcome();
    switch (failed_outcome) {
        .@"exec-failed" => |value| try std.testing.expectEqualStrings(
            "launch-failed",
            value.diagnostic,
        ),
        else => return error.TestUnexpectedResult,
    }
}

const TestTimeoutHandler = struct {
    called: bool = false,
    payload: []const u8,

    fn operation(context: *anyopaque, _: OperationRequest) !OperationResponse {
        const self: *TestTimeoutHandler = @ptrCast(@alignCast(context));
        self.called = true;
        return .{ .payload = self.payload };
    }

    fn handler(self: *TestTimeoutHandler) OperationHandler {
        return .{ .context = self, .callFn = operation };
    }
};

test "stalled accepted connection is cut by the transport deadline and later calls proceed" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nht-{x}", .{
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
    std.crypto.hash.sha2.Sha256.hash("timeout-proof", &digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://opaque/timeout-proof",
        "timeout-create-1",
        digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedReplay,
    };
    const session = reserved.session;
    // A Record borrows registry storage that the register below recycles, so
    // the session identity used across that mutation must be copied out first.
    var stable_session = try OwnedSessionRef.init(allocator, session);
    defer stable_session.deinit();
    _ = try registry.register(session, .{
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
    var endpoint = try HostEndpoint.open(allocator, &runtime, stable_session.value);
    defer endpoint.deinit();

    // A peer that connects and stalls pre-authentication must not freeze the
    // single-threaded host: the accepted connection carries the fail-closed
    // recv/send bound from the moment accept returns.
    const stalled = try std.net.connectUnixSocket(endpoint.socketPath);
    defer stalled.close();
    var accepted: ?std.net.Stream = null;
    var attempts: usize = 0;
    while (accepted == null and attempts < 100) : (attempts += 1) {
        accepted = try endpoint.acceptIfReady();
        if (accepted == null) std.Thread.sleep(std.time.ns_per_ms);
    }
    const server = accepted orelse return error.NeutralEndpointNotReady;
    defer server.close();
    var rcv: c.struct_timeval = undefined;
    var rcv_len: c.socklen_t = @sizeOf(c.struct_timeval);
    if (c.getsockopt(server.handle, c.SOL_SOCKET, c.SO_RCVTIMEO, &rcv, &rcv_len) != 0)
        return error.TimeoutEvidenceMissing;
    try testing.expectEqual(
        @as(@TypeOf(rcv.tv_sec), @intCast(connection_io_timeout_ms / std.time.ms_per_s)),
        rcv.tv_sec,
    );
    try testing.expectEqual(@as(@TypeOf(rcv.tv_usec), 0), rcv.tv_usec);

    // With the bound shortened so the test does not wait out the production
    // value, the stalled peer's silence fails the header read with WouldBlock
    // and the operation handler is never reached.
    try setConnectionTimeoutMs(server.handle, 50);
    var never: TestTimeoutHandler = .{ .payload = "unexpected" };
    try testing.expectError(
        error.WouldBlock,
        endpoint.serveAccepted(server, never.handler()),
    );
    try testing.expect(!never.called);

    // Positive control: cutting the stalled connection must not take the
    // endpoint with it — the next well-formed client is served normally.
    var stub: TestTimeoutHandler = .{ .payload = "live" };
    const serve_thread = try std.Thread.spawn(.{}, struct {
        fn serve(ep: *HostEndpoint, operation_handler: OperationHandler) void {
            ep.serveOne(operation_handler) catch {};
        }
    }.serve, .{ &endpoint, stub.handler() });
    var client = try registry.connect(stable_session.value);
    defer client.deinit();
    var response = try client.call(allocator, .inspect, "", "");
    defer response.deinit();
    try testing.expect(response.accepted);
    try testing.expectEqualStrings("live", response.payload);
    serve_thread.join();
    try testing.expect(stub.called);
}

test "bound control socket keeps its 0o600 mode evidence under a permissive umask" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nhm-{x}", .{
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
    std.crypto.hash.sha2.Sha256.hash("mode-proof", &digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://opaque/mode-proof",
        "mode-create-1",
        digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedReplay,
    };

    // Even with a fully permissive process umask the socket node must come
    // into existence without group/other bits, and the recorded evidence
    // every later open is checked against must agree.
    const previous_umask = c.umask(0o000);
    defer _ = c.umask(previous_umask);
    var endpoint = try HostEndpoint.open(allocator, &runtime, reserved.session);
    defer endpoint.deinit();
    try testing.expectEqual(@as(u16, 0o600), endpoint.socketEvidence.mode);
}

test "client refuses an aggregate frame the server would reject" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/nha-{x}", .{
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
    std.crypto.hash.sha2.Sha256.hash("aggregate-proof", &digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://opaque/aggregate-proof",
        "aggregate-create-1",
        digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedReplay,
    };
    // A Record borrows registry storage that register recycles, so the
    // session identity used across that mutation must be copied out first.
    var stable_session = try OwnedSessionRef.init(allocator, reserved.session);
    defer stable_session.deinit();
    _ = try registry.register(reserved.session, .{
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
    var client = try registry.connect(stable_session.value);
    defer client.deinit();

    // Every field is individually under operation_payload_max_bytes but their
    // SUM — the rule serveAccepted enforces — is over: the client must refuse
    // before writing to a socket the server would abandon mid-frame.
    const payload = try allocator.alloc(u8, operation_payload_max_bytes - 64);
    defer allocator.free(payload);
    @memset(payload, 'x');
    const long_key = try allocator.alloc(u8, 256);
    defer allocator.free(long_key);
    @memset(long_key, 'k');
    try testing.expectError(
        error.OperationFrameTooLarge,
        client.call(allocator, .inspect, long_key, payload),
    );

    // Positive control: a frame under the aggregate bound passes the size
    // gate and fails later on missing socket evidence (no endpoint is
    // listening), proving the rejection above was the aggregate rule.
    try testing.expectError(
        error.FileNotFound,
        client.call(allocator, .inspect, "", ""),
    );
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
    // Security gate: the live proof handler below terminates a real child and
    // writes proof-run evidence — including a FROZEN observedAt timestamp —
    // into the durable ledger. That ledger-write power must stay unreachable
    // from production code paths, so the handler and its host role are
    // declared INSIDE this proof entry point rather than at module scope:
    // nothing outside `proveLiveLifecycle` (whose only caller is the golden
    // proof runner, test/neutral-host-golden.zig) can name or serve them.
    const LiveProofHost = struct {
        pty: *pty_host.PtyHost,
        registry: *Registry,
        session: SessionRef,
        terminated: bool = false,

        fn operation(context: *anyopaque, request: OperationRequest) !OperationResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
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

        fn handler(self: *@This()) OperationHandler {
            return .{ .context = self, .callFn = operation };
        }

        fn run(root: []const u8, request: CreateRequest, ready_fd: std.posix.fd_t) !void {
            const run_allocator = std.heap.page_allocator;
            var runtime = try Runtime.open(run_allocator, root);
            defer runtime.deinit();
            var registry = try Registry.open(run_allocator, &runtime);
            defer registry.deinit();

            var pty = try pty_host.PtyHost.init(run_allocator);
            defer pty.deinit();
            var direct = DirectHost.init(run_allocator, &registry, &pty);
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

            var endpoint = try HostEndpoint.open(run_allocator, &runtime, session);
            defer endpoint.deinit();

            const ready: std.fs.File = .{ .handle = ready_fd };
            try ready.writeAll(session.incarnation);
            ready.close();
            var proof_host: @This() = .{
                .pty = &pty,
                .registry = &registry,
                .session = session,
            };
            while (!proof_host.terminated) try endpoint.serveOne(proof_host.handler());
        }
    };
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
    const consumer_cwd = try std.fs.path.join(allocator, &.{ root, "generic command cwd 工作" });
    defer allocator.free(consumer_cwd);
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    try root_directory.makeDir("generic command cwd 工作");
    var consumer_directory = try root_directory.openDir("generic command cwd 工作", .{});
    const cwd_marker = try consumer_directory.createFile("terminal-host-demo.cwd", .{});
    cwd_marker.close();
    consumer_directory.close();
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
            .executable = "/bin/sh",
            .arguments = &.{ "-c", "test -f terminal-host-demo.cwd && exec /bin/cat" },
            .workingDirectory = consumer_cwd,
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
        LiveProofHost.run(root, request, ready_pipe[1]) catch |err| {
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
    // Slave OPOST|ONLCR expands the written bare NL to CRLF on the master.
    if (!attached.accepted or std.mem.indexOf(
        u8,
        attached.payload,
        "opaque neutral byte proof\r\n",
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
