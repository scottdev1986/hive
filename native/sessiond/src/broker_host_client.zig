const std = @import("std");
const broker_record = @import("broker_record");
const broker_transport = @import("broker_transport");
const daemon_identity = @import("daemon_identity");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const neutral_control_plane = @import("neutral_control_plane");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const wall_clock = @import("wall_clock");

const c = @cImport({
    @cInclude("libproc.h");
    @cInclude("unistd.h");
});

const Locator = broker_record.Locator;
const ProcessRoot = broker_record.ProcessRoot;
const Geometry = broker_record.Geometry;
const Visibility = broker_record.Visibility;
const HostRecord = broker_record.HostRecord;
const DiskLocator = broker_record.DiskLocator;
const DiskProtocol = broker_record.DiskProtocol;
const DiskProcessRoot = broker_record.DiskProcessRoot;
const DiskVisibility = broker_record.DiskVisibility;
const SocketEvidence = broker_record.SocketEvidence;
const socketEvidence = broker_record.socketEvidence;
const verifySocket = broker_record.verifySocket;
const verifyPostConnectSocket = broker_record.verifyPostConnectSocket;
const locatorFromDisk = broker_record.locatorFromDisk;
const setTransportReadTimeout = broker_transport.setTransportReadTimeout;
const ObservedPeer = daemon_identity.ObservedPeer;
const HostProcessOwnership = daemon_identity.HostProcessOwnership;
const inspectPeer = daemon_identity.inspectPeer;
const formatStartToken = daemon_identity.formatStartToken;
const waitForExactProcessAbsence = daemon_identity.waitForExactProcessAbsence;
const equalOptionalString = daemon_identity.equalOptionalString;

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

pub const HostRenewalResult = union(enum) {
    response: []u8,
    failure: protocol.Failure,
};

pub const HostGrantResult = union(enum) {
    registered,
    failure: protocol.Failure,
};

pub const HostControl = struct {
    context: *anyopaque,
    adopt_fn: *const fn (*anyopaque, Locator, [32]u8, u64) ?AdoptionReadback,
    register_grant_fn: *const fn (*anyopaque, Locator, GrantRegistration) HostGrantResult,
    renew_visibility_fn: *const fn (*anyopaque, Locator, []const u8) HostRenewalResult,
    discard_orphan_fn: *const fn (*anyopaque, Locator, []const u8) HostRenewalResult,
    terminate_fn: *const fn (*anyopaque, Locator, TerminationCommand, HostProcessOwnership) TerminationReadback,

    pub fn adopt(self: HostControl, locator: Locator, secret: [32]u8, now_ns: u64) ?AdoptionReadback {
        return self.adopt_fn(self.context, locator, secret, now_ns);
    }

    pub fn registerGrant(self: HostControl, locator: Locator, grant: GrantRegistration) HostGrantResult {
        return self.register_grant_fn(self.context, locator, grant);
    }

    pub fn renewVisibility(
        self: HostControl,
        locator: Locator,
        payload: []const u8,
    ) HostRenewalResult {
        return self.renew_visibility_fn(self.context, locator, payload);
    }

    /// §22 host-authorized human-claim resolution. The typed response makes an
    /// orphan discard, held-claim preemption, and refusal distinct on the wire.
    pub fn discardOrphan(
        self: HostControl,
        locator: Locator,
        payload: []const u8,
    ) HostRenewalResult {
        return self.discard_orphan_fn(self.context, locator, payload);
    }

    pub fn terminate(self: HostControl, locator: Locator, command: TerminationCommand) TerminationReadback {
        return self.terminateWithOwnership(locator, command, .non_parent);
    }

    pub fn terminateWithOwnership(
        self: HostControl,
        locator: Locator,
        command: TerminationCommand,
        ownership: HostProcessOwnership,
    ) TerminationReadback {
        return self.terminate_fn(self.context, locator, command, ownership);
    }
};

pub const WireWelcome = struct {
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
    state: []const u8,
    exit: ?std.json.Value = null,
    reap: struct {
        authority: []const u8,
        reaped: bool,
        status: ?std.json.Value = null,
        completeness: []const u8,
    },
    survivors: []const std.json.Value,
    completeness: []const u8,
    diagnostics: []const []const u8 = &.{},
};

