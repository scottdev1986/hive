const std = @import("std");
const daemon_identity = @import("daemon_identity");
const generated = @import("session_protocol_generated");
const protocol = @import("protocol");

const equalOptionalString = daemon_identity.equalOptionalString;

pub fn writeRecordAtomic(
    allocator: std.mem.Allocator,
    host_directory: std.fs.Dir,
    json: []const u8,
) !void {
    if (!protocol.validateControlPayload(allocator, generated.wire_schema.host_record_v1, json))
        return error.InvalidHostRecord;
    var temporary_name_storage: [48]u8 = undefined;
    const temporary_name = try std.fmt.bufPrint(
        &temporary_name_storage,
        "record.json.new.{x}",
        .{std.crypto.random.int(u64)},
    );
    var file = try host_directory.createFile(temporary_name, .{
        .mode = 0o600,
        .truncate = true,
        .exclusive = true,
    });
    errdefer host_directory.deleteFile(temporary_name) catch {};
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(json);
    try file.sync();
    try host_directory.rename(temporary_name, "record.json");
    try std.posix.fsync(host_directory.fd);
}

pub fn createAdoptionSecret(host_directory: std.fs.Dir) ![32]u8 {
    var secret: [32]u8 = undefined;
    std.crypto.random.bytes(&secret);
    var file = try host_directory.createFile("adopt.cap", .{ .mode = 0o600, .exclusive = true });
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(&secret);
    try file.sync();
    try std.posix.fsync(host_directory.fd);
    return secret;
}

pub const Locator = struct {
    instance_id: []const u8,
    session_id: []const u8,
    generation: u64,
    subject: union(enum) {
        root,
        agent: []const u8,
    } = .root,
    host_kind: enum { tmux, sessiond } = .sessiond,
    engine_build_id: ?[]const u8 = null,

    pub fn eql(self: Locator, other: Locator) bool {
        return self.generation == other.generation and
            std.mem.eql(u8, self.instance_id, other.instance_id) and
            std.mem.eql(u8, self.session_id, other.session_id) and
            std.meta.activeTag(self.subject) == std.meta.activeTag(other.subject) and
            switch (self.subject) {
                .root => true,
                .agent => |agent_id| std.mem.eql(u8, agent_id, other.subject.agent),
            } and
            self.host_kind == other.host_kind and
            equalOptionalString(self.engine_build_id, other.engine_build_id);
    }
};

pub const ProcessRoot = struct {
    pid: i32,
    start_token: []const u8,
    process_group_id: i32,
};

pub const Geometry = struct {
    columns: u16,
    rows: u16,
    width_px: u32,
    height_px: u32,
    cell_width_px: f64,
    cell_height_px: f64,
};

pub const Visibility = struct {
    state: enum { attaching, visible, reconnecting, expired },
    workspace_session_id: []const u8,
    open_terminal_revision: u64,
    expires_mono_ns: u64,
};

pub const HostRecord = struct {
    locator: Locator,
    host_pid: i32,
    host_start_token: []const u8,
    process_root: ProcessRoot,
    expected_executable: []const u8,
    executable_build_hash: []const u8,
    engine_build_id: []const u8,
    protocol_major: u8,
    protocol_minor: u8,
    geometry: Geometry,
    state: enum { starting, live, exited, unknown },
    visibility: Visibility,
    output_seq: u64,
    checkpoint_seq: u64,
};

const DiskSubject = struct {
    kind: []const u8,
    agentId: ?[]const u8 = null,
};

pub const DiskLocator = struct {
    schemaVersion: u8,
    instanceId: []const u8,
    subject: DiskSubject,
    sessionId: []const u8,
    generation: u64,
    hostKind: []const u8,
    engineBuildId: ?[]const u8,
};

pub const DiskProcessRoot = struct {
    pid: i32,
    startToken: []const u8,
    processGroupId: i32,
};

pub const DiskProtocol = struct { major: u8, minor: u8 };
pub const DiskGeometry = struct {
    columns: u16,
    rows: u16,
    widthPx: u32,
    heightPx: u32,
    cellWidthPx: f64,
    cellHeightPx: f64,
};
pub const DiskVisibility = struct {
    state: []const u8,
    workspaceSessionId: []const u8,
    openTerminalRevision: []const u8,
    expiresAt: []const u8,
};

