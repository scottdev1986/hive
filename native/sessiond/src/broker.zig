const std = @import("std");
pub const protocol = @import("protocol");
pub const generated = @import("session_protocol_generated");

test {
    std.testing.refAllDecls(@This());
}

const c = @cImport({
    @cInclude("libproc.h");
    @cInclude("sys/proc_info.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/time.h");
    @cInclude("sys/un.h");
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

fn taggedUuidV7(output: []u8, prefix: []const u8) ![]const u8 {
    const timestamp = std.time.milliTimestamp();
    if (timestamp < 0 or @as(u64, @intCast(timestamp)) >= (@as(u64, 1) << 48))
        return error.InvalidTimestamp;
    const millis: u64 = @intCast(timestamp);
    var bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&bytes);
    inline for (0..6) |index| {
        const shift: u6 = @intCast((5 - index) * 8);
        bytes[index] = @intCast((millis >> shift) & 0xff);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = std.fmt.bytesToHex(bytes, .lower);
    return std.fmt.bufPrint(output, "{s}{s}-{s}-{s}-{s}-{s}", .{
        prefix,
        hex[0..8],
        hex[8..12],
        hex[12..16],
        hex[16..20],
        hex[20..32],
    });
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

fn equalOptionalString(left: ?[]const u8, right: ?[]const u8) bool {
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
    const parsed = try std.json.parseFromSlice(DaemonHello, allocator, payload, .{});
    if (parsed.value.schemaVersion != 1 or !std.mem.eql(u8, parsed.value.clientRole, "daemon")) {
        var owned = parsed;
        owned.deinit();
        return error.MalformedDaemonHello;
    }
    return parsed;
}

fn readOwnedFileAt(
    allocator: std.mem.Allocator,
    directory: std.fs.Dir,
    name: []const u8,
    cap: usize,
) ![]u8 {
    const fd = std.posix.openat(directory.fd, name, .{ .NOFOLLOW = true, .CLOEXEC = true }, 0) catch |err| switch (err) {
        error.SymLinkLoop => return error.FileSubstitution,
        else => return err,
    };
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFREG)
        return error.FileSubstitution;
    return file.readToEndAlloc(allocator, cap);
}

pub fn loadDaemonLock(allocator: std.mem.Allocator, canonical_home: []const u8) !std.json.Parsed(DaemonLock) {
    var home = try std.fs.cwd().openDir(canonical_home, .{ .no_follow = true });
    defer home.close();
    const contents = try readOwnedFileAt(allocator, home, "daemon.lock", generated.limits.control_json_bytes);
    defer allocator.free(contents);
    return std.json.parseFromSlice(DaemonLock, allocator, contents, .{}) catch error.DaemonIdentityUnavailable;
}

fn daemonPort(allocator: std.mem.Allocator, canonical_home: []const u8) !u16 {
    var home = try std.fs.cwd().openDir(canonical_home, .{ .no_follow = true });
    defer home.close();
    const contents = try readOwnedFileAt(allocator, home, "daemon.port", 32);
    defer allocator.free(contents);
    const port = try std.fmt.parseInt(u16, std.mem.trim(u8, contents, " \t\r\n"), 10);
    if (port == 0) return error.InvalidDaemonPort;
    return port;
}

fn setControlTimeout(socket: std.posix.fd_t) !void {
    const millis = generated.limits.control_rpc_timeout_ms;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(millis / std.time.ms_per_s),
        .tv_usec = @intCast((millis % std.time.ms_per_s) * std.time.us_per_ms),
    };
    if (c.setsockopt(socket, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0 or
        c.setsockopt(socket, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.SocketTimeoutFailed;
}

fn setTransportReadTimeout(socket: std.posix.fd_t) !void {
    const millis = generated.limits.connection_ping_interval_ms;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(millis / std.time.ms_per_s),
        .tv_usec = @intCast((millis % std.time.ms_per_s) * std.time.us_per_ms),
    };
    if (c.setsockopt(socket, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.SocketTimeoutFailed;
}

pub fn loadDaemonHandshake(
    allocator: std.mem.Allocator,
    canonical_home: []const u8,
) !std.json.Parsed(DaemonHandshake) {
    const port = try daemonPort(allocator, canonical_home);
    const stream = try std.net.tcpConnectToHost(allocator, "127.0.0.1", port);
    defer stream.close();
    try setControlTimeout(stream.handle);
    try stream.writeAll("GET /handshake HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    const file: std.fs.File = .{ .handle = stream.handle };
    const response = try file.readToEndAlloc(allocator, generated.limits.control_json_bytes + 8192);
    defer allocator.free(response);
    if (!std.mem.startsWith(u8, response, "HTTP/1.1 200 ") and
        !std.mem.startsWith(u8, response, "HTTP/1.0 200 ")) return error.InvalidDaemonHandshakeResponse;
    const separator = std.mem.indexOf(u8, response, "\r\n\r\n") orelse
        return error.InvalidDaemonHandshakeResponse;
    const body = response[separator + 4 ..];
    if (body.len > generated.limits.control_json_bytes) return error.InvalidDaemonHandshakeResponse;
    return std.json.parseFromSlice(DaemonHandshake, allocator, body, .{}) catch error.InvalidDaemonHandshakeResponse;
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

fn openOwnedDirectory(parent: std.fs.Dir, name: []const u8, private: bool, iterate: bool) !std.fs.Dir {
    parent.makeDir(name) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    var directory = parent.openDir(name, .{ .no_follow = true, .iterate = iterate }) catch |err| switch (err) {
        error.SymLinkLoop, error.NotDir => return error.DirectorySubstitution,
        else => return err,
    };
    errdefer directory.close();
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
    if (private) {
        try directory.chmod(0o700);
        const secured = try std.posix.fstat(directory.fd);
        if (secured.mode & 0o777 != 0o700) return error.DirectoryModeFailed;
    }
    return directory;
}

fn openBrokerLock(directory: std.fs.Dir) !std.fs.File {
    const fd = std.posix.openat(directory.fd, "broker.lock", .{
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
    const stat = try std.posix.fstat(file.handle);
    if (stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or stat.mode & 0o777 != 0o600 or
        stat.uid != std.posix.getuid())
    {
        try file.chmod(0o600);
        const secured = try std.posix.fstat(file.handle);
        if (secured.mode & std.posix.S.IFMT != std.posix.S.IFREG or secured.mode & 0o777 != 0o600 or
            secured.uid != std.posix.getuid())
            return error.LockSubstitution;
    }
    return file;
}

pub const Runtime = struct {
    allocator: std.mem.Allocator,
    canonical_home: []u8,
    directory: std.fs.Dir,
    lock_file: std.fs.File,
    server: std.net.Server,
    socket_evidence: SocketEvidence,

    pub fn open(allocator: std.mem.Allocator, hive_home: []const u8) !Runtime {
        const canonical_home = try std.fs.cwd().realpathAlloc(allocator, hive_home);
        errdefer allocator.free(canonical_home);
        var home = try std.fs.cwd().openDir(canonical_home, .{ .no_follow = true });
        defer home.close();
        var runtime = try openOwnedDirectory(home, "runtime", false, false);
        defer runtime.close();
        var directory = try openOwnedDirectory(runtime, "sessiond", true, true);
        errdefer directory.close();
        var hosts = try openOwnedDirectory(directory, "hosts", true, false);
        hosts.close();

        var lock_file = try openBrokerLock(directory);
        errdefer lock_file.close();
        if (!try lock_file.tryLock(.exclusive)) return error.BrokerAlreadyRunning;

        const socket_stat = std.posix.fstatat(directory.fd, "broker.sock", std.posix.AT.SYMLINK_NOFOLLOW) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        if (socket_stat) |stat| {
            if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
                stat.mode & 0o777 != 0o600)
                return error.SocketSubstitution;
            try directory.deleteFile("broker.sock");
        }

        const socket_path = try std.fs.path.join(allocator, &.{ canonical_home, "runtime/sessiond/broker.sock" });
        defer allocator.free(socket_path);
        const address = try std.net.Address.initUnix(socket_path);
        var server = try address.listen(.{});
        errdefer server.deinit();
        const socket_path_z = try allocator.dupeZ(u8, socket_path);
        defer allocator.free(socket_path_z);
        if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;

        const created = try std.posix.fstatat(directory.fd, "broker.sock", std.posix.AT.SYMLINK_NOFOLLOW);
        if (created.uid != std.posix.getuid() or created.mode & 0o777 != 0o600 or
            created.mode & std.posix.S.IFMT != std.posix.S.IFSOCK)
            return error.SocketSubstitution;

        return .{
            .allocator = allocator,
            .canonical_home = canonical_home,
            .directory = directory,
            .lock_file = lock_file,
            .server = server,
            .socket_evidence = socketEvidenceAt(directory, "broker.sock") catch return error.SocketSubstitution,
        };
    }

    pub fn deinit(self: *Runtime) void {
        self.server.deinit();
        if (socketEvidenceAt(self.directory, "broker.sock")) |observed| {
            if (std.meta.eql(self.socket_evidence, observed))
                self.directory.deleteFile("broker.sock") catch {};
        } else |_| {}
        self.lock_file.unlock();
        self.lock_file.close();
        self.directory.close();
        self.allocator.free(self.canonical_home);
    }

    pub fn acceptAuthenticatedPeer(self: *Runtime) !struct { stream: std.net.Stream, peer: ObservedPeer } {
        if (!std.meta.eql(self.socket_evidence, try socketEvidenceAt(self.directory, "broker.sock")))
            return error.SocketSubstitution;
        const connection = try self.server.accept();
        errdefer connection.stream.close();
        if (!std.meta.eql(self.socket_evidence, try socketEvidenceAt(self.directory, "broker.sock")))
            return error.SocketSubstitution;
        return .{ .stream = connection.stream, .peer = try inspectPeer(connection.stream.handle) };
    }

    pub fn openHostDirectory(self: *Runtime, session_id: []const u8, create: bool) !std.fs.Dir {
        if (!protocol.validSessionId(session_id)) return error.InvalidSessionId;
        var hosts = try self.directory.openDir("hosts", .{ .no_follow = true });
        defer hosts.close();
        if (create) {
            hosts.makeDir(session_id) catch |err| switch (err) {
                error.PathAlreadyExists => return error.HostAlreadyExists,
                else => return err,
            };
        }
        var host = hosts.openDir(session_id, .{ .no_follow = true, .iterate = true }) catch |err| switch (err) {
            error.SymLinkLoop, error.NotDir => return error.DirectorySubstitution,
            else => return err,
        };
        errdefer host.close();
        const stat = try std.posix.fstat(host.fd);
        if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
            return error.DirectorySubstitution;
        try host.chmod(0o700);
        return host;
    }
};

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
};

fn sameLocator(left: Locator, right: Locator) bool {
    return left.generation == right.generation and
        std.mem.eql(u8, left.instance_id, right.instance_id) and
        std.mem.eql(u8, left.session_id, right.session_id) and
        std.meta.activeTag(left.subject) == std.meta.activeTag(right.subject) and
        switch (left.subject) {
            .root => true,
            .agent => |agent_id| std.mem.eql(u8, agent_id, right.subject.agent),
        } and
        left.host_kind == right.host_kind and
        equalOptionalString(left.engine_build_id, right.engine_build_id);
}

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

const DiskLocator = struct {
    schemaVersion: u8,
    instanceId: []const u8,
    subject: DiskSubject,
    sessionId: []const u8,
    generation: u64,
    hostKind: []const u8,
    engineBuildId: ?[]const u8,
};

const DiskProcessRoot = struct {
    pid: i32,
    startToken: []const u8,
    processGroupId: i32,
};

const DiskProtocol = struct { major: u8, minor: u8 };
const DiskGeometry = struct {
    columns: u16,
    rows: u16,
    widthPx: u32,
    heightPx: u32,
    cellWidthPx: f64,
    cellHeightPx: f64,
};
const DiskVisibility = struct {
    state: []const u8,
    workspaceSessionId: []const u8,
    openTerminalRevision: []const u8,
    expiresAt: []const u8,
};

const DiskHostRecord = struct {
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

fn locatorFromDisk(value: DiskLocator) !Locator {
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

fn hostRecordFromDisk(value: DiskHostRecord) !HostRecord {
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

fn socketEvidenceAt(directory: std.fs.Dir, name: []const u8) !SocketEvidence {
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

fn socketEvidence(host_directory: std.fs.Dir) !SocketEvidence {
    return socketEvidenceAt(host_directory, "host.sock");
}

fn readAdoptionSecret(host_directory: std.fs.Dir) ![32]u8 {
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

fn verifyPostConnectSocket(
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

pub const AdoptionReadback = struct {
    locator: Locator,
    host_pid: i32,
    host_start_token: []const u8,
    executable: []const u8,
    executable_build_hash: []const u8,
    engine_build_id: []const u8,
    protocol_major: u8,
    protocol_minor: u8,
    process_root: ProcessRoot,
    output_seq: u64,
    checkpoint_seq: u64,
    visibility: Visibility,
};

pub const TerminationReadback = struct {
    pty_closed: bool,
    host_exited: bool,
    verification_complete: bool,
    survivor_count: usize,
};

pub const TerminationState = enum { terminated, survivors, unknown };

pub const TerminationCommand = struct {
    mode: []const u8,
    reason: []const u8,
    request_id: []const u8,
};

pub const GrantRegistration = struct {
    hash: [32]u8,
    viewer_id: []const u8,
    operations: []const []const u8,
    geometry: Geometry,
    registered_mono_ns: u64,
    expires_mono_ns: u64,
};

pub const HostControl = struct {
    context: *anyopaque,
    adopt_fn: *const fn (*anyopaque, Locator, [32]u8, u64) ?AdoptionReadback,
    register_grant_fn: *const fn (*anyopaque, Locator, GrantRegistration) bool,
    terminate_fn: *const fn (*anyopaque, Locator, TerminationCommand) TerminationReadback,

    pub fn adopt(self: HostControl, locator: Locator, secret: [32]u8, now_ns: u64) ?AdoptionReadback {
        return self.adopt_fn(self.context, locator, secret, now_ns);
    }

    pub fn registerGrant(self: HostControl, locator: Locator, grant: GrantRegistration) bool {
        return self.register_grant_fn(self.context, locator, grant);
    }

    pub fn terminate(self: HostControl, locator: Locator, command: TerminationCommand) TerminationReadback {
        return self.terminate_fn(self.context, locator, command);
    }
};

const WireWelcome = struct {
    schemaVersion: u8,
    protocol: struct { major: u8, minor: u8 },
    instanceId: []const u8,
    endpointRole: []const u8,
    buildId: []const u8,
    engineBuildId: ?[]const u8,
};

const WireAdoptionReadback = struct {
    schemaVersion: u8,
    locator: DiskLocator,
    hostPid: i32,
    hostStartToken: []const u8,
    executable: []const u8,
    executableBuildHash: []const u8,
    engineBuildId: []const u8,
    protocol: DiskProtocol,
    processRoot: DiskProcessRoot,
    outputSeq: []const u8,
    checkpointSeq: []const u8,
    visibility: DiskVisibility,
};

const WireTerminationReadback = struct {
    schemaVersion: u8,
    locator: DiskLocator,
    state: []const u8,
    survivors: []const std.json.Value,
    errors: []const std.json.Value,
};

fn locatorJsonValue(allocator: std.mem.Allocator, locator: Locator) !std.json.Value {
    var subject = std.json.ObjectMap.init(allocator);
    try subject.put("kind", .{ .string = @tagName(locator.subject) });
    switch (locator.subject) {
        .root => {},
        .agent => |agent_id| try subject.put("agentId", .{ .string = agent_id }),
    }
    var value = std.json.ObjectMap.init(allocator);
    try value.put("schemaVersion", .{ .integer = 1 });
    try value.put("instanceId", .{ .string = locator.instance_id });
    try value.put("subject", .{ .object = subject });
    try value.put("generation", .{ .integer = @intCast(locator.generation) });
    try value.put("sessionId", .{ .string = locator.session_id });
    try value.put("hostKind", .{ .string = @tagName(locator.host_kind) });
    try value.put("engineBuildId", if (locator.engine_build_id) |build|
        .{ .string = build }
    else
        .null);
    return .{ .object = value };
}

pub fn wallDeadline(output: []u8, additional_ms: u64) ![]const u8 {
    const now_ms = std.time.milliTimestamp();
    if (now_ms < 0) return error.InvalidTimestamp;
    const deadline_ms = std.math.add(u64, @intCast(now_ms), additional_ms) catch
        return error.InvalidTimestamp;
    const epoch_seconds: std.time.epoch.EpochSeconds = .{ .secs = deadline_ms / std.time.ms_per_s };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.bufPrint(output, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        year_day.year,
        month_day.month.numeric(),
        month_day.day_index + 1,
        day_seconds.getHoursIntoDay(),
        day_seconds.getMinutesIntoHour(),
        day_seconds.getSecondsIntoMinute(),
        deadline_ms % std.time.ms_per_s,
    });
}

fn leapYearsThrough(year: u64) u64 {
    return year / 4 - year / 100 + year / 400;
}

fn wallTimestampMillis(value: []const u8) !u64 {
    if (value.len != 24 or value[4] != '-' or value[7] != '-' or value[10] != 'T' or
        value[13] != ':' or value[16] != ':' or value[19] != '.' or value[23] != 'Z')
        return error.InvalidTimestamp;
    const year = try std.fmt.parseInt(u64, value[0..4], 10);
    const month = try std.fmt.parseInt(u8, value[5..7], 10);
    const day = try std.fmt.parseInt(u8, value[8..10], 10);
    const hour = try std.fmt.parseInt(u8, value[11..13], 10);
    const minute = try std.fmt.parseInt(u8, value[14..16], 10);
    const second = try std.fmt.parseInt(u8, value[17..19], 10);
    const millisecond = try std.fmt.parseInt(u16, value[20..23], 10);
    if (year < 1970 or month == 0 or month > 12 or day == 0 or hour > 23 or
        minute > 59 or second > 59)
        return error.InvalidTimestamp;
    const leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
    const month_days = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day > month_days[month - 1]) return error.InvalidTimestamp;
    var days = (year - 1970) * 365 + leapYearsThrough(year - 1) - leapYearsThrough(1969);
    for (month_days[0 .. month - 1]) |count| days += count;
    days += day - 1;
    const seconds = try std.math.add(
        u64,
        try std.math.mul(u64, days, std.time.s_per_day),
        @as(u64, hour) * std.time.s_per_hour + @as(u64, minute) * std.time.s_per_min + second,
    );
    return try std.math.add(u64, try std.math.mul(u64, seconds, std.time.ms_per_s), millisecond);
}

fn wallExpiryToMonotonic(value: []const u8, now_ns: u64, maximum_ms: u64) !u64 {
    const deadline_ms = try wallTimestampMillis(value);
    const wall_now = std.time.milliTimestamp();
    if (wall_now < 0 or deadline_ms <= @as(u64, @intCast(wall_now))) return error.Expired;
    const remaining_ms = deadline_ms - @as(u64, @intCast(wall_now));
    if (remaining_ms > maximum_ms) return error.InvalidTimestamp;
    return try std.math.add(u64, now_ns, try std.math.mul(u64, remaining_ms, std.time.ns_per_ms));
}

/// Production broker-side implementation of the WP4 seam. Every operation
/// reconnects and authenticates the exact recorded host before speaking v1 on
/// host.sock; the test double exercises this code over a real UDS.
pub const WireHostClient = struct {
    allocator: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    directory: std.fs.Dir,
    socket_path: []u8,
    expected_socket: SocketEvidence,
    expected_record: HostRecord,
    broker_build_id: []u8,

    pub fn init(
        allocator: std.mem.Allocator,
        directory: std.fs.Dir,
        socket_path: []const u8,
        expected_socket: SocketEvidence,
        expected_record: HostRecord,
        broker_build_id: []const u8,
    ) !WireHostClient {
        var owned_directory: std.fs.Dir = .{ .fd = try std.posix.dup(directory.fd) };
        errdefer owned_directory.close();
        const owned_path = try allocator.dupe(u8, socket_path);
        errdefer allocator.free(owned_path);
        const owned_build_id = try allocator.dupe(u8, broker_build_id);
        errdefer allocator.free(owned_build_id);
        return .{
            .allocator = allocator,
            .arena = std.heap.ArenaAllocator.init(allocator),
            .directory = owned_directory,
            .socket_path = owned_path,
            .expected_socket = expected_socket,
            .expected_record = expected_record,
            .broker_build_id = owned_build_id,
        };
    }

    pub fn deinit(self: *WireHostClient) void {
        self.directory.close();
        self.allocator.free(self.socket_path);
        self.allocator.free(self.broker_build_id);
        self.arena.deinit();
    }

    pub fn control(self: *WireHostClient) HostControl {
        return .{
            .context = self,
            .adopt_fn = adoptCallback,
            .register_grant_fn = registerGrantCallback,
            .terminate_fn = terminateCallback,
        };
    }

    fn verifyPeer(self: *WireHostClient, peer: *const ObservedPeer) !void {
        if (peer.uid != std.posix.getuid() or peer.gid != @as(u32, @intCast(c.getgid())) or
            peer.pid != self.expected_record.host_pid or
            !std.mem.eql(u8, peer.executablePath(), self.expected_record.expected_executable))
            return error.HostIdentityMismatch;
        var token_storage: [64]u8 = undefined;
        const token = try formatStartToken(peer.start_token, &token_storage);
        if (!std.mem.eql(u8, token, self.expected_record.host_start_token))
            return error.HostIdentityMismatch;
    }

    fn exchange(
        self: *WireHostClient,
        stream: std.net.Stream,
        request_id: u64,
        request_type: u16,
        request_payload: []const u8,
        expected_type: u16,
        response_schema: []const u8,
    ) ![]u8 {
        try protocol.writeFrame(stream, .{
            .minor = generated.protocol_minor,
            .type_code = request_type,
            .flags = 0,
            .payload_length = @intCast(request_payload.len),
            .request_id = request_id,
            .stream_seq = 0,
        }, request_payload);
        const file: std.fs.File = .{ .handle = stream.handle };
        const read = try protocol.readFrame(self.allocator, file.deprecatedReader());
        const frame = switch (read) {
            .frame => |frame| frame,
            else => return error.InvalidHostResponse,
        };
        errdefer frame.deinit(self.allocator);
        if (frame.header.type_code == generated.frame_type.@"error")
            return error.HostRefused;
        if (frame.header.type_code != expected_type) return error.InvalidHostResponseType;
        if (frame.header.request_id != request_id) return error.InvalidHostResponseCorrelation;
        if (frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final))
            return error.InvalidHostResponseFlags;
        if (!protocol.validateControlPayload(self.allocator, response_schema, frame.payload))
            return error.InvalidHostResponsePayload;
        return frame.payload;
    }

    fn connect(self: *WireHostClient) !std.net.Stream {
        const before = try socketEvidence(self.directory);
        if (verifySocket(self.expected_socket, before) != null) return error.SocketSubstitution;
        const stream = try std.net.connectUnixSocket(self.socket_path);
        errdefer stream.close();
        try setTransportReadTimeout(stream.handle);
        const peer = try inspectPeer(stream.handle);
        try self.verifyPeer(&peer);
        const after = try socketEvidence(self.directory);
        if (verifyPostConnectSocket(self.expected_socket, before, after) != null)
            return error.SocketSubstitution;

        const hello = try std.json.Stringify.valueAlloc(self.allocator, .{
            .schemaVersion = @as(u8, 1),
            .buildId = self.broker_build_id,
            .instanceId = self.expected_record.locator.instance_id,
            .protocol = .{
                .major = generated.protocol_major,
                .minMinor = generated.protocol_minor,
                .maxMinor = generated.protocol_minor,
            },
            .clientRole = "broker",
        }, .{});
        defer self.allocator.free(hello);
        if (!protocol.validateControlPayload(self.allocator, generated.wire_schema.hello_payload, hello))
            return error.InvalidHostHello;
        const welcome_payload = try self.exchange(
            stream,
            1,
            generated.frame_type.hello,
            hello,
            generated.frame_type.welcome,
            generated.wire_schema.welcome_payload,
        );
        defer self.allocator.free(welcome_payload);
        var welcome = try std.json.parseFromSlice(WireWelcome, self.allocator, welcome_payload, .{
            .ignore_unknown_fields = true,
        });
        defer welcome.deinit();
        if (welcome.value.schemaVersion != 1 or
            welcome.value.protocol.major != generated.protocol_major or
            welcome.value.protocol.minor != generated.protocol_minor or
            !std.mem.eql(u8, welcome.value.instanceId, self.expected_record.locator.instance_id) or
            !std.mem.eql(u8, welcome.value.endpointRole, "host") or
            !std.mem.eql(u8, welcome.value.buildId, self.expected_record.executable_build_hash) or
            !equalOptionalString(welcome.value.engineBuildId, self.expected_record.locator.engine_build_id))
            return error.HostIdentityMismatch;
        return stream;
    }

    fn ownedLocator(self: *WireHostClient, disk: DiskLocator) !Locator {
        const parsed = try locatorFromDisk(disk);
        const arena = self.arena.allocator();
        return .{
            .instance_id = try arena.dupe(u8, parsed.instance_id),
            .session_id = try arena.dupe(u8, parsed.session_id),
            .generation = parsed.generation,
            .subject = switch (parsed.subject) {
                .root => .root,
                .agent => |agent_id| .{ .agent = try arena.dupe(u8, agent_id) },
            },
            .host_kind = parsed.host_kind,
            .engine_build_id = if (parsed.engine_build_id) |build|
                try arena.dupe(u8, build)
            else
                null,
        };
    }

    fn adopt(
        self: *WireHostClient,
        locator: Locator,
        secret: [32]u8,
        now_ns: u64,
    ) !AdoptionReadback {
        if (!sameLocator(locator, self.expected_record.locator)) return error.InvalidHostRequest;
        var payload_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer payload_arena.deinit();
        const secret_hex = std.fmt.bytesToHex(secret, .lower);
        const payload = try std.json.Stringify.valueAlloc(payload_arena.allocator(), .{
            .schemaVersion = @as(u8, 1),
            .adoptionSecretHex = &secret_hex,
            .expectedLocator = try locatorJsonValue(payload_arena.allocator(), locator),
            .brokerBuildId = self.broker_build_id,
            .protocol = .{ .major = generated.protocol_major, .minor = generated.protocol_minor },
            .operation = "adopt",
        }, .{});
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.host_adopt_payload,
            payload,
        )) return error.InvalidHostRequest;
        const stream = try self.connect();
        defer stream.close();
        const response = try self.exchange(
            stream,
            2,
            generated.frame_type.host_adopt,
            payload,
            generated.frame_type.host_adopt,
            generated.wire_schema.host_adopt_payload,
        );
        defer self.allocator.free(response);
        var parsed = try std.json.parseFromSlice(WireAdoptionReadback, self.allocator, response, .{});
        defer parsed.deinit();
        const arena = self.arena.allocator();
        return .{
            .locator = try self.ownedLocator(parsed.value.locator),
            .host_pid = parsed.value.hostPid,
            .host_start_token = try arena.dupe(u8, parsed.value.hostStartToken),
            .executable = try arena.dupe(u8, parsed.value.executable),
            .executable_build_hash = try arena.dupe(u8, parsed.value.executableBuildHash),
            .engine_build_id = try arena.dupe(u8, parsed.value.engineBuildId),
            .protocol_major = parsed.value.protocol.major,
            .protocol_minor = parsed.value.protocol.minor,
            .process_root = .{
                .pid = parsed.value.processRoot.pid,
                .start_token = try arena.dupe(u8, parsed.value.processRoot.startToken),
                .process_group_id = parsed.value.processRoot.processGroupId,
            },
            .output_seq = try std.fmt.parseInt(u64, parsed.value.outputSeq, 10),
            .checkpoint_seq = try std.fmt.parseInt(u64, parsed.value.checkpointSeq, 10),
            .visibility = .{
                .state = std.meta.stringToEnum(@FieldType(Visibility, "state"), parsed.value.visibility.state) orelse
                    return error.InvalidHostResponse,
                .workspace_session_id = try arena.dupe(u8, parsed.value.visibility.workspaceSessionId),
                .open_terminal_revision = try std.fmt.parseInt(
                    u64,
                    parsed.value.visibility.openTerminalRevision,
                    10,
                ),
                .expires_mono_ns = try wallExpiryToMonotonic(
                    parsed.value.visibility.expiresAt,
                    now_ns,
                    generated.limits.visibility_expiry_ms,
                ),
            },
        };
    }

    fn registerGrant(self: *WireHostClient, locator: Locator, grant: GrantRegistration) !bool {
        if (!sameLocator(locator, self.expected_record.locator) or
            grant.expires_mono_ns <= grant.registered_mono_ns)
            return error.InvalidHostRequest;
        var payload_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer payload_arena.deinit();
        const hash_hex = std.fmt.bytesToHex(grant.hash, .lower);
        var hash_storage: [71]u8 = undefined;
        const tagged_hash = try std.fmt.bufPrint(&hash_storage, "sha256:{s}", .{&hash_hex});
        var deadline_storage: [24]u8 = undefined;
        const deadline = try wallDeadline(
            &deadline_storage,
            (grant.expires_mono_ns - grant.registered_mono_ns) / std.time.ns_per_ms,
        );
        const payload = try std.json.Stringify.valueAlloc(payload_arena.allocator(), .{
            .schemaVersion = @as(u8, 1),
            .grantTokenSha256 = tagged_hash,
            .viewerId = grant.viewer_id,
            .operations = grant.operations,
            .expiresAt = deadline,
            .geometry = .{
                .columns = grant.geometry.columns,
                .rows = grant.geometry.rows,
                .widthPx = grant.geometry.width_px,
                .heightPx = grant.geometry.height_px,
                .cellWidthPx = grant.geometry.cell_width_px,
                .cellHeightPx = grant.geometry.cell_height_px,
            },
        }, .{});
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.grant_register_payload,
            payload,
        )) return error.InvalidHostRequest;
        const stream = try self.connect();
        defer stream.close();
        const response = try self.exchange(
            stream,
            2,
            generated.frame_type.grant_register,
            payload,
            generated.frame_type.grant_register,
            generated.wire_schema.grant_register_payload,
        );
        defer self.allocator.free(response);
        const Accepted = struct { schemaVersion: u8, registered: bool };
        var parsed = try std.json.parseFromSlice(Accepted, self.allocator, response, .{});
        defer parsed.deinit();
        return parsed.value.schemaVersion == 1 and parsed.value.registered;
    }

    fn terminate(
        self: *WireHostClient,
        locator: Locator,
        command: TerminationCommand,
    ) !TerminationReadback {
        if (!sameLocator(locator, self.expected_record.locator)) return error.InvalidHostRequest;
        var payload_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer payload_arena.deinit();
        const payload = try std.json.Stringify.valueAlloc(payload_arena.allocator(), .{
            .schemaVersion = @as(u8, 1),
            .locator = try locatorJsonValue(payload_arena.allocator(), locator),
            .mode = command.mode,
            .reason = command.reason,
            .requestId = command.request_id,
        }, .{});
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.terminate_payload,
            payload,
        )) return error.InvalidHostRequest;
        const stream = try self.connect();
        defer stream.close();
        const response = try self.exchange(
            stream,
            2,
            generated.frame_type.terminate,
            payload,
            generated.frame_type.terminated,
            generated.wire_schema.terminated_payload,
        );
        defer self.allocator.free(response);
        var parsed = try std.json.parseFromSlice(WireTerminationReadback, self.allocator, response, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        const response_locator = try locatorFromDisk(parsed.value.locator);
        if (!sameLocator(locator, response_locator)) return error.InvalidHostResponse;
        // TODO(WP4): map the real host's per-root exit and survivor evidence
        // into TerminationReadback without synthesizing proof from state alone.
        if (std.mem.eql(u8, parsed.value.state, "terminated") and
            parsed.value.survivors.len == 0 and parsed.value.errors.len == 0)
            return .{
                .pty_closed = true,
                .host_exited = true,
                .verification_complete = true,
                .survivor_count = 0,
            };
        if (std.mem.eql(u8, parsed.value.state, "survivors"))
            return .{
                .pty_closed = false,
                .host_exited = false,
                .verification_complete = true,
                .survivor_count = @max(parsed.value.survivors.len, 1),
            };
        return .{
            .pty_closed = false,
            .host_exited = false,
            .verification_complete = false,
            .survivor_count = parsed.value.survivors.len,
        };
    }

    fn adoptCallback(
        context: *anyopaque,
        locator: Locator,
        secret: [32]u8,
        now_ns: u64,
    ) ?AdoptionReadback {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.adopt(locator, secret, now_ns) catch |err| {
            std.log.err("host adoption wire failure: {s}", .{@errorName(err)});
            return null;
        };
    }

    fn registerGrantCallback(
        context: *anyopaque,
        locator: Locator,
        grant: GrantRegistration,
    ) bool {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.registerGrant(locator, grant) catch false;
    }

    fn terminateCallback(
        context: *anyopaque,
        locator: Locator,
        command: TerminationCommand,
    ) TerminationReadback {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.terminate(locator, command) catch .{
            .pty_closed = false,
            .host_exited = false,
            .verification_complete = false,
            .survivor_count = 0,
        };
    }
};

pub const RecoveryChannel = struct {
    host: HostControl,
    observed_socket: SocketEvidence,
};

pub const RecoveryConnector = struct {
    context: *anyopaque,
    connect_fn: *const fn (*anyopaque, std.fs.Dir, HostRecord, SocketEvidence) ?RecoveryChannel,

    pub fn connect(
        self: RecoveryConnector,
        directory: std.fs.Dir,
        record: HostRecord,
        expected_socket: SocketEvidence,
    ) ?RecoveryChannel {
        return self.connect_fn(self.context, directory, record, expected_socket);
    }
};

pub const WireRecoveryConnector = struct {
    allocator: std.mem.Allocator,
    canonical_home: []const u8,
    broker_build_id: []const u8,
    clients: [generated.limits.live_sessions_per_hive_home]?*WireHostClient = @splat(null),

    pub fn init(
        allocator: std.mem.Allocator,
        canonical_home: []const u8,
        broker_build_id: []const u8,
    ) WireRecoveryConnector {
        return .{
            .allocator = allocator,
            .canonical_home = canonical_home,
            .broker_build_id = broker_build_id,
        };
    }

    pub fn deinit(self: *WireRecoveryConnector) void {
        for (&self.clients) |*slot| if (slot.*) |client| {
            client.deinit();
            self.allocator.destroy(client);
            slot.* = null;
        };
    }

    pub fn connector(self: *WireRecoveryConnector) RecoveryConnector {
        return .{ .context = self, .connect_fn = connect };
    }

    fn connect(
        context: *anyopaque,
        directory: std.fs.Dir,
        record: HostRecord,
        expected_socket: SocketEvidence,
    ) ?RecoveryChannel {
        const self: *WireRecoveryConnector = @ptrCast(@alignCast(context));
        var available: ?*?*WireHostClient = null;
        for (&self.clients) |*slot| if (slot.* == null) {
            available = slot;
            break;
        };
        const slot = available orelse return null;
        const path = std.fs.path.join(self.allocator, &.{
            self.canonical_home,
            "runtime/sessiond/hosts",
            record.locator.session_id,
            "host.sock",
        }) catch return null;
        defer self.allocator.free(path);
        const client = self.allocator.create(WireHostClient) catch return null;
        client.* = WireHostClient.init(
            self.allocator,
            directory,
            path,
            expected_socket,
            record,
            self.broker_build_id,
        ) catch {
            self.allocator.destroy(client);
            return null;
        };
        slot.* = client;
        return .{
            .host = client.control(),
            .observed_socket = socketEvidence(directory) catch {
                client.deinit();
                self.allocator.destroy(client);
                slot.* = null;
                return null;
            },
        };
    }
};

pub const HostLaunchReadback = struct {
    record: HostRecord,
    record_json: []const u8,
    created_payload: []u8,
    host: HostControl,
};

pub const HostLauncher = struct {
    context: *anyopaque,
    launch_fn: *const fn (
        *anyopaque,
        std.mem.Allocator,
        []const u8,
        []const u8,
        []const u8,
        [32]u8,
    ) ?HostLaunchReadback,

    /// Starts the exact executable in host role and transfers spec, initial
    /// input, and the secret only over its inherited control fd.
    pub fn launch(
        self: HostLauncher,
        allocator: std.mem.Allocator,
        executable: []const u8,
        spec_json: []const u8,
        initial_input: []const u8,
        adoption_secret: [32]u8,
    ) ?HostLaunchReadback {
        return self.launch_fn(
            self.context,
            allocator,
            executable,
            spec_json,
            initial_input,
            adoption_secret,
        );
    }
};

const Grant = struct {
    hash: [32]u8,
    expires_mono_ns: u64,
    used: bool = false,
};

const Entry = struct {
    record: HostRecord,
    host: ?HostControl,
    quarantined: bool = false,
    grants: [generated.limits.viewers_per_generation]?Grant = @splat(null),
};

pub const Inspection = struct {
    locator: ?Locator,
    session_id: []const u8,
    presence: enum { present, exited, unknown },
    complete: bool,
    operator_attention: bool = false,
};

pub const ListResult = struct {
    entries: []Inspection,
    complete: bool,
};

pub const LookupResult = union(enum) {
    entry: *Entry,
    failure: protocol.Failure,
};

pub const Registry = struct {
    entries: [generated.limits.live_sessions_per_hive_home]?Entry = @splat(null),
    directory_quarantines: [generated.limits.live_sessions_per_hive_home]?DirectoryQuarantine = @splat(null),
    enumeration_complete: bool = true,

    pub fn hasCapacity(self: *const Registry) bool {
        for (&self.entries) |slot| if (slot == null) return true;
        return false;
    }

    pub fn register(self: *Registry, record: HostRecord, host: HostControl) ?protocol.Failure {
        if (record.state != .live)
            return .{ .code = .not_ready, .close_connection = false };
        if (self.lookup(record.locator)) |result| switch (result) {
            .entry => return .{ .code = .already_exists, .close_connection = false },
            .failure => |failure| if (failure.code != .not_found) return failure,
        };
        for (&self.entries) |*slot| if (slot.* == null) {
            slot.* = .{ .record = record, .host = host };
            return null;
        };
        return .{ .code = .capacity_exceeded, .close_connection = false };
    }

    pub fn lookup(self: *Registry, locator: Locator) ?LookupResult {
        for (&self.entries) |*slot| if (slot.*) |*entry| {
            if (!std.mem.eql(u8, entry.record.locator.session_id, locator.session_id)) continue;
            if (!std.mem.eql(u8, entry.record.locator.instance_id, locator.instance_id))
                return .{ .failure = .{ .code = .instance_mismatch, .close_connection = false } };
            if (entry.record.locator.generation != locator.generation)
                return .{ .failure = .{ .code = .generation_mismatch, .close_connection = false } };
            if (!sameLocator(entry.record.locator, locator))
                return .{ .failure = .{ .code = .generation_mismatch, .close_connection = false } };
            if (entry.quarantined)
                return .{ .failure = .{ .code = .verification_unknown, .close_connection = false } };
            return .{ .entry = entry };
        };
        return .{ .failure = .{ .code = .not_found, .close_connection = false } };
    }

    pub fn renewVisibility(
        self: *Registry,
        locator: Locator,
        workspace_session_id: []const u8,
        revision: u64,
        now_ns: u64,
    ) ?protocol.Failure {
        const result = self.lookup(locator) orelse return .{ .code = .not_found, .close_connection = false };
        const entry = switch (result) {
            .failure => |failure| return failure,
            .entry => |entry| entry,
        };
        if (entry.record.state != .live or entry.record.visibility.state == .expired or
            now_ns >= entry.record.visibility.expires_mono_ns)
            return .{ .code = .not_found, .close_connection = false };
        if (!std.mem.eql(u8, entry.record.visibility.workspace_session_id, workspace_session_id))
            return .{ .code = .forbidden, .close_connection = false };
        if (revision < entry.record.visibility.open_terminal_revision)
            return .{ .code = .generation_mismatch, .close_connection = false };
        const expires_mono_ns = std.math.add(
            u64,
            now_ns,
            generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
        ) catch return .{ .code = .resource_exhausted, .close_connection = false };
        entry.record.visibility.state = .visible;
        entry.record.visibility.open_terminal_revision = revision;
        entry.record.visibility.expires_mono_ns = expires_mono_ns;
        return null;
    }

    pub fn registerGrant(
        self: *Registry,
        locator: Locator,
        grant_hash: [32]u8,
        viewer_id: []const u8,
        operations: []const []const u8,
        geometry: Geometry,
        now_ns: u64,
    ) ?protocol.Failure {
        const result = self.lookup(locator) orelse return .{ .code = .not_found, .close_connection = false };
        const entry = switch (result) {
            .failure => |failure| return failure,
            .entry => |entry| entry,
        };
        if (entry.record.state != .live or entry.record.visibility.state == .expired or
            now_ns >= entry.record.visibility.expires_mono_ns)
            return .{ .code = .not_ready, .close_connection = false };
        const expires_ns = std.math.add(
            u64,
            now_ns,
            generated.limits.attach_grant_timeout_ms * std.time.ns_per_ms,
        ) catch return .{ .code = .resource_exhausted, .close_connection = false };
        for (&entry.grants) |*slot| if (slot.*) |*grant| {
            if (std.crypto.timing_safe.eql([32]u8, grant.hash, grant_hash) and grant.expires_mono_ns > now_ns)
                return .{ .code = .already_exists, .close_connection = false };
        };
        for (&entry.grants) |*slot| if (slot.* == null or slot.*.?.used or slot.*.?.expires_mono_ns <= now_ns) {
            if (!entry.host.?.registerGrant(locator, .{
                .hash = grant_hash,
                .viewer_id = viewer_id,
                .operations = operations,
                .geometry = geometry,
                .registered_mono_ns = now_ns,
                .expires_mono_ns = expires_ns,
            }))
                return .{ .code = .verification_unknown, .close_connection = false };
            slot.* = .{ .hash = grant_hash, .expires_mono_ns = expires_ns };
            return null;
        };
        return .{ .code = .capacity_exceeded, .close_connection = false };
    }

    pub fn consumeGrant(self: *Registry, locator: Locator, raw_token: []const u8, now_ns: u64) ?protocol.Failure {
        const result = self.lookup(locator) orelse return .{ .code = .not_found, .close_connection = false };
        const entry = switch (result) {
            .failure => |failure| return failure,
            .entry => |entry| entry,
        };
        if (entry.record.state != .live or entry.record.visibility.state == .expired or
            now_ns >= entry.record.visibility.expires_mono_ns)
            return .{ .code = .unauthenticated, .close_connection = true };
        var candidate: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(raw_token, &candidate, .{});
        for (&entry.grants) |*slot| if (slot.*) |*grant| {
            if (!std.crypto.timing_safe.eql([32]u8, grant.hash, candidate)) continue;
            if (grant.used or grant.expires_mono_ns <= now_ns)
                return .{ .code = .unauthenticated, .close_connection = true };
            grant.used = true;
            return null;
        };
        return .{ .code = .unauthenticated, .close_connection = true };
    }

    pub fn terminate(
        self: *Registry,
        locator: Locator,
        command: TerminationCommand,
    ) TerminationState {
        const result = self.lookup(locator) orelse return .unknown;
        const entry = switch (result) {
            .failure => return .unknown,
            .entry => |entry| entry,
        };
        const readback = entry.host.?.terminate(locator, command);
        if (readback.survivor_count != 0) return .survivors;
        if (!readback.verification_complete or !readback.pty_closed or !readback.host_exited) {
            entry.record.state = .unknown;
            return .unknown;
        }
        entry.record.state = .exited;
        return .terminated;
    }

    pub fn expireVisibility(self: *Registry, now_ns: u64) usize {
        var expired: usize = 0;
        for (&self.entries) |*slot| if (slot.*) |*entry| {
            if (entry.record.state != .live or entry.record.visibility.state == .expired or
                now_ns < entry.record.visibility.expires_mono_ns)
                continue;
            entry.record.visibility.state = .expired;
            var request_id_storage: [40]u8 = undefined;
            const request_id = taggedUuidV7(&request_id_storage, "req_") catch {
                entry.record.state = .unknown;
                continue;
            };
            _ = self.terminate(entry.record.locator, .{
                .mode = "graceful",
                .reason = "visibility lease expired",
                .request_id = request_id,
            });
            expired += 1;
        };
        return expired;
    }

    pub fn recoverCandidate(
        self: *Registry,
        record: HostRecord,
        adoption_secret: [32]u8,
        expected_socket: SocketEvidence,
        observed_socket: SocketEvidence,
        now_ns: u64,
        host: HostControl,
    ) ?protocol.Failure {
        if (verifySocket(expected_socket, observed_socket)) |failure| return self.quarantine(record, failure);
        const readback = host.adopt(record.locator, adoption_secret, now_ns) orelse
            return self.quarantine(record, .{ .code = .unauthenticated, .close_connection = true });
        if (!adoptionMatches(record, readback, now_ns))
            return self.quarantine(record, .{ .code = .verification_unknown, .close_connection = true });
        var adopted = record;
        adopted.visibility = readback.visibility;
        return self.register(adopted, host);
    }

    fn quarantine(self: *Registry, record: HostRecord, failure: protocol.Failure) protocol.Failure {
        self.enumeration_complete = false;
        for (&self.entries) |*slot| if (slot.* == null) {
            var unknown = record;
            unknown.state = .unknown;
            slot.* = .{ .record = unknown, .host = null, .quarantined = true };
            break;
        };
        return failure;
    }

    pub fn list(self: *Registry, instance_id: []const u8, output: []Inspection) ListResult {
        var count: usize = 0;
        var complete = self.enumeration_complete;
        for (&self.entries) |*slot| if (slot.*) |*entry| {
            if (!std.mem.eql(u8, entry.record.locator.instance_id, instance_id)) continue;
            if (count == output.len) {
                complete = false;
                break;
            }
            var directory_evidence: ?*DirectoryQuarantine = null;
            for (&self.directory_quarantines) |*directory_slot| if (directory_slot.*) |*candidate| {
                if (std.mem.eql(u8, candidate.session_id, entry.record.locator.session_id)) {
                    directory_evidence = candidate;
                    break;
                }
            };
            output[count] = .{
                .locator = entry.record.locator,
                .session_id = entry.record.locator.session_id,
                .presence = if (directory_evidence != null and
                    directory_evidence.?.final_evidence_sha256 != null)
                    .exited
                else if (entry.quarantined or entry.record.state == .unknown)
                    .unknown
                else if (entry.record.state == .exited)
                    .exited
                else
                    .present,
                .complete = !entry.quarantined and entry.record.state != .unknown,
                .operator_attention = if (directory_evidence) |evidence|
                    evidence.final_state != .terminated or evidence.survivor_count != 0
                else
                    entry.quarantined or entry.record.state == .unknown,
            };
            if (!output[count].complete) complete = false;
            count += 1;
        };
        for (&self.directory_quarantines) |*slot| if (slot.*) |*directory_quarantine| {
            var duplicates_parsed_entry = false;
            for (&self.entries) |entry_slot| if (entry_slot) |entry| {
                if (std.mem.eql(u8, entry.record.locator.session_id, directory_quarantine.session_id)) {
                    duplicates_parsed_entry = true;
                    break;
                }
            };
            if (duplicates_parsed_entry) continue;
            if (count == output.len) {
                complete = false;
                break;
            }
            output[count] = .{
                .locator = null,
                .session_id = directory_quarantine.session_id,
                .presence = if (directory_quarantine.final_evidence_sha256 == null) .unknown else .exited,
                .complete = false,
                .operator_attention = directory_quarantine.final_state != .terminated or
                    directory_quarantine.survivor_count != 0,
            };
            complete = false;
            count += 1;
        };
        return .{ .entries = output[0..count], .complete = complete };
    }

    fn quarantineDirectory(self: *Registry, session_id: []const u8, verify_after_ns: u64) void {
        self.enumeration_complete = false;
        for (&self.directory_quarantines) |*slot| {
            if (slot.*) |*existing| {
                if (std.mem.eql(u8, existing.session_id, session_id)) return;
                continue;
            }
            slot.* = .{ .session_id = session_id, .verify_after_ns = verify_after_ns };
            return;
        }
    }
};

const DirectoryQuarantine = struct {
    const FinalState = enum { terminated, survivors, unknown };

    session_id: []const u8,
    verify_after_ns: u64,
    final_evidence_sha256: ?[32]u8 = null,
    final_state: ?FinalState = null,
    survivor_count: usize = 0,
};

const host_graceful_stop_bound_ms: u64 = 2 * std.time.ms_per_s + 2 * std.time.ms_per_s;

pub fn quarantineVerificationDelayNs() u64 {
    return (generated.limits.visibility_expiry_ms + host_graceful_stop_bound_ms) * std.time.ns_per_ms;
}

pub const RecoveredRegistry = struct {
    arena: std.heap.ArenaAllocator,
    registry: Registry = .{ .enumeration_complete = false },

    pub fn init(allocator: std.mem.Allocator) RecoveredRegistry {
        return .{ .arena = std.heap.ArenaAllocator.init(allocator) };
    }

    pub fn deinit(self: *RecoveredRegistry) void {
        self.arena.deinit();
    }

    pub fn recover(
        self: *RecoveredRegistry,
        runtime: *Runtime,
        now_ns: u64,
        connector: RecoveryConnector,
    ) !void {
        self.registry.enumeration_complete = true;
        var hosts = try runtime.directory.openDir("hosts", .{ .no_follow = true, .iterate = true });
        defer hosts.close();
        var iterator = hosts.iterate();
        while (try iterator.next()) |entry| {
            if (entry.kind != .directory) {
                self.registry.enumeration_complete = false;
                continue;
            }
            const owned_name = try self.arena.allocator().dupe(u8, entry.name);
            if (!protocol.validSessionId(entry.name)) {
                try self.addDirectoryQuarantine(owned_name, now_ns);
                continue;
            }
            self.recoverOne(runtime, entry.name, now_ns, connector) catch {
                try self.addDirectoryQuarantine(owned_name, now_ns);
            };
        }
    }

    fn addDirectoryQuarantine(self: *RecoveredRegistry, session_id: []const u8, now_ns: u64) !void {
        const verify_after_ns = try std.math.add(
            u64,
            now_ns,
            quarantineVerificationDelayNs(),
        );
        self.registry.quarantineDirectory(session_id, verify_after_ns);
    }

    /// §21 crash invariant: an unparseable host receives no renewals and must
    /// self-terminate on its own lease. The broker verifies final.json after
    /// the lease plus graceful-stop bound; absence remains explicit unknown.
    pub fn verifyDirectoryQuarantines(
        self: *RecoveredRegistry,
        runtime: *Runtime,
        now_ns: u64,
    ) void {
        for (&self.registry.directory_quarantines) |*slot| if (slot.*) |*directory_quarantine| {
            if (directory_quarantine.final_evidence_sha256 != null or now_ns < directory_quarantine.verify_after_ns)
                continue;
            var hosts = runtime.directory.openDir("hosts", .{ .no_follow = true }) catch continue;
            defer hosts.close();
            var directory = hosts.openDir(directory_quarantine.session_id, .{ .no_follow = true }) catch continue;
            defer directory.close();
            const directory_stat = std.posix.fstat(directory.fd) catch continue;
            if (directory_stat.uid != std.posix.getuid() or
                directory_stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR or
                directory_stat.mode & 0o777 != 0o700)
                continue;
            const stat = std.posix.fstatat(
                directory.fd,
                "final.json",
                std.posix.AT.SYMLINK_NOFOLLOW,
            ) catch continue;
            if (stat.uid != std.posix.getuid() or stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
                stat.mode & 0o777 != 0o600)
                continue;
            const contents = readOwnedFileAt(
                self.arena.allocator(),
                directory,
                "final.json",
                generated.limits.control_json_bytes,
            ) catch continue;
            var parsed = std.json.parseFromSlice(
                std.json.Value,
                self.arena.allocator(),
                contents,
                .{},
            ) catch continue;
            defer parsed.deinit();
            const object = switch (parsed.value) {
                .object => |object| object,
                else => continue,
            };
            const state = object.get("state") orelse continue;
            const survivors = object.get("survivors") orelse continue;
            if (state != .string or survivors != .array) continue;
            if (!std.mem.eql(u8, state.string, "terminated") and
                !std.mem.eql(u8, state.string, "survivors") and
                !std.mem.eql(u8, state.string, "unknown"))
                continue;
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(contents, &digest, .{});
            directory_quarantine.final_evidence_sha256 = digest;
            directory_quarantine.final_state = std.meta.stringToEnum(
                DirectoryQuarantine.FinalState,
                state.string,
            ).?;
            directory_quarantine.survivor_count = survivors.array.items.len;
        };
    }

    fn recoverOne(
        self: *RecoveredRegistry,
        runtime: *Runtime,
        session_id: []const u8,
        now_ns: u64,
        connector: RecoveryConnector,
    ) !void {
        const allocator = self.arena.allocator();
        var directory = try runtime.openHostDirectory(session_id, false);
        defer directory.close();
        const record_json = try readOwnedFileAt(
            allocator,
            directory,
            "record.json",
            generated.limits.control_json_bytes,
        );
        if (!protocol.validateControlPayload(allocator, generated.wire_schema.host_record_v1, record_json))
            return error.InvalidHostRecord;
        const disk = try std.json.parseFromSliceLeaky(DiskHostRecord, allocator, record_json, .{
            .ignore_unknown_fields = true,
        });
        const record = try hostRecordFromDisk(disk);
        if (!std.mem.eql(u8, record.locator.session_id, session_id)) return error.InvalidHostRecord;
        if (record.state != .live) return error.InvalidHostRecord;
        const expected_socket = try socketEvidence(directory);
        const secret = try readAdoptionSecret(directory);
        const channel = connector.connect(directory, record, expected_socket) orelse {
            _ = self.registry.quarantine(
                record,
                .{ .code = .verification_unknown, .close_connection = true },
            );
            return error.RecoveryQuarantined;
        };
        if (self.registry.recoverCandidate(
            record,
            secret,
            expected_socket,
            channel.observed_socket,
            now_ns,
            channel.host,
        ) != null) return error.RecoveryQuarantined;
    }
};

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
        sameLocator(disk_locator, record.locator) and
        std.mem.eql(u8, value.hostStartToken, record.host_start_token) and
        std.mem.eql(u8, value.processRoot.startToken, record.process_root.start_token) and
        std.mem.eql(u8, value.expectedExecutable, record.expected_executable) and
        std.mem.eql(u8, value.executableBuildHash, record.executable_build_hash) and
        std.mem.eql(u8, value.engineBuildId, record.engine_build_id) and
        std.mem.eql(u8, value.state, @tagName(record.state)) and
        std.mem.eql(u8, value.visibility.state, @tagName(record.visibility.state)) and
        std.mem.eql(u8, value.visibility.workspaceSessionId, record.visibility.workspace_session_id) and
        (std.fmt.parseInt(u64, value.visibility.openTerminalRevision, 10) catch return false) ==
            record.visibility.open_terminal_revision and
        (std.fmt.parseInt(u64, value.outputSeq, 10) catch return false) == record.output_seq and
        (std.fmt.parseInt(u64, value.checkpointSeq, 10) catch return false) == record.checkpoint_seq;
}

pub fn launchHost(
    allocator: std.mem.Allocator,
    runtime: *Runtime,
    registry: *Registry,
    session_id: []const u8,
    spec_json: []const u8,
    initial_input: []const u8,
    committed_sha256: [32]u8,
    now_ns: u64,
    launcher: HostLauncher,
) !struct { failure: ?protocol.Failure, created_payload: ?[]u8 } {
    if (!protocol.validateControlPayload(allocator, generated.wire_schema.create_begin_payload, spec_json))
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = false }, .created_payload = null };
    const VisibilityBinding = struct { workspaceSessionId: []const u8, openTerminalRevision: []const u8 };
    const SpecProjection = struct { locator: DiskLocator, visibility: VisibilityBinding };
    var spec = std.json.parseFromSlice(SpecProjection, allocator, spec_json, .{
        .ignore_unknown_fields = true,
    }) catch return .{
        .failure = .{ .code = .malformed_frame, .close_connection = false },
        .created_payload = null,
    };
    defer spec.deinit();
    const expected_locator = locatorFromDisk(spec.value.locator) catch return .{
        .failure = .{ .code = .malformed_frame, .close_connection = false },
        .created_payload = null,
    };
    if (!std.mem.eql(u8, spec.value.locator.sessionId, session_id))
        return .{ .failure = .{ .code = .generation_mismatch, .close_connection = false }, .created_payload = null };
    const initial_revision = std.fmt.parseInt(u64, spec.value.visibility.openTerminalRevision, 10) catch
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = false }, .created_payload = null };
    if (initial_revision == 0)
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = false }, .created_payload = null };
    const attaching_expiry = std.math.add(
        u64,
        now_ns,
        generated.limits.attach_grant_timeout_ms * std.time.ns_per_ms,
    ) catch return .{
        .failure = .{ .code = .resource_exhausted, .close_connection = false },
        .created_payload = null,
    };
    if (initial_input.len > generated.limits.automated_message_bytes)
        return .{ .failure = .{ .code = .payload_too_large, .close_connection = false }, .created_payload = null };
    var actual_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(initial_input, &actual_digest, .{});
    if (!std.crypto.timing_safe.eql([32]u8, actual_digest, committed_sha256))
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = false }, .created_payload = null };
    if (!registry.hasCapacity())
        return .{ .failure = .{ .code = .capacity_exceeded, .close_connection = false }, .created_payload = null };

    var host_directory = runtime.openHostDirectory(session_id, true) catch |err| switch (err) {
        error.HostAlreadyExists => return .{ .failure = .{ .code = .already_exists, .close_connection = false }, .created_payload = null },
        else => return err,
    };
    defer host_directory.close();
    const adoption_secret = try createAdoptionSecret(host_directory);
    const executable = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(executable);
    const readback = launcher.launch(
        allocator,
        executable,
        spec_json,
        initial_input,
        adoption_secret,
    ) orelse return .{
        .failure = .{ .code = .verification_unknown, .close_connection = false },
        .created_payload = null,
    };
    var retain_created_payload = false;
    defer if (!retain_created_payload) allocator.free(readback.created_payload);
    if (!sameLocator(readback.record.locator, expected_locator))
        return .{ .failure = .{ .code = .generation_mismatch, .close_connection = false }, .created_payload = null };
    if (readback.record.state != .live or readback.record.visibility.state != .attaching or
        !std.mem.eql(
            u8,
            readback.record.visibility.workspace_session_id,
            spec.value.visibility.workspaceSessionId,
        ) or
        readback.record.visibility.open_terminal_revision != initial_revision or
        readback.record.visibility.expires_mono_ns != attaching_expiry)
        return .{ .failure = .{ .code = .verification_unknown, .close_connection = false }, .created_payload = null };
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.created_payload,
        readback.created_payload,
    )) return .{ .failure = .{ .code = .verification_unknown, .close_connection = false }, .created_payload = null };
    if (!recordJsonMatches(allocator, readback.record, readback.record_json))
        return .{ .failure = .{ .code = .verification_unknown, .close_connection = false }, .created_payload = null };
    try writeRecordAtomic(allocator, host_directory, readback.record_json);
    if (registry.register(readback.record, readback.host)) |failure|
        return .{ .failure = failure, .created_payload = null };
    retain_created_payload = true;
    return .{ .failure = null, .created_payload = readback.created_payload };
}

