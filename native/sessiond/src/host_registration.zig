const std = @import("std");
const boot_envelope = @import("boot_envelope");
const broker = @import("broker");
const executable_identity = @import("executable_identity");
const generated = @import("session_protocol_generated");
const host_record = @import("host_record");
const protocol = @import("protocol");
const wall_clock = @import("wall_clock");

const BootMessage = boot_envelope.Message;
const readBootMessage = boot_envelope.read;
const writeBootMessage = boot_envelope.write;
const HostRegistration = host_record.HostRegistration;
const WireLocator = host_record.WireLocator;
const WireHostRegisterRequest = host_record.WireHostRegisterRequest;
const encodeHostRegister = host_record.encodeHostRegister;
const encodeRecordJson = host_record.encodeRecordJson;
const encodeCreatedPayload = host_record.encodeCreatedPayload;

pub const WireHello = struct {
    schemaVersion: u8,
    buildId: []const u8,
    instanceId: []const u8,
    protocol: struct { major: u8, minMinor: u8, maxMinor: u8 },
    clientRole: []const u8,
    grantToken: ?[]const u8 = null,
};

const WireWelcome = struct {
    schemaVersion: u8,
    protocol: struct { major: u8, minor: u8 },
    instanceId: []const u8,
    endpointRole: []const u8,
    buildId: []const u8,
    engineBuildId: ?[]const u8,
};

const host_wire = @import("host_wire");
const readRequiredFrame = host_wire.readRequiredFrame;
const writeHostFailure = host_wire.writeFailure;

pub fn writeHostWelcome(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    registration: HostRegistration,
    build_id: []const u8,
    server_epoch: u64,
) !void {
    var connection_storage: [32]u8 = undefined;
    var epoch_storage: [32]u8 = undefined;
    const connection = try std.fmt.bufPrint(&connection_storage, "{d}", .{
        std.crypto.random.int(u64),
    });
    const epoch = try std.fmt.bufPrint(&epoch_storage, "{d}", .{server_epoch});
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .protocol = .{ .major = generated.protocol_major, .minor = generated.protocol_minor },
        .instanceId = registration.record.locator.instance_id,
        .endpointRole = "host",
        .buildId = build_id,
        .engineBuildId = registration.record.engine_build_id,
        .connectionId = connection,
        .serverEpoch = epoch,
        .limits = .{
            .controlFrameMaxBytes = generated.limits.control_json_bytes,
            .maxInputTransactionBytes = generated.limits.input_transaction_bytes,
            .streamChunkMaxBytes = generated.limits.stream_chunk_bytes,
            .automatedMessageMaxBytes = generated.limits.automated_message_bytes,
            .viewerQueueMaxBytes = generated.limits.viewer_queue_bytes,
        },
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.welcome_payload,
        payload,
    )) return error.InvalidWelcome;
    try protocol.writeFrame(
        stream,
        request.response(generated.frame_type.welcome, payload.len),
        payload,
    );
}

/// Host side of the inherited-fd milestone: boot bytes first, then a generated
/// HELLO/WELCOME and HOST_REGISTER/accepted exchange.
pub fn serveInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
    host_build_id: []const u8,
    server_epoch: u64,
) !BootMessage {
    const file: std.fs.File = .{ .handle = stream.handle };
    var boot = try readBootMessage(allocator, file.deprecatedReader());
    errdefer boot.deinit(allocator);
    const broker_build_id = try serveRegistrationAfterBoot(
        allocator,
        stream,
        registration,
        host_build_id,
        server_epoch,
    );
    allocator.free(broker_build_id);
    return boot;
}

/// Completes registration after the host role has consumed the private boot
/// envelope and created the PTY/socket evidence named by HOST_REGISTER.
pub fn serveRegistrationAfterBoot(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
    host_build_id: []const u8,
    server_epoch: u64,
) ![]u8 {
    var hello_frame = try readRequiredFrame(allocator, stream);
    defer hello_frame.deinit(allocator);
    if (hello_frame.header.type_code != generated.frame_type.hello or
        hello_frame.header.flags != 0 or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.hello_payload,
            hello_frame.payload,
        )) return error.InvalidHostHello;
    var hello = try std.json.parseFromSlice(WireHello, allocator, hello_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer hello.deinit();
    if (hello.value.schemaVersion != 1 or
        hello.value.protocol.major != generated.protocol_major or
        hello.value.protocol.minMinor > generated.protocol_minor or
        hello.value.protocol.maxMinor < generated.protocol_minor or
        !std.mem.eql(u8, hello.value.clientRole, "broker") or
        !std.mem.eql(u8, hello.value.instanceId, registration.record.locator.instance_id))
        return error.InvalidHostHello;
    try writeHostWelcome(
        allocator,
        stream,
        hello_frame.header,
        registration,
        host_build_id,
        server_epoch,
    );

    const register = try encodeHostRegister(allocator, registration);
    defer allocator.free(register);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.host_register,
        .flags = 0,
        .payload_length = @intCast(register.len),
        .request_id = 2,
        .stream_seq = 0,
    }, register);
    var accepted_frame = try readRequiredFrame(allocator, stream);
    defer accepted_frame.deinit(allocator);
    if (accepted_frame.header.type_code != generated.frame_type.host_register or
        accepted_frame.header.request_id != 2 or
        accepted_frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.host_register_payload,
            accepted_frame.payload,
        )) return error.HostRegistrationRefused;
    const Accepted = struct { schemaVersion: u8, accepted: bool };
    var accepted = try std.json.parseFromSlice(Accepted, allocator, accepted_frame.payload, .{});
    defer accepted.deinit();
    if (accepted.value.schemaVersion != 1 or !accepted.value.accepted)
        return error.HostRegistrationRefused;
    return allocator.dupe(u8, hello.value.buildId);
}