pub const DiskHostRecord = struct {
    schemaVersion: u8,
    locator: DiskLocator,
    hostPid: i32,
    hostStartToken: []const u8,
    processRoot: DiskProcessRoot,
    expectedExecutable: []const u8,
    executableBuildHash: []const u8,
    engineBuildId: []const u8,
    protocol: DiskProtocol,
    socketRelativePath: []const u8,
    geometry: DiskGeometry,
    createdAt: []const u8,
    state: []const u8,
    visibility: DiskVisibility,
    outputSeq: []const u8,
    checkpointSeq: []const u8,
};

pub fn locatorFromDisk(value: DiskLocator) !Locator {
    if (value.schemaVersion != 1) return error.InvalidLocator;
    const subject: @FieldType(Locator, "subject") = if (std.mem.eql(u8, value.subject.kind, "root")) blk: {
        if (value.subject.agentId != null) return error.InvalidLocator;
        break :blk .root;
    } else if (std.mem.eql(u8, value.subject.kind, "agent"))
        .{ .agent = value.subject.agentId orelse return error.InvalidLocator }
    else
        return error.InvalidLocator;
    return .{
        .instance_id = value.instanceId,
        .session_id = value.sessionId,
        .generation = value.generation,
        .subject = subject,
        .host_kind = std.meta.stringToEnum(@FieldType(Locator, "host_kind"), value.hostKind) orelse
            return error.InvalidLocator,
        .engine_build_id = value.engineBuildId,
    };
}

pub fn hostRecordFromDisk(value: DiskHostRecord) !HostRecord {
    var record: HostRecord = .{
        .locator = try locatorFromDisk(value.locator),
        .host_pid = value.hostPid,
        .host_start_token = value.hostStartToken,
        .process_root = .{
            .pid = value.processRoot.pid,
            .start_token = value.processRoot.startToken,
            .process_group_id = value.processRoot.processGroupId,
        },
        .expected_executable = value.expectedExecutable,
        .executable_build_hash = value.executableBuildHash,
        .engine_build_id = value.engineBuildId,
        .protocol_major = value.protocol.major,
        .protocol_minor = value.protocol.minor,
        .geometry = .{
            .columns = value.geometry.columns,
            .rows = value.geometry.rows,
            .width_px = value.geometry.widthPx,
            .height_px = value.geometry.heightPx,
            .cell_width_px = value.geometry.cellWidthPx,
            .cell_height_px = value.geometry.cellHeightPx,
        },
        .state = undefined,
        .visibility = .{
            .state = undefined,
            .workspace_session_id = value.visibility.workspaceSessionId,
            .open_terminal_revision = try std.fmt.parseInt(u64, value.visibility.openTerminalRevision, 10),
            // Restart authority comes from the challenged host's current
            // monotonic readback, never this wall-clock recovery field.
            .expires_mono_ns = 0,
        },
        .output_seq = try std.fmt.parseInt(u64, value.outputSeq, 10),
        .checkpoint_seq = try std.fmt.parseInt(u64, value.checkpointSeq, 10),
    };
    record.state = std.meta.stringToEnum(@TypeOf(record.state), value.state) orelse
        return error.InvalidHostRecord;
    record.visibility.state = std.meta.stringToEnum(@TypeOf(record.visibility.state), value.visibility.state) orelse
        return error.InvalidHostRecord;
    if (value.schemaVersion != 1 or !std.mem.eql(u8, value.socketRelativePath, "host.sock"))
        return error.InvalidHostRecord;
    return record;
}

pub const SocketEvidence = struct {
    device: u64,
    inode: u64,
    owner_uid: u32,
    mode: u16,
};

pub fn socketEvidenceAt(directory: std.fs.Dir, name: []const u8) !SocketEvidence {
    const stat = try std.posix.fstatat(directory.fd, name, std.posix.AT.SYMLINK_NOFOLLOW);
    if (stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
        stat.uid != std.posix.getuid() or stat.mode & 0o777 != 0o600)
        return error.SocketSubstitution;
    return .{
        .device = @intCast(stat.dev),
        .inode = @intCast(stat.ino),
        .owner_uid = @intCast(stat.uid),
        .mode = @intCast(stat.mode & 0o777),
    };
}

pub fn socketEvidence(host_directory: std.fs.Dir) !SocketEvidence {
    return socketEvidenceAt(host_directory, "host.sock");
}