pub const BackendResult = union(enum) {
    no_response,
    response: []u8,
    failure: protocol.Failure,
};

pub const BrokerBackend = struct {
    context: *anyopaque,
    call_fn: *const fn (*anyopaque, std.mem.Allocator, u16, []const u8) BackendResult,

    pub fn call(
        self: BrokerBackend,
        allocator: std.mem.Allocator,
        type_code: u16,
        payload: []const u8,
    ) BackendResult {
        return self.call_fn(self.context, allocator, type_code, payload);
    }
};

pub const DispatchResponse = struct {
    header: protocol.Header,
    payload: []u8,

    pub fn deinit(self: DispatchResponse, allocator: std.mem.Allocator) void {
        allocator.free(self.payload);
    }
};

pub const DispatchResult = union(enum) {
    no_response,
    response: DispatchResponse,
    failure: protocol.Failure,
};

pub fn requestSchema(type_code: u16) ?[]const u8 {
    return switch (type_code) {
        generated.frame_type.create_begin => generated.wire_schema.create_begin_payload,
        generated.frame_type.create_commit => generated.wire_schema.create_commit_payload,
        generated.frame_type.list => generated.wire_schema.list_payload,
        generated.frame_type.inspect => generated.wire_schema.inspect_payload,
        generated.frame_type.terminate => generated.wire_schema.terminate_payload,
        generated.frame_type.visibility_renew => generated.wire_schema.visibility_renew_payload,
        generated.frame_type.attach_request => generated.wire_schema.attach_request_payload,
        else => null,
    };
}