pub const ParsedRegistration = struct {
    arena: std.heap.ArenaAllocator,
    registration: HostRegistration,
    record_json: []u8,
    created_payload: []u8,

    pub fn deinit(self: *ParsedRegistration, allocator: std.mem.Allocator) void {
        allocator.free(self.record_json);
        allocator.free(self.created_payload);
        self.arena.deinit();
        self.* = undefined;
    }
};

pub fn promoteTrustedExecutableEvidence(
    allocator: std.mem.Allocator,
    expected_executable: []const u8,
    argv: []const []const u8,
    parsed: *ParsedRegistration,
) ![]u8 {
    if (!std.mem.eql(
        u8,
        parsed.registration.record.expected_executable,
        expected_executable,
    )) return error.HostIdentityMismatch;
    parsed.registration.executable_verified = argv.len > 0 and
        executable_identity.sameFile(allocator, expected_executable, argv[0]);
    return encodeCreatedPayload(allocator, parsed.registration);
}

pub fn parseLocator(allocator: std.mem.Allocator, wire: WireLocator) !broker.Locator {
    const subject: @FieldType(broker.Locator, "subject") = if (std.mem.eql(u8, wire.subject.kind, "root")) blk: {
        if (wire.subject.agentId != null) return error.InvalidHostRegister;
        break :blk .root;
    } else if (std.mem.eql(u8, wire.subject.kind, "agent"))
        .{ .agent = try allocator.dupe(u8, wire.subject.agentId orelse return error.InvalidHostRegister) }
    else
        return error.InvalidHostRegister;
    return .{
        .instance_id = try allocator.dupe(u8, wire.instanceId),
        .session_id = try allocator.dupe(u8, wire.sessionId),
        .generation = wire.generation,
        .subject = subject,
        .host_kind = std.meta.stringToEnum(@FieldType(broker.Locator, "host_kind"), wire.hostKind) orelse
            return error.InvalidHostRegister,
        .engine_build_id = if (wire.engineBuildId) |engine| try allocator.dupe(u8, engine) else null,
    };
}

pub fn parseRegistration(
    allocator: std.mem.Allocator,
    payload: []const u8,
) !ParsedRegistration {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_register_payload,
        payload,
    )) return error.InvalidHostRegister;
    var parsed = try std.json.parseFromSlice(WireHostRegisterRequest, allocator, payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1) return error.InvalidHostRegister;

    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const wire = parsed.value.record;
    // HostLaunchReadback uses this field as a validated remaining duration.
    // The broker replaces it with its own absolute monotonic deadline only
    // after Registry admission.
    const lease_remaining_ns = try validatedLeaseRemaining(wire.visibility.expiresAt);
    var registration: HostRegistration = .{
        .record = .{
            .locator = try parseLocator(a, wire.locator),
            .host_pid = wire.hostPid,
            .host_start_token = try a.dupe(u8, wire.hostStartToken),
            .process_root = .{
                .pid = wire.processRoot.pid,
                .start_token = try a.dupe(u8, wire.processRoot.startToken),
                .process_group_id = wire.processRoot.processGroupId,
            },
            .expected_executable = try a.dupe(u8, wire.expectedExecutable),
            .executable_build_hash = try a.dupe(u8, wire.executableBuildHash),
            .engine_build_id = try a.dupe(u8, wire.engineBuildId),
            .protocol_major = wire.protocol.major,
            .protocol_minor = wire.protocol.minor,
            .geometry = .{
                .columns = @intCast(wire.geometry.columns),
                .rows = @intCast(wire.geometry.rows),
                .width_px = wire.geometry.widthPx,
                .height_px = wire.geometry.heightPx,
                .cell_width_px = wire.geometry.cellWidthPx,
                .cell_height_px = wire.geometry.cellHeightPx,
            },
            .state = std.meta.stringToEnum(@FieldType(broker.HostRecord, "state"), wire.state) orelse
                return error.InvalidHostRegister,
            .visibility = .{
                .state = std.meta.stringToEnum(@FieldType(broker.Visibility, "state"), wire.visibility.state) orelse
                    return error.InvalidHostRegister,
                .workspace_session_id = try a.dupe(u8, wire.visibility.workspaceSessionId),
                .open_terminal_revision = try std.fmt.parseInt(
                    u64,
                    wire.visibility.openTerminalRevision,
                    10,
                ),
                .expires_mono_ns = lease_remaining_ns,
            },
            .output_seq = try std.fmt.parseInt(u64, wire.outputSeq, 10),
            .checkpoint_seq = try std.fmt.parseInt(u64, wire.checkpointSeq, 10),
        },
        .expires_at = try a.dupe(u8, wire.visibility.expiresAt),
        .created_at = try a.dupe(u8, wire.visibility.expiresAt),
        .checkpoint_available = false,
        .executable_verified = false,
        .complete = false,
    };
    var created_storage: [32]u8 = undefined;
    const created_at = try broker.wallDeadline(&created_storage, 0);
    registration.created_at = try a.dupe(u8, created_at);
    const record_json = try encodeRecordJson(allocator, registration);
    errdefer allocator.free(record_json);
    const created_payload = try encodeCreatedPayload(allocator, registration);
    return .{
        .arena = arena,
        .registration = registration,
        .record_json = record_json,
        .created_payload = created_payload,
    };
}

