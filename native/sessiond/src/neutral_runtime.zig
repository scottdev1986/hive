const std = @import("std");
const contract = @import("neutral_contract");

const c = @cImport({
    @cInclude("sys/socket.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/time.h");
    @cInclude("unistd.h");
});

const schema_version = contract.schema_version;
const socket_relative_path = contract.socket_relative_path;
const record_relative_path = contract.record_relative_path;
const control_relative_path = contract.control_relative_path;
const runtime_relative_path = contract.runtime_relative_path;
const operation_payload_max_bytes = contract.operation_payload_max_bytes;
const SessionRef = contract.SessionRef;
const ProcessIdentity = contract.ProcessIdentity;
const WindowSize = contract.WindowSize;
const ExitStatus = contract.ExitStatus;
const ReapEvidence = contract.ReapEvidence;
const putLength = contract.putLength;

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

pub const OwnedSessionRef = struct {
    allocator: std.mem.Allocator,
    value: SessionRef,

    pub fn init(allocator: std.mem.Allocator, source: SessionRef) !OwnedSessionRef {
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

    pub fn deinit(self: *OwnedSessionRef) void {
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

pub fn readExact(file: std.fs.File, bytes: []u8) !void {
    if (try file.readAll(bytes) != bytes.len) return error.TruncatedOperationFrame;
}

/// Transport bound applied to every accepted control connection, in the same
/// idiom as session_host.zig's lease-bound SO_RCVTIMEO/SO_SNDTIMEO. The host
/// serve loop is single-threaded and the pre-authentication read below is
/// blocking, so a same-uid peer that connects and stalls (or drips a partial
/// frame) must not freeze every later operation: a read or write that
/// outlasts the bound fails WouldBlock, the caller drops that connection, and
/// the host keeps serving. Fail-closed: if the bound itself cannot be
/// installed the connection is refused rather than served without one.
pub const connection_io_timeout_ms: u64 = 10 * std.time.ms_per_s;

pub fn setConnectionTimeoutMs(fd: std.posix.fd_t, timeout_ms: u64) !void {
    if (timeout_ms == 0) return error.InvalidConnectionTimeout;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(timeout_ms / std.time.ms_per_s),
        .tv_usec = @intCast(
            (timeout_ms % std.time.ms_per_s) * std.time.us_per_ms,
        ),
    };
    if (c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0 or
        c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.ConnectionTimeoutUnavailable;
}

fn setConnectionTimeout(fd: std.posix.fd_t) !void {
    return setConnectionTimeoutMs(fd, connection_io_timeout_ms);
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
        // The server rejects a request whose fields SUM to more than
        // operation_payload_max_bytes (see serveAccepted), so the client must
        // apply the same aggregate rule: a request the server will reject must
        // fail here, before the bytes are written to a socket the server has
        // already abandoned.
        const total = std.math.add(
            usize,
            try std.math.add(usize, self.session.key.len, self.session.incarnation.len),
            try std.math.add(usize, idempotency_key.len, payload.len),
        ) catch return error.OperationFrameTooLarge;
        if (total > operation_payload_max_bytes) return error.OperationFrameTooLarge;
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
        // Bind under a restrictive umask so the socket node is never group- or
        // world-accessible, not even in the window between bind and the chmod
        // below. The chmod and the socketEvidenceAt readback stay: they are
        // the durable mode evidence (0o600) every later open is checked
        // against. umask is process-wide, so save and restore it around the
        // listen rather than leaving the host's umask tightened.
        const previous_umask = c.umask(0o077);
        var server = address.listen(.{}) catch |err| {
            _ = c.umask(previous_umask);
            return err;
        };
        _ = c.umask(previous_umask);
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
        // Install the transport bound before any byte is read: the header
        // read below is pre-authentication, so an unbounded block here would
        // let any same-uid peer freeze the single-threaded host.
        try setConnectionTimeout(connection.stream.handle);
        try self.serveAccepted(connection.stream, handler);
    }

    /// Returns one ready connection without changing serveOne's blocking
    /// contract. The returned stream already carries the endpoint's
    /// fail-closed recv/send bound (connection_io_timeout_ms); the caller
    /// owns the stream and may tighten, but never loosen, that deadline.
    pub fn acceptIfReady(self: *HostEndpoint) !?std.net.Stream {
        if (!std.meta.eql(self.socketEvidence, try socketEvidenceAt(self.directory)))
            return error.SocketSubstitution;
        var poll_fds = [_]std.posix.pollfd{.{
            .fd = self.server.stream.handle,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        if (try std.posix.poll(&poll_fds, 0) == 0) return null;
        if (poll_fds[0].revents & std.posix.POLL.IN == 0)
            return error.HostEndpointUnavailable;
        const connection = try self.server.accept();
        errdefer connection.stream.close();
        try setConnectionTimeout(connection.stream.handle);
        if (!std.meta.eql(self.socketEvidence, try socketEvidenceAt(self.directory)))
            return error.SocketSubstitution;
        return connection.stream;
    }

    pub fn serveAccepted(
        self: *HostEndpoint,
        stream: std.net.Stream,
        handler: OperationHandler,
    ) !void {
        if (!std.meta.eql(self.socketEvidence, try socketEvidenceAt(self.directory)))
            return error.SocketSubstitution;
        const file: std.fs.File = .{ .handle = stream.handle };
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