pub fn responseSchema(type_code: u16) ?[]const u8 {
    return switch (type_code) {
        generated.frame_type.created => generated.wire_schema.created_payload,
        generated.frame_type.listed => generated.wire_schema.listed_payload,
        generated.frame_type.inspected => generated.wire_schema.inspected_payload,
        generated.frame_type.terminated => generated.wire_schema.terminated_payload,
        generated.frame_type.renewed => generated.wire_schema.renewed_payload,
        generated.frame_type.attach_grant => generated.wire_schema.attach_grant_payload,
        else => null,
    };
}

fn expectedResponseType(type_code: u16) ?u16 {
    return switch (type_code) {
        generated.frame_type.create_commit => generated.frame_type.created,
        generated.frame_type.list => generated.frame_type.listed,
        generated.frame_type.inspect => generated.frame_type.inspected,
        generated.frame_type.terminate => generated.frame_type.terminated,
        generated.frame_type.visibility_renew => generated.frame_type.renewed,
        generated.frame_type.attach_request => generated.frame_type.attach_grant,
        else => null,
    };
}

fn responseHeader(request: protocol.Header, type_code: u16, payload_len: usize) protocol.Header {
    return .{
        .minor = request.minor,
        .type_code = type_code,
        .flags = generated.frame_flag.response | generated.frame_flag.final,
        .payload_length = @intCast(payload_len),
        .request_id = request.request_id,
        .stream_seq = 0,
    };
}