/// Launcher-side registration exchange. The host independently enforces its
/// own 15-second monotonic deadline.
pub const PendingRegistrationReadback = struct {
    parsed: ParsedRegistration,
    request_header: protocol.Header,
};

pub fn beginInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
    broker_build_id: []const u8,
    instance_id: []const u8,
) !PendingRegistrationReadback {
    try writeBootMessage(stream, spec_json, initial_input, adoption_secret);
    const hello = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = broker_build_id,
        .instanceId = instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "broker",
    }, .{});
    defer allocator.free(hello);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.hello_payload,
        hello,
    )) return error.InvalidBrokerHello;
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);

    var welcome_frame = try readRequiredFrame(allocator, stream);
    defer welcome_frame.deinit(allocator);
    if (welcome_frame.header.type_code != generated.frame_type.welcome or
        welcome_frame.header.request_id != 1 or
        welcome_frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.welcome_payload,
            welcome_frame.payload,
        )) return error.InvalidWelcome;
    var welcome = try std.json.parseFromSlice(WireWelcome, allocator, welcome_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer welcome.deinit();
    if (welcome.value.schemaVersion != 1 or
        welcome.value.protocol.major != generated.protocol_major or
        welcome.value.protocol.minor != generated.protocol_minor or
        !std.mem.eql(u8, welcome.value.instanceId, instance_id) or
        !std.mem.eql(u8, welcome.value.endpointRole, "host"))
        return error.InvalidWelcome;

    var register_frame = try readRequiredFrame(allocator, stream);
    defer register_frame.deinit(allocator);
    if (register_frame.header.type_code != generated.frame_type.host_register or
        register_frame.header.flags != 0)
        return error.InvalidHostRegister;
    var result = try parseRegistration(allocator, register_frame.payload);
    errdefer result.deinit(allocator);
    if (!std.mem.eql(u8, result.registration.record.locator.instance_id, instance_id) or
        !std.mem.eql(u8, result.registration.record.executable_build_hash, welcome.value.buildId) or
        welcome.value.engineBuildId == null or
        !std.mem.eql(u8, result.registration.record.engine_build_id, welcome.value.engineBuildId.?))
        return error.InvalidHostRegister;

    return .{
        .parsed = result,
        .request_header = register_frame.header,
    };
}

pub fn acceptPendingRegistration(
    stream: std.net.Stream,
    request_header: protocol.Header,
) !void {
    const accepted = "{\"schemaVersion\":1,\"accepted\":true}";
    try protocol.writeFrame(
        stream,
        request_header.response(generated.frame_type.host_register, accepted.len),
        accepted,
    );
}

/// Compatibility helper for unit seams that admit immediately. The production
/// launcher retains the pending readback until broker Registry admission.
pub fn completeInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
    broker_build_id: []const u8,
    instance_id: []const u8,
) !ParsedRegistration {
    var pending = try beginInheritedRegistration(
        allocator,
        stream,
        spec_json,
        initial_input,
        adoption_secret,
        broker_build_id,
        instance_id,
    );
    errdefer pending.parsed.deinit(allocator);
    try acceptPendingRegistration(stream, pending.request_header);
    return pending.parsed;
}

pub fn validatedLeaseRemaining(expires_at: []const u8) !u64 {
    return wall_clock.expiryToMonotonic(
        expires_at,
        0,
        generated.limits.visibility_expiry_ms,
    );
}