pub fn locatorJsonValue(allocator: std.mem.Allocator, locator: Locator) !std.json.Value {
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
    // locatorFromDisk accepts any u64 generation, but the wire integer is
    // i64: an out-of-range generation must fail closed instead of panicking
    // (safe builds) or invoking UB (ReleaseFast) on @intCast.
    try value.put("generation", .{ .integer = std.math.cast(i64, locator.generation) orelse
        return error.InvalidLocator });
    try value.put("sessionId", .{ .string = locator.session_id });
    try value.put("hostKind", .{ .string = @tagName(locator.host_kind) });
    try value.put("engineBuildId", if (locator.engine_build_id) |build|
        .{ .string = build }
    else
        .null);
    return .{ .object = value };
}

pub const wallDeadline = wall_clock.deadline;

/// Production broker-side implementation of the WP4 seam. Every operation
/// reconnects and authenticates the exact recorded host before speaking v1 on
/// host.sock; the test double exercises this code over a real UDS.
fn copyNeutralSessionRef(
    allocator: std.mem.Allocator,
    session: neutral_host.SessionRef,
) !neutral_host.SessionRef {
    const key = try allocator.dupe(u8, session.key);
    errdefer allocator.free(key);
    return .{
        .key = key,
        .incarnation = try allocator.dupe(u8, session.incarnation),
    };
}