/// Validates every daemon→broker v1 request against the generated strict
/// projection before invoking lifecycle state. Raw CREATE_INPUT is the one
/// broker request whose bytes intentionally bypass JSON parsing.
pub fn dispatchFrame(
    allocator: std.mem.Allocator,
    frame: protocol.Frame,
    now_ns: u64,
    backend: BrokerBackend,
) DispatchResult {
    if (frame.header.flags & (generated.frame_flag.response | generated.frame_flag.error_flag) != 0)
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = true } };

    if (frame.header.type_code == generated.frame_type.ping) {
        if (protocol.decodePingPong(allocator, frame.payload) == null)
            return .{ .failure = .{ .code = .malformed_frame, .close_connection = false } };
        var storage: [96]u8 = undefined;
        const encoded = protocol.encodePingPong(&storage, now_ns) catch
            return .{ .failure = .{ .code = .internal, .close_connection = false } };
        const payload = allocator.dupe(u8, encoded) catch
            return .{ .failure = .{ .code = .resource_exhausted, .close_connection = false } };
        return .{ .response = .{
            .header = responseHeader(frame.header, generated.frame_type.pong, payload.len),
            .payload = payload,
        } };
    }
    if (frame.header.type_code == generated.frame_type.pong) return .no_response;

    const is_create_input = frame.header.type_code == generated.frame_type.create_input;
    const schema = requestSchema(frame.header.type_code);
    if (!is_create_input and schema == null)
        return .{ .failure = .{ .code = .unsupported_frame, .close_connection = false } };
    if (schema) |name| if (!protocol.validateControlPayload(allocator, name, frame.payload))
        return .{ .failure = .{ .code = .malformed_frame, .close_connection = false } };

    const backend_result = backend.call(allocator, frame.header.type_code, frame.payload);
    const response_type = expectedResponseType(frame.header.type_code);
    return switch (backend_result) {
        .failure => |failure| .{ .failure = failure },
        .no_response => if (response_type == null)
            .no_response
        else
            .{ .failure = .{ .code = .internal, .close_connection = false } },
        .response => |payload| blk: {
            const type_code = response_type orelse {
                allocator.free(payload);
                break :blk .{ .failure = .{ .code = .internal, .close_connection = false } };
            };
            const response_schema = responseSchema(type_code).?;
            if (!protocol.validateControlPayload(allocator, response_schema, payload)) {
                allocator.free(payload);
                break :blk .{ .failure = .{ .code = .internal, .close_connection = false } };
            }
            break :blk .{ .response = .{
                .header = responseHeader(frame.header, type_code, payload.len),
                .payload = payload,
            } };
        },
    };
}