pub fn readAdoptionSecret(host_directory: std.fs.Dir) ![32]u8 {
    const fd = try std.posix.openat(host_directory.fd, "adopt.cap", .{
        .NOFOLLOW = true,
        .CLOEXEC = true,
    }, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = try std.posix.fstat(fd);
    if (stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.uid != std.posix.getuid() or stat.mode & 0o777 != 0o600)
        return error.SecretSubstitution;
    var secret: [32]u8 = undefined;
    if (try file.readAll(&secret) != secret.len) return error.InvalidAdoptionSecret;
    var extra: [1]u8 = undefined;
    if (try file.read(&extra) != 0) return error.InvalidAdoptionSecret;
    return secret;
}

pub fn verifySocket(expected: SocketEvidence, observed: SocketEvidence) ?protocol.Failure {
    if (!std.meta.eql(expected, observed) or observed.owner_uid != std.posix.getuid() or observed.mode != 0o600)
        return .{ .code = .unauthenticated, .close_connection = true };
    return null;
}

pub fn verifyPostConnectSocket(
    expected: SocketEvidence,
    before: SocketEvidence,
    after: SocketEvidence,
) ?protocol.Failure {
    if (verifySocket(expected, before)) |failure| return failure;
    if (verifySocket(expected, after)) |failure| return failure;
    if (!std.meta.eql(before, after))
        return .{ .code = .unauthenticated, .close_connection = true };
    return null;
}

pub fn recordJsonMatches(allocator: std.mem.Allocator, record: HostRecord, json: []const u8) bool {
    const DiskRoot = struct { pid: i32, startToken: []const u8, processGroupId: i32 };
    const MatchProtocol = struct { major: u8, minor: u8 };
    const MatchVisibility = struct {
        state: []const u8,
        workspaceSessionId: []const u8,
        openTerminalRevision: []const u8,
    };
    const DiskRecord = struct {
        locator: DiskLocator,
        hostPid: i32,
        hostStartToken: []const u8,
        processRoot: DiskRoot,
        expectedExecutable: []const u8,
        executableBuildHash: []const u8,
        engineBuildId: []const u8,
        protocol: MatchProtocol,
        socketRelativePath: []const u8,
        geometry: DiskGeometry,
        state: []const u8,
        visibility: MatchVisibility,
        outputSeq: []const u8,
        checkpointSeq: []const u8,
    };
    var parsed = std.json.parseFromSlice(DiskRecord, allocator, json, .{
        .ignore_unknown_fields = true,
    }) catch return false;
    defer parsed.deinit();
    const value = parsed.value;
    const disk_locator = locatorFromDisk(value.locator) catch return false;
    return value.hostPid == record.host_pid and
        value.processRoot.pid == record.process_root.pid and
        value.processRoot.processGroupId == record.process_root.process_group_id and
        value.protocol.major == record.protocol_major and value.protocol.minor == record.protocol_minor and
        value.geometry.columns == record.geometry.columns and value.geometry.rows == record.geometry.rows and
        value.geometry.widthPx == record.geometry.width_px and value.geometry.heightPx == record.geometry.height_px and
        value.geometry.cellWidthPx == record.geometry.cell_width_px and
        value.geometry.cellHeightPx == record.geometry.cell_height_px and
        disk_locator.eql(record.locator) and
        std.mem.eql(u8, value.hostStartToken, record.host_start_token) and
        std.mem.eql(u8, value.processRoot.startToken, record.process_root.start_token) and
        std.mem.eql(u8, value.expectedExecutable, record.expected_executable) and
        std.mem.eql(u8, value.executableBuildHash, record.executable_build_hash) and
        std.mem.eql(u8, value.engineBuildId, record.engine_build_id) and
        std.mem.eql(u8, value.socketRelativePath, "host.sock") and
        std.mem.eql(u8, value.state, @tagName(record.state)) and
        std.mem.eql(u8, value.visibility.state, @tagName(record.visibility.state)) and
        std.mem.eql(u8, value.visibility.workspaceSessionId, record.visibility.workspace_session_id) and
        (std.fmt.parseInt(u64, value.visibility.openTerminalRevision, 10) catch return false) ==
            record.visibility.open_terminal_revision and
        (std.fmt.parseInt(u64, value.outputSeq, 10) catch return false) == record.output_seq and
        (std.fmt.parseInt(u64, value.checkpointSeq, 10) catch return false) == record.checkpoint_seq;
}