pub const WireHostClient = struct {
    allocator: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    directory: std.fs.Dir,
    socket_path: []u8,
    expected_socket: SocketEvidence,
    expected_record: HostRecord,
    broker_build_id: []u8,
    neutral_home: ?[]u8 = null,

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
        if (self.neutral_home) |home| self.allocator.free(home);
        self.arena.deinit();
    }

    pub fn enableNeutralControl(self: *WireHostClient, hive_home: []const u8) !void {
        if (self.neutral_home != null) return error.NeutralControlAlreadyEnabled;
        self.neutral_home = try self.allocator.dupe(u8, hive_home);
    }

    pub fn control(self: *WireHostClient) HostControl {
        return .{
            .context = self,
            .adopt_fn = adoptCallback,
            .register_grant_fn = registerGrantCallback,
            .renew_visibility_fn = renewVisibilityCallback,
            .discard_orphan_fn = discardOrphanCallback,
            .terminate_fn = terminateCallback,
        };
    }

    pub fn verifyPeer(self: *WireHostClient, peer: *const ObservedPeer) !void {
        var executable_storage: [c.PROC_PIDPATHINFO_MAXSIZE]u8 = undefined;
        const expected_executable = try std.fs.selfExePath(&executable_storage);
        if (peer.uid != std.posix.getuid() or peer.gid != @as(u32, @intCast(c.getgid())) or
            peer.pid != self.expected_record.host_pid or
            !std.mem.eql(u8, peer.executablePath(), expected_executable))
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
        if (!locator.eql(self.expected_record.locator)) return error.InvalidHostRequest;
        var payload_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer payload_arena.deinit();
        var secret_hex = std.fmt.bytesToHex(secret, .lower);
        defer std.crypto.secureZero(u8, &secret_hex);
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
                .expires_mono_ns = try wall_clock.expiryToMonotonic(
                    parsed.value.visibility.expiresAt,
                    now_ns,
                    generated.limits.visibility_expiry_ms,
                ),
            },
        };
    }

    fn registerGrant(self: *WireHostClient, locator: Locator, grant: GrantRegistration) !bool {
        if (!locator.eql(self.expected_record.locator) or
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

    fn renewalFailure(self: *WireHostClient, payload: []const u8) !protocol.Failure {
        const ErrorPayload = struct {
            schemaVersion: u8,
            code: []const u8,
            message: []const u8,
            diagnosticId: ?[]const u8,
        };
        if (!protocol.validateControlPayload(
            self.allocator,
            generated.wire_schema.error_payload,
            payload,
        )) return error.InvalidHostResponsePayload;
        var parsed = try std.json.parseFromSlice(ErrorPayload, self.allocator, payload, .{});
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1 or parsed.value.code.len > 64)
            return error.InvalidHostResponsePayload;
        var lower_storage: [64]u8 = undefined;
        const lower = std.ascii.lowerString(
            lower_storage[0..parsed.value.code.len],
            parsed.value.code,
        );
        return .{
            .code = std.meta.stringToEnum(protocol.WireError, lower) orelse
                return error.InvalidHostResponsePayload,
            .close_connection = false,
        };
    }

    fn hostTransportFailure(err: anyerror) protocol.Failure {
        return .{
            .code = switch (err) {
                error.ConnectionRefused, error.FileNotFound => .generation_gone,
                else => .verification_unknown,
            },
            .close_connection = false,
        };
    }

    fn renewVisibility(
        self: *WireHostClient,
        locator: Locator,
        payload: []const u8,
    ) !HostRenewalResult {
        if (!locator.eql(self.expected_record.locator) or
            !protocol.validateControlPayload(
                self.allocator,
                generated.wire_schema.visibility_renew_payload,
                payload,
            )) return error.InvalidHostRequest;
        const stream = try self.connect();
        defer stream.close();
        try protocol.writeFrame(stream, .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.visibility_renew,
            .flags = 0,
            .payload_length = @intCast(payload.len),
            .request_id = 2,
            .stream_seq = 0,
        }, payload);
        const file: std.fs.File = .{ .handle = stream.handle };
        const read = try protocol.readFrame(self.allocator, file.deprecatedReader());
        const frame = switch (read) {
            .frame => |frame| frame,
            else => return error.InvalidHostResponse,
        };
        if (frame.header.request_id != 2 or
            frame.header.flags & (generated.frame_flag.response | generated.frame_flag.final) !=
                (generated.frame_flag.response | generated.frame_flag.final))
        {
            frame.deinit(self.allocator);
            return error.InvalidHostResponseCorrelation;
        }
        if (frame.header.type_code == generated.frame_type.@"error") {
            defer frame.deinit(self.allocator);
            return .{ .failure = try self.renewalFailure(frame.payload) };
        }
        if (frame.header.type_code != generated.frame_type.renewed or
            !protocol.validateControlPayload(
                self.allocator,
                generated.wire_schema.renewed_payload,
                frame.payload,
            ))
        {
            frame.deinit(self.allocator);
            return error.InvalidHostResponsePayload;
        }
        return .{ .response = frame.payload };
    }

    fn discardOrphan(
        self: *WireHostClient,
        locator: Locator,
        payload: []const u8,
    ) !HostRenewalResult {
        if (!locator.eql(self.expected_record.locator) or
            !protocol.validateControlPayload(
                self.allocator,
                generated.wire_schema.orphan_discard_payload,
                payload,
            )) return error.InvalidHostRequest;
        const stream = try self.connect();
        defer stream.close();
        try protocol.writeFrame(stream, .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.input_orphan_discard,
            .flags = 0,
            .payload_length = @intCast(payload.len),
            .request_id = 4,
            .stream_seq = 0,
        }, payload);
        const file: std.fs.File = .{ .handle = stream.handle };
        const read = try protocol.readFrame(self.allocator, file.deprecatedReader());
        const frame = switch (read) {
            .frame => |frame| frame,
            else => return error.InvalidHostResponse,
        };
        if (frame.header.request_id != 4 or
            frame.header.flags & (generated.frame_flag.response | generated.frame_flag.final) !=
                (generated.frame_flag.response | generated.frame_flag.final))
        {
            frame.deinit(self.allocator);
            return error.InvalidHostResponseCorrelation;
        }
        if (frame.header.type_code == generated.frame_type.@"error") {
            defer frame.deinit(self.allocator);
            return .{ .failure = try self.renewalFailure(frame.payload) };
        }
        if (frame.header.type_code != generated.frame_type.orphan_discarded or
            !protocol.validateControlPayload(
                self.allocator,
                generated.wire_schema.orphan_discarded_payload,
                frame.payload,
            ))
        {
            frame.deinit(self.allocator);
            return error.InvalidHostResponsePayload;
        }
        return .{ .response = frame.payload };
    }

    fn terminate(
        self: *WireHostClient,
        locator: Locator,
        command: TerminationCommand,
        ownership: HostProcessOwnership,
    ) !TerminationReadback {
        if (!locator.eql(self.expected_record.locator)) return error.InvalidHostRequest;
        const hive_home = self.neutral_home orelse return error.NeutralControlUnavailable;
        var runtime = try neutral_host.Runtime.open(self.allocator, hive_home);
        defer runtime.deinit();
        var registry = try neutral_host.Registry.open(self.allocator, &runtime);
        defer registry.deinit();
        try registry.recover();

        const session = blk: {
            for (registry.list()) |record| {
                const child = record.child orelse continue;
                if (!std.mem.eql(u8, record.session.key, locator.session_id) or
                    child.processId != self.expected_record.process_root.pid or
                    !std.mem.eql(u8, child.startToken, self.expected_record.process_root.start_token))
                    continue;
                break :blk try copyNeutralSessionRef(self.allocator, record.session);
            }
            return error.NeutralSessionNotFound;
        };
        defer self.allocator.free(session.incarnation);
        defer self.allocator.free(session.key);

        var payload_arena = std.heap.ArenaAllocator.init(self.allocator);
        defer payload_arena.deinit();
        const a = payload_arena.allocator();
        var deadline_storage: [24]u8 = undefined;
        const payload = try std.json.Stringify.valueAlloc(a, .{
            .schemaVersion = @as(u8, 1),
            .session = session,
            .mode = command.mode,
            .target = "process-tree",
            .deadline = try wallDeadline(
                &deadline_storage,
                generated.limits.control_rpc_timeout_ms,
            ),
            .idempotencyKey = command.request_id,
        }, .{});
        var platform = process_inspector.RealPlatform.init();
        var controller: neutral_control_plane.Controller = .{
            .allocator = self.allocator,
            .registry = &registry,
            .platform = platform.platform(),
            .clock = neutral_control_plane.EvidenceClock.system(),
        };
        const response = try controller.terminate(payload);
        defer self.allocator.free(response);
        var parsed = try std.json.parseFromSlice(WireTerminationReadback, self.allocator, response, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 1) return error.InvalidHostResponse;
        if (std.mem.eql(u8, parsed.value.state, "terminated") and
            parsed.value.survivors.len == 0 and
            parsed.value.reap.reaped and
            std.mem.eql(u8, parsed.value.reap.completeness, "complete") and
            std.mem.eql(u8, parsed.value.completeness, "complete"))
        {
            const host_exited = waitForExactProcessAbsence(
                self.expected_record.host_pid,
                self.expected_record.host_start_token,
                ownership,
            );
            return .{
                .pty_closed = true,
                .host_exited = host_exited,
                .verification_complete = host_exited,
                .survivor_count = 0,
            };
        }
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
    ) HostGrantResult {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        const registered = self.registerGrant(locator, grant) catch |err|
            return .{ .failure = hostTransportFailure(err) };
        return if (registered) .registered else .{ .failure = .{
            .code = .verification_unknown,
            .close_connection = false,
        } };
    }

    fn renewVisibilityCallback(
        context: *anyopaque,
        locator: Locator,
        payload: []const u8,
    ) HostRenewalResult {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.renewVisibility(locator, payload) catch |err|
            .{ .failure = hostTransportFailure(err) };
    }

    fn discardOrphanCallback(
        context: *anyopaque,
        locator: Locator,
        payload: []const u8,
    ) HostRenewalResult {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.discardOrphan(locator, payload) catch |err|
            .{ .failure = hostTransportFailure(err) };
    }

    fn terminateCallback(
        context: *anyopaque,
        locator: Locator,
        command: TerminationCommand,
        ownership: HostProcessOwnership,
    ) TerminationReadback {
        const self: *WireHostClient = @ptrCast(@alignCast(context));
        return self.terminate(locator, command, ownership) catch .{
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
        client.enableNeutralControl(self.canonical_home) catch {
            client.deinit();
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