fn executableBuildId(allocator: std.mem.Allocator) ![]u8 {
    const path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(path);
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

fn writeWelcome(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    instance_id: []const u8,
    build_id: []const u8,
    server_epoch: u64,
    selected_minor: u8,
) !void {
    var connection_storage: [32]u8 = undefined;
    var epoch_storage: [32]u8 = undefined;
    const connection_id = try std.fmt.bufPrint(&connection_storage, "{d}", .{std.crypto.random.int(u64)});
    const epoch = try std.fmt.bufPrint(&epoch_storage, "{d}", .{server_epoch});
    const welcome = .{
        .schemaVersion = @as(u8, 1),
        .protocol = .{ .major = generated.protocol_major, .minor = selected_minor },
        .instanceId = instance_id,
        .endpointRole = "broker",
        .buildId = build_id,
        .engineBuildId = @as(?[]const u8, null),
        .connectionId = connection_id,
        .serverEpoch = epoch,
        .limits = .{
            .controlFrameMaxBytes = generated.limits.control_json_bytes,
            .streamChunkMaxBytes = generated.limits.stream_chunk_bytes,
            .automatedMessageMaxBytes = generated.limits.automated_message_bytes,
            .viewerQueueMaxBytes = generated.limits.viewer_queue_bytes,
        },
    };
    const payload = try std.json.Stringify.valueAlloc(allocator, welcome, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(allocator, generated.wire_schema.welcome_payload, payload))
        return error.InvalidWelcome;
    var header = responseHeader(request, generated.frame_type.welcome, payload.len);
    header.minor = selected_minor;
    try protocol.writeFrame(stream, header, payload);
}

fn writeFailure(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    failure: protocol.Failure,
) !void {
    var code_storage: [64]u8 = undefined;
    const tag = @tagName(failure.code);
    const code = std.ascii.upperString(code_storage[0..tag.len], tag);
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .code = code,
        .message = tag,
        .diagnosticId = @as(?[]const u8, null),
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(allocator, generated.wire_schema.error_payload, payload))
        return error.InvalidErrorPayload;
    const header: protocol.Header = .{
        .minor = if (protocol.minorSupported(request.minor)) request.minor else generated.protocol_max_minor,
        .type_code = generated.frame_type.@"error",
        .flags = generated.frame_flag.response | generated.frame_flag.final | generated.frame_flag.error_flag,
        .payload_length = @intCast(payload.len),
        .request_id = request.request_id,
        .stream_seq = 0,
    };
    try protocol.writeFrame(stream, header, payload);
}

fn validPong(
    allocator: std.mem.Allocator,
    frame: protocol.Frame,
    outstanding_request_id: ?u64,
) bool {
    return outstanding_request_id != null and
        frame.header.request_id == outstanding_request_id.? and
        frame.header.flags == (generated.frame_flag.response | generated.frame_flag.final) and
        protocol.decodePingPong(allocator, frame.payload) != null;
}

fn serveDaemonConnection(
    allocator: std.mem.Allocator,
    runtime: *Runtime,
    stream: std.net.Stream,
    observed: *const ObservedPeer,
    build_id: []const u8,
    timer: *std.time.Timer,
    backend: BrokerBackend,
) !void {
    try setTransportReadTimeout(stream.handle);
    const file: std.fs.File = .{ .handle = stream.handle };
    const reader = file.deprecatedReader();
    const first = try protocol.readFrame(allocator, reader);
    const hello_frame = switch (first) {
        .frame => |frame| frame,
        .failure => |failure| {
            // Bad magic has no correlatable v1 header, so a zero id intentionally gets a bare FIN.
            if (failure.request_id != 0) try writeFailure(allocator, stream, .{
                .minor = generated.protocol_max_minor,
                .type_code = generated.frame_type.hello,
                .flags = 0,
                .payload_length = 0,
                .request_id = failure.request_id,
                .stream_seq = 0,
            }, failure);
            return;
        },
        .ignored_optional => return,
    };
    defer hello_frame.deinit(allocator);
    var handshake_state: protocol.Handshake = .{};
    if (handshake_state.accept(hello_frame.header)) |failure| {
        try writeFailure(allocator, stream, hello_frame.header, failure);
        return;
    }

    var hello = parseDaemonHello(allocator, hello_frame.payload) catch {
        try writeFailure(allocator, stream, hello_frame.header, .{
            .code = .malformed_frame,
            .close_connection = true,
        });
        return;
    };
    defer hello.deinit();
    const selected_minor = selectProtocolMinor(hello.value.protocol) orelse {
        try writeFailure(allocator, stream, hello_frame.header, .{
            .code = .protocol_mismatch,
            .close_connection = true,
        });
        return;
    };
    var daemon_lock = try loadDaemonLock(allocator, runtime.canonical_home);
    defer daemon_lock.deinit();
    var daemon_handshake = try loadDaemonHandshake(allocator, runtime.canonical_home);
    defer daemon_handshake.deinit();
    if (!std.mem.eql(u8, daemon_lock.value.instanceId, daemon_handshake.value.instanceId))
        return error.DaemonEvidenceMismatch;
    const peer_failure = verifyDaemonPeer(observed, .{
        .uid = std.posix.getuid(),
        .gid = @intCast(c.getgid()),
        .pid = daemon_lock.value.pid,
        .start_token = daemon_lock.value.startToken,
        .executable = daemon_lock.value.executablePath,
    }, .{
        .product = true,
        .build = true,
        .protocol = true,
        .schema = true,
        .instance = true,
        .project = true,
    });
    if (peer_failure) |failure| {
        try writeFailure(allocator, stream, hello_frame.header, failure);
        return;
    }
    if (verifyDaemonHello(hello.value, daemon_handshake.value)) |failure| {
        try writeFailure(allocator, stream, hello_frame.header, failure);
        return;
    }
    try writeWelcome(
        allocator,
        stream,
        hello_frame.header,
        daemon_handshake.value.instanceId,
        build_id,
        timer.read(),
        selected_minor,
    );

    var liveness: protocol.Liveness = .{ .last_activity_ns = timer.read() };
    var outstanding_ping: ?u64 = null;
    var next_ping_request_id: u64 = 1;
    while (true) {
        var poll_fds = [_]std.posix.pollfd{.{
            .fd = stream.handle,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        const ready = try std.posix.poll(&poll_fds, @intCast(generated.limits.connection_ping_interval_ms));
        if (ready == 0) {
            const now_ns = timer.read();
            if (!liveness.pingDue(now_ns)) continue;
            var payload_storage: [96]u8 = undefined;
            const payload = try protocol.encodePingPong(&payload_storage, now_ns);
            try protocol.writeFrame(stream, .{
                .minor = selected_minor,
                .type_code = generated.frame_type.ping,
                .flags = 0,
                .payload_length = @intCast(payload.len),
                .request_id = next_ping_request_id,
                .stream_seq = 0,
            }, payload);
            outstanding_ping = next_ping_request_id;
            next_ping_request_id +%= 1;
            if (next_ping_request_id == 0) next_ping_request_id = 1;
            liveness.sentPing(now_ns);
            if (liveness.shouldDetach()) return;
            continue;
        }
        if (poll_fds[0].revents & std.posix.POLL.IN == 0) return;

        const read = protocol.readFrameForRange(
            allocator,
            reader,
            selected_minor,
            selected_minor,
        ) catch return;
        switch (read) {
            .failure => |failure| {
                if (failure.request_id != 0) try writeFailure(allocator, stream, .{
                    .minor = selected_minor,
                    .type_code = generated.frame_type.@"error",
                    .flags = 0,
                    .payload_length = 0,
                    .request_id = failure.request_id,
                    .stream_seq = 0,
                }, failure);
                if (failure.close_connection) return;
            },
            .ignored_optional => continue,
            .frame => |frame| {
                defer frame.deinit(allocator);
                const now_ns = timer.read();
                if (frame.header.type_code == generated.frame_type.pong) {
                    if (!validPong(allocator, frame, outstanding_ping)) {
                        try writeFailure(allocator, stream, frame.header, .{
                            .code = .malformed_frame,
                            .close_connection = true,
                        });
                        return;
                    }
                    outstanding_ping = null;
                    liveness.receivedPong(now_ns);
                    continue;
                }
                if (liveness.unanswered_pings == 0) liveness.last_activity_ns = now_ns;
                const result = dispatchFrame(allocator, frame, now_ns, backend);
                switch (result) {
                    .no_response => {},
                    .response => |response| {
                        defer response.deinit(allocator);
                        try protocol.writeFrame(stream, response.header, response.payload);
                    },
                    .failure => |failure| {
                        try writeFailure(allocator, stream, frame.header, failure);
                        if (failure.close_connection) return;
                    },
                }
            },
        }
    }
}

const StartupBackend = struct {
    fn backend(self: *StartupBackend) BrokerBackend {
        return .{ .context = self, .call_fn = call };
    }

    fn call(context: *anyopaque, allocator: std.mem.Allocator, type_code: u16, payload: []const u8) BackendResult {
        _ = context;
        _ = payload;
        if (type_code == generated.frame_type.list) {
            const listed = allocator.dupe(u8, "{\"schemaVersion\":1,\"entries\":[],\"complete\":false}") catch
                return .{ .failure = .{ .code = .resource_exhausted, .close_connection = false } };
            return .{ .response = listed };
        }
        if (type_code == generated.frame_type.create_begin or
            type_code == generated.frame_type.create_input or
            type_code == generated.frame_type.create_commit)
            return .{ .failure = .{ .code = .not_ready, .close_connection = false } };
        return .{ .failure = .{
            .code = .not_found,
            .close_connection = false,
        } };
    }
};

/// Runs the shipped broker role. WP4 replaces only the host side of the
/// lifecycle transport; this process never opens or retains a PTY master.
pub fn serve(allocator: std.mem.Allocator, hive_home: []const u8) !void {
    var runtime = try Runtime.open(allocator, hive_home);
    defer runtime.deinit();
    const build_id = try executableBuildId(allocator);
    defer allocator.free(build_id);
    var timer = try std.time.Timer.start();
    var recovered = RecoveredRegistry.init(allocator);
    defer recovered.deinit();
    var recovery_wire = WireRecoveryConnector.init(allocator, runtime.canonical_home, build_id);
    defer recovery_wire.deinit();
    try recovered.recover(&runtime, timer.read(), recovery_wire.connector());
    var backend: StartupBackend = .{};
    while (true) {
        var poll_fds = [_]std.posix.pollfd{.{
            .fd = runtime.server.stream.handle,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        const ready = try std.posix.poll(
            &poll_fds,
            @intCast(generated.limits.visibility_renewal_ms),
        );
        recovered.verifyDirectoryQuarantines(&runtime, timer.read());
        if (ready == 0) continue;
        if (poll_fds[0].revents & std.posix.POLL.IN == 0) return error.BrokerSocketUnavailable;
        var accepted = runtime.acceptAuthenticatedPeer() catch |err| switch (err) {
            error.SocketSubstitution => {
                std.log.err("broker socket substitution detected; refusing further service", .{});
                return err;
            },
            else => {
                std.log.err("broker accept failed closed: {s}", .{@errorName(err)});
                continue;
            },
        };
        defer accepted.stream.close();
        serveDaemonConnection(
            allocator,
            &runtime,
            accepted.stream,
            &accepted.peer,
            build_id,
            &timer,
            backend.backend(),
        ) catch continue;
    }
}

fn adoptionMatches(record: HostRecord, readback: AdoptionReadback, now_ns: u64) bool {
    return sameLocator(record.locator, readback.locator) and
        record.host_pid == readback.host_pid and
        std.mem.eql(u8, record.host_start_token, readback.host_start_token) and
        std.mem.eql(u8, record.expected_executable, readback.executable) and
        std.mem.eql(u8, record.executable_build_hash, readback.executable_build_hash) and
        std.mem.eql(u8, record.engine_build_id, readback.engine_build_id) and
        record.protocol_major == readback.protocol_major and record.protocol_minor == readback.protocol_minor and
        record.process_root.pid == readback.process_root.pid and
        record.process_root.process_group_id == readback.process_root.process_group_id and
        std.mem.eql(u8, record.process_root.start_token, readback.process_root.start_token) and
        record.output_seq == readback.output_seq and record.checkpoint_seq == readback.checkpoint_seq and
        std.mem.eql(u8, record.visibility.workspace_session_id, readback.visibility.workspace_session_id) and
        record.visibility.open_terminal_revision == readback.visibility.open_terminal_revision and
        readback.visibility.state != .expired and readback.visibility.expires_mono_ns > now_ns;
}

test "daemon claims never override kernel identity" {
    var observed: ObservedPeer = .{
        .uid = 501,
        .gid = 20,
        .pid = 42,
        .start_token = .{ .seconds = 10, .microseconds = 2 },
        .executable = @splat(0),
        .executable_len = 4,
    };
    @memcpy(observed.executable[0..4], "hive");
    const claims: DaemonClaimChecks = .{ .product = true, .build = true, .protocol = true, .schema = true, .instance = true, .project = true };
    try std.testing.expect(verifyDaemonPeer(&observed, .{
        .uid = 501,
        .gid = 20,
        .pid = 42,
        .start_token = "11:2",
        .executable = "hive",
    }, claims).?.code == .unauthenticated);
}

test "daemon HELLO matches all six existing handshake identities" {
    const payload =
        \\{"schemaVersion":1,"buildId":"daemon-build","instanceId":"instance-a","protocol":{"major":1,"minMinor":0,"maxMinor":0},"clientRole":"daemon","daemonControl":{"productVersion":"0.0.0-dev","buildHash":"daemon-build","wireProtocol":{"min":1,"max":1},"schemaEpoch":1,"instanceId":"instance-a","hiveUuid":"hive-a","identityKey":"project-a","repoFamilyKey":null}}
    ;
    var hello = try parseDaemonHello(std.testing.allocator, payload);
    defer hello.deinit();
    const expected: DaemonHandshake = .{
        .productVersion = "0.0.0-dev",
        .buildHash = "daemon-build",
        .wireProtocol = .{ .min = 1, .max = 1 },
        .schemaEpoch = 1,
        .capabilities = &.{"daemon-handshake-v1"},
        .instanceId = "instance-a",
        .hiveUuid = "hive-a",
        .identityKey = "project-a",
        .repoFamilyKey = null,
        .generation = 1,
    };
    try std.testing.expect(verifyDaemonHello(hello.value, expected) == null);
    hello.value.daemonControl.identityKey = "project-b";
    try std.testing.expectEqual(protocol.WireError.forbidden, verifyDaemonHello(hello.value, expected).?.code);
    hello.value.daemonControl.identityKey = "project-a";
    hello.value.daemonControl.schemaEpoch = 2;
    try std.testing.expectEqual(protocol.WireError.protocol_mismatch, verifyDaemonHello(hello.value, expected).?.code);
    try std.testing.expect(selectProtocolMinor(.{
        .major = generated.protocol_major,
        .minMinor = generated.protocol_max_minor + 1,
        .maxMinor = generated.protocol_max_minor + 1,
    }) == null);
}

const TestBackend = struct {
    calls: usize = 0,

    fn backend(self: *TestBackend) BrokerBackend {
        return .{ .context = self, .call_fn = call };
    }

    fn call(context: *anyopaque, allocator: std.mem.Allocator, type_code: u16, payload: []const u8) BackendResult {
        _ = allocator;
        _ = type_code;
        _ = payload;
        const self: *TestBackend = @ptrCast(@alignCast(context));
        self.calls += 1;
        return .no_response;
    }
};

const DaemonWireHarness = struct {
    runtime: *Runtime,
    stream: std.net.Stream,
    observed: *const ObservedPeer,
    timer: *std.time.Timer,
    failed: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn run(self: *DaemonWireHarness) void {
        defer self.stream.close();
        var backend: StartupBackend = .{};
        serveDaemonConnection(
            std.heap.page_allocator,
            self.runtime,
            self.stream,
            self.observed,
            "test-build",
            self.timer,
            backend.backend(),
        ) catch self.failed.store(true, .release);
    }
};

test "daemon UDS returns a correlated typed header failure before closing" {
    var sockets: [2]c_int = undefined;
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    var client: std.net.Stream = .{ .handle = sockets[0] };
    defer client.close();
    var runtime: Runtime = undefined;
    var observed: ObservedPeer = undefined;
    var timer = try std.time.Timer.start();
    var harness: DaemonWireHarness = .{
        .runtime = &runtime,
        .stream = .{ .handle = sockets[1] },
        .observed = &observed,
        .timer = &timer,
    };
    const thread = try std.Thread.spawn(.{}, DaemonWireHarness.run, .{&harness});

    var malformed_header = protocol.encodeHeader(.{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = 0,
        .request_id = 73,
        .stream_seq = 0,
    }).?;
    malformed_header[4] = generated.protocol_major + 1;
    try client.writeAll(&malformed_header);
    const file: std.fs.File = .{ .handle = client.handle };
    const response = try protocol.readFrame(std.testing.allocator, file.deprecatedReader());
    defer response.frame.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.@"error", response.frame.header.type_code);
    try std.testing.expectEqual(@as(u64, 73), response.frame.header.request_id);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        response.frame.payload,
    ));
    const ErrorPayload = struct { code: []const u8 };
    var error_payload = try std.json.parseFromSlice(ErrorPayload, std.testing.allocator, response.frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer error_payload.deinit();
    var code_storage: [64]u8 = undefined;
    const tag = @tagName(protocol.WireError.protocol_mismatch);
    const expected_code = std.ascii.upperString(code_storage[0..tag.len], tag);
    try std.testing.expectEqualStrings(expected_code, error_payload.value.code);
    thread.join();
    try std.testing.expect(!harness.failed.load(.acquire));
}

test "broker dispatcher validates projections and handles PING without lifecycle authority" {
    var backend: TestBackend = .{};
    const header: protocol.Header = .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.list,
        .flags = 0,
        .payload_length = 19,
        .request_id = 7,
        .stream_seq = 0,
    };
    const malformed_list = "{\"schemaVersion\":1}";
    const malformed = dispatchFrame(std.testing.allocator, .{
        .header = header,
        .payload = @constCast(malformed_list),
    }, 99, backend.backend());
    try std.testing.expectEqual(protocol.WireError.malformed_frame, malformed.failure.code);
    try std.testing.expectEqual(@as(usize, 0), backend.calls);

    const ping_payload = "{\"schemaVersion\":1,\"monoNanos\":\"12\"}";
    var ping_header = header;
    ping_header.type_code = generated.frame_type.ping;
    ping_header.payload_length = ping_payload.len;
    const ping = dispatchFrame(std.testing.allocator, .{
        .header = ping_header,
        .payload = @constCast(ping_payload),
    }, 99, backend.backend());
    defer ping.response.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.pong, ping.response.header.type_code);
    try std.testing.expectEqual(@as(?u64, 99), protocol.decodePingPong(std.testing.allocator, ping.response.payload));
    try std.testing.expectEqual(@as(usize, 0), backend.calls);
}

test "PONG must correlate to the outstanding broker PING" {
    const payload = "{\"schemaVersion\":1,\"monoNanos\":\"12\"}";
    var frame: protocol.Frame = .{
        .header = .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.pong,
            .flags = generated.frame_flag.response | generated.frame_flag.final,
            .payload_length = payload.len,
            .request_id = 9,
            .stream_seq = 0,
        },
        .payload = @constCast(payload),
    };
    try std.testing.expect(validPong(std.testing.allocator, frame, 9));
    try std.testing.expect(!validPong(std.testing.allocator, frame, null));
    try std.testing.expect(!validPong(std.testing.allocator, frame, 10));
    frame.header.flags = 0;
    try std.testing.expect(!validPong(std.testing.allocator, frame, 9));
}

test "shipped pre-host backend refuses CREATE with a typed result" {
    const payload =
        \\{"schemaVersion":1,"totalLength":12,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
    ;
    var backend: StartupBackend = .{};
    const result = dispatchFrame(std.testing.allocator, .{
        .header = .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.create_commit,
            .flags = 0,
            .payload_length = payload.len,
            .request_id = 17,
            .stream_seq = 0,
        },
        .payload = @constCast(payload),
    }, 1, backend.backend());
    try std.testing.expectEqual(protocol.WireError.not_ready, result.failure.code);
    try std.testing.expect(!result.failure.close_connection);
}

test "broker dispatcher maps every defined lifecycle request to its strict schema" {
    try std.testing.expectEqualStrings(generated.wire_schema.create_begin_payload, requestSchema(generated.frame_type.create_begin).?);
    try std.testing.expectEqualStrings(generated.wire_schema.create_commit_payload, requestSchema(generated.frame_type.create_commit).?);
    try std.testing.expectEqualStrings(generated.wire_schema.list_payload, requestSchema(generated.frame_type.list).?);
    try std.testing.expectEqualStrings(generated.wire_schema.inspect_payload, requestSchema(generated.frame_type.inspect).?);
    try std.testing.expectEqualStrings(generated.wire_schema.terminate_payload, requestSchema(generated.frame_type.terminate).?);
    try std.testing.expectEqualStrings(generated.wire_schema.visibility_renew_payload, requestSchema(generated.frame_type.visibility_renew).?);
    try std.testing.expectEqualStrings(generated.wire_schema.attach_request_payload, requestSchema(generated.frame_type.attach_request).?);
}

test "socket substitution fails closed" {
    const expected: SocketEvidence = .{ .device = 1, .inode = 2, .owner_uid = std.posix.getuid(), .mode = 0o600 };
    var substituted = expected;
    substituted.inode = 3;
    try std.testing.expectEqual(protocol.WireError.unauthenticated, verifySocket(expected, substituted).?.code);
}

test "post-connect socket guard rejects a substituted filesystem socket" {
    var root_storage: [48]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/hs{x}", .{std.crypto.random.int(u32)});
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var directory = try std.fs.openDirAbsolute(root, .{});
    defer directory.close();
    const socket_path = try std.fs.path.join(std.testing.allocator, &.{ root, "host.sock" });
    defer std.testing.allocator.free(socket_path);
    const socket_path_z = try std.testing.allocator.dupeZ(u8, socket_path);
    defer std.testing.allocator.free(socket_path_z);
    const address = try std.net.Address.initUnix(socket_path);

    var original = try address.listen(.{});
    defer original.deinit();
    if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;
    const before = try socketEvidenceAt(directory, "host.sock");

    try directory.deleteFile("host.sock");
    var replacement = try address.listen(.{});
    defer replacement.deinit();
    if (c.chmod(socket_path_z.ptr, 0o600) != 0) return error.SocketModeFailed;
    const after = try socketEvidenceAt(directory, "host.sock");

    try std.testing.expect(!std.meta.eql(before, after));
    try std.testing.expectEqual(
        protocol.WireError.unauthenticated,
        verifyPostConnectSocket(before, before, after).?.code,
    );
}
